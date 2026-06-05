#!/usr/bin/env tsx
/**
 * Hungarian Law MCP -- Ingestion Pipeline
 *
 * Fetches Hungarian legislation from the official Nemzeti Jogszabalytar portal
 * (https://njt.hu), parses section-level provisions, and writes seed JSON files.
 *
 * Usage:
 *   npm run ingest                                  # Curated corpus (10 laws)
 *   npm run ingest -- --full                        # Discover and ingest full corpus
 *   npm run ingest -- --full --in-force-only        # Full discovery for in-force laws only
 *   npm run ingest -- --full --discover-only        # Discover all laws metadata only
 *   npm run ingest -- --full --resume               # Skip already-generated seed files
 *   npm run ingest -- --limit 50 --start 101        # Process windowed batch
 *   npm run ingest -- --skip-fetch                  # Reuse locally cached HTML where available
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRateLimit, postJsonWithRateLimit } from './lib/fetcher.js';
import { parseHungarianHtml, KEY_HUNGARIAN_ACTS, type ActIndexEntry, type ParsedAct } from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(__dirname, '../data/source');
const SEED_DIR = path.resolve(__dirname, '../data/seed');
const BLOCK_ENDPOINT = 'https://njt.jog.gov.hu/ajax/njtGetBlock.json';
const SEARCH_URL_ENDPOINT = 'https://njt.jog.gov.hu/ajax/get_search_url.json';

type IngestStatus = 'OK' | 'cached' | 'METADATA_ONLY' | `HTTP ${number}` | 'NO_SECTION_CONTENT' | `ERROR: ${string}`;

interface CliArgs {
  limit: number | null;
  start: number;
  skipFetch: boolean;
  full: boolean;
  inForceOnly: boolean;
  discoverOnly: boolean;
  refreshDiscovery: boolean;
  resume: boolean;
  pageSize: 10 | 20 | 50;
}

interface DiscoverySeed {
  searchPath: string;
  generatedAt: string;
  inForceOnly: boolean;
  pageSize: number;
  totalPages: number;
  totalDiscovered: number;
  laws: DiscoveredLaw[];
}

interface DiscoveredLaw {
  documentId: string;
  title: string;
  titleEn?: string;
  description?: string;
  status: ActIndexEntry['status'];
  issuedDate?: string;
  inForceDate?: string;
  url: string;
}

interface IngestionRow {
  act: string;
  provisions: number;
  definitions: number;
  status: IngestStatus;
}

function toMetadataOnlyAct(act: ActIndexEntry): ParsedAct {
  return {
    id: act.id,
    type: 'statute',
    title: act.title,
    title_en: act.titleEn,
    short_name: act.shortName,
    status: act.status,
    issued_date: act.issuedDate,
    in_force_date: act.inForceDate,
    url: act.url,
    description:
      act.description ??
      'Metadata-only entry: section-level text could not be extracted from public njt.hu HTML for this statute.',
    provisions: [],
    definitions: [],
  };
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  let limit: number | null = null;
  let start = 1;
  let skipFetch = false;
  let full = false;
  let inForceOnly = false;
  let discoverOnly = false;
  let refreshDiscovery = false;
  let resume = false;
  let pageSize: 10 | 20 | 50 = 50;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--limit' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }
      i++;
      continue;
    }

    if (arg === '--start' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        start = parsed;
      }
      i++;
      continue;
    }

    if (arg === '--page-size' && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (parsed === 10 || parsed === 20 || parsed === 50) {
        pageSize = parsed;
      }
      i++;
      continue;
    }

    if (arg === '--skip-fetch') {
      skipFetch = true;
      continue;
    }

    if (arg === '--full') {
      full = true;
      continue;
    }

    if (arg === '--in-force-only') {
      inForceOnly = true;
      continue;
    }

    if (arg === '--discover-only') {
      discoverOnly = true;
      continue;
    }

    if (arg === '--refresh-discovery') {
      refreshDiscovery = true;
      continue;
    }

    if (arg === '--resume') {
      resume = true;
      continue;
    }
  }

  return {
    limit,
    start,
    skipFetch,
    full,
    inForceOnly,
    discoverOnly,
    refreshDiscovery,
    resume,
    pageSize,
  };
}

function decodeHtmlEntities(input: string): string {
  const named = input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&shy;/g, '');

  return named
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function htmlToText(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHungarianDateToIso(text: string | undefined): string | undefined {
  if (!text) return undefined;

  const match = text.match(/(\d{4})\.\s*(\d{2})\.\s*(\d{2})\./);
  if (!match) return undefined;

  return `${match[1]}-${match[2]}-${match[3]}`;
}

function extractNjtDocumentId(url: string): string | null {
  const match = url.match(/\/jogszabaly\/([^/?#]+)/);
  return match ? match[1] : null;
}

function extractDeferredBlockStarts(html: string): number[] {
  return [...html.matchAll(/class=\"pH borderStart\"data-show-order=\"(\d+)\"/g)]
    .map(match => Number.parseInt(match[1], 10))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function extractTotalPages(html: string): number {
  const match = html.match(/id=\"page-count\">\s*\/\s*(\d+)\s*</i);
  if (!match) return 1;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseSearchResultPage(html: string): DiscoveredLaw[] {
  const chunks = html.split('<div class="resultItemWrapper">').slice(1);
  const laws: DiscoveredLaw[] = [];

  for (const chunk of chunks) {
    const mainLinkMatch = chunk.match(
      /(<a[^>]*href="jogszabaly\/([0-9]{4}-[0-9A-Z]+-00-00)"[^>]*>)([\s\S]*?)<\/a>/i
    );
    if (!mainLinkMatch) continue;

    const linkTag = mainLinkMatch[1];
    const documentId = mainLinkMatch[2];
    const shortTitle = htmlToText(mainLinkMatch[3]);
    const linkClasses = (linkTag.match(/class="([^"]*)"/i)?.[1] ?? '').toLowerCase();

    const description = htmlToText(chunk.match(/<p>([\s\S]*?)<\/p>/i)?.[1] ?? '');
    const fullTitle = description.length > 0 ? `${shortTitle} ${description}` : shortTitle;

    const titleEnRaw = chunk.match(/class=\"resultItem translation\"[^>]*title=\"([^\"]+)\"/i)?.[1];
    const titleEn = titleEnRaw ? htmlToText(titleEnRaw) : undefined;

    const dateSpan = htmlToText(chunk.match(/<span class=\"resultDate\"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
    const dateMatches = [...dateSpan.matchAll(/\d{4}\.\s*\d{2}\.\s*\d{2}\./g)].map(m => m[0]);
    const inForceDate = parseHungarianDateToIso(dateMatches[0]);

    let status: ActIndexEntry['status'] = 'amended';
    if (linkClasses.includes('now')) status = 'in_force';
    else if (linkClasses.includes('future')) status = 'not_yet_in_force';
    else if (linkClasses.includes('past')) status = 'repealed';

    laws.push({
      documentId,
      title: fullTitle,
      titleEn,
      description: description.length > 0 ? description : undefined,
      status,
      issuedDate: undefined,
      inForceDate,
      url: `https://njt.hu/jogszabaly/${documentId}`,
    });
  }

  return laws;
}

async function fetchSearchPathForLaws(inForceOnly: boolean): Promise<string> {
  const payload = {
    evszam: '',
    sorszam: '',
    author_type: '0000',
    szokereso: '',
    csak_hatalyos: inForceOnly,
    pontos_szora: false,
    csak_cimben: false,
    targyszo: false,
    gazette_state: false,
  };

  const response = await postJsonWithRateLimit(SEARCH_URL_ENDPOINT, payload);
  if (response.status !== 200) {
    throw new Error(`Search URL request failed (HTTP ${response.status})`);
  }

  let parsed: { success?: boolean; url?: string };
  try {
    parsed = JSON.parse(response.body) as { success?: boolean; url?: string };
  } catch (error) {
    throw new Error(`Search URL response was not JSON: ${String(error)}`);
  }

  if (!parsed.success || !parsed.url) {
    throw new Error('Search URL request did not return a valid path');
  }

  return parsed.url;
}

function discoveryCachePath(inForceOnly: boolean): string {
  const suffix = inForceOnly ? 'in-force' : 'all';
  return path.join(SOURCE_DIR, `law-discovery-${suffix}.json`);
}

function readDiscoveryCache(inForceOnly: boolean, expectedPageSize: number): DiscoveredLaw[] | null {
  const cacheFile = discoveryCachePath(inForceOnly);
  if (!fs.existsSync(cacheFile)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as DiscoverySeed;
    if (!Array.isArray(parsed.laws) || parsed.laws.length === 0) return null;
    if (parsed.inForceOnly !== inForceOnly) return null;
    if (parsed.pageSize !== expectedPageSize) return null;
    return parsed.laws;
  } catch {
    return null;
  }
}

async function discoverLaws(inForceOnly: boolean, pageSize: 10 | 20 | 50): Promise<DiscoveredLaw[]> {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  const searchPath = await fetchSearchPathForLaws(inForceOnly);
  const firstUrl = `https://njt.hu/search/${searchPath}/1/${pageSize}`;

  const firstPageResponse = await fetchWithRateLimit(firstUrl);
  if (firstPageResponse.status !== 200) {
    throw new Error(`Discovery page fetch failed (HTTP ${firstPageResponse.status})`);
  }

  const totalPages = extractTotalPages(firstPageResponse.body);
  const discoveredMap = new Map<string, DiscoveredLaw>();

  for (const law of parseSearchResultPage(firstPageResponse.body)) {
    discoveredMap.set(law.documentId, law);
  }

  for (let page = 2; page <= totalPages; page++) {
    const url = `https://njt.hu/search/${searchPath}/${page}/${pageSize}`;
    const response = await fetchWithRateLimit(url);
    if (response.status !== 200) {
      throw new Error(`Discovery page ${page} failed (HTTP ${response.status})`);
    }

    for (const law of parseSearchResultPage(response.body)) {
      if (!discoveredMap.has(law.documentId)) {
        discoveredMap.set(law.documentId, law);
      }
    }

    if (page % 10 === 0 || page === totalPages) {
      console.log(`  Discovery progress: page ${page}/${totalPages} (${discoveredMap.size} laws)`);
    }
  }

  const laws = Array.from(discoveredMap.values()).sort((a, b) => a.documentId.localeCompare(b.documentId));

  const cache: DiscoverySeed = {
    searchPath,
    generatedAt: new Date().toISOString(),
    inForceOnly,
    pageSize,
    totalPages,
    totalDiscovered: laws.length,
    laws,
  };

  fs.writeFileSync(discoveryCachePath(inForceOnly), `${JSON.stringify(cache, null, 2)}\n`, 'utf-8');
  return laws;
}

function buildFullCorpusActList(discovered: DiscoveredLaw[]): ActIndexEntry[] {
  const subsetOnlyIds = new Set<string>([
    'act-cxii-2011-public-data',
    'criminal-code-cybercrime',
  ]);

  const curatedByDocId = new Map<string, ActIndexEntry[]>();
  for (const act of KEY_HUNGARIAN_ACTS) {
    const docId = extractNjtDocumentId(act.url);
    if (!docId) continue;

    const arr = curatedByDocId.get(docId) ?? [];
    arr.push(act);
    curatedByDocId.set(docId, arr);
  }

  const fullCuratedByDocId = new Map<string, ActIndexEntry>();
  for (const [docId, acts] of curatedByDocId.entries()) {
    const fullAct = acts.find(a => !subsetOnlyIds.has(a.id));
    if (fullAct) fullCuratedByDocId.set(docId, fullAct);
  }

  const result: ActIndexEntry[] = [];

  for (const law of discovered) {
    const curatedFull = fullCuratedByDocId.get(law.documentId);
    if (curatedFull) {
      result.push({
        ...curatedFull,
        url: law.url,
        status: law.status,
        inForceDate: law.inForceDate ?? curatedFull.inForceDate,
      });
      continue;
    }

    result.push({
      id: `hu-law-${law.documentId.toLowerCase()}`,
      title: law.title,
      titleEn: law.titleEn,
      shortName: undefined,
      status: law.status,
      issuedDate: law.issuedDate,
      inForceDate: law.inForceDate,
      url: law.url,
      description: law.description ?? 'Official Hungarian statute text from Nemzeti Jogszabalytar (njt.hu).',
    });
  }

  // Preserve curated subset aliases for compatibility with existing document IDs/tools.
  for (const act of KEY_HUNGARIAN_ACTS.filter(a => subsetOnlyIds.has(a.id))) {
    result.push(act);
  }

  const dedupedById = new Map<string, ActIndexEntry>();
  for (const act of result) {
    if (!dedupedById.has(act.id)) {
      dedupedById.set(act.id, act);
    }
  }

  return Array.from(dedupedById.values());
}

function loadExistingSeedCounts(seedFile: string): { provisions: number; definitions: number } {
  const existing = JSON.parse(fs.readFileSync(seedFile, 'utf-8')) as ParsedAct;
  return {
    provisions: existing.provisions?.length ?? 0,
    definitions: existing.definitions?.length ?? 0,
  };
}

async function hydrateDeferredBlocks(html: string, act: ActIndexEntry, logHydration: boolean): Promise<string> {
  const starts = extractDeferredBlockStarts(html);
  if (starts.length === 0) return html;

  const documentId = extractNjtDocumentId(act.url);
  if (!documentId) return html;

  const blockRanges = starts.map((start, index) => ({
    start,
    last: index + 1 < starts.length ? starts[index + 1] : null,
  }));

  const chunkSize = 20;
  let appended = '';

  for (let i = 0; i < blockRanges.length; i += chunkSize) {
    const chunk = blockRanges.slice(i, i + chunkSize).map(range =>
      range.last === null ? { start: range.start } : { start: range.start, last: range.last }
    );

    const response = await postJsonWithRateLimit(BLOCK_ENDPOINT, {
      documentId,
      data: chunk,
    });

    if (response.status !== 200) {
      throw new Error(`Deferred block fetch failed for ${act.id} (HTTP ${response.status})`);
    }

    appended += `\n${response.body}`;
  }

  if (logHydration && blockRanges.length > 0) {
    console.log(`    -> hydrated ${blockRanges.length} deferred block ranges`);
  }

  return `${html}\n${appended}`;
}

function parseSourceCacheKey(act: ActIndexEntry): string {
  const documentId = extractNjtDocumentId(act.url);
  if (documentId) return documentId;
  return act.id;
}

async function fetchAndParseActs(acts: ActIndexEntry[], skipFetch: boolean, resume: boolean): Promise<void> {
  console.log(`\nProcessing ${acts.length} Hungarian statutes from njt.hu...\n`);

  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });

  let processed = 0;
  let cached = 0;
  let failed = 0;
  let totalProvisions = 0;
  let totalDefinitions = 0;
  let success = 0;

  const results: IngestionRow[] = [];
  const verbosePerAct = acts.length <= 20;

  for (const act of acts) {
    const sourceFile = path.join(SOURCE_DIR, `${parseSourceCacheKey(act)}.html`);
    const seedFile = path.join(SEED_DIR, `${act.id}.json`);

    if (resume && fs.existsSync(seedFile)) {
      const counts = loadExistingSeedCounts(seedFile);
      totalProvisions += counts.provisions;
      totalDefinitions += counts.definitions;
      results.push({ act: act.shortName ?? act.id, provisions: counts.provisions, definitions: counts.definitions, status: 'cached' });
      cached++;
      processed++;
      continue;
    }

    try {
      let html: string;

      if (skipFetch && fs.existsSync(sourceFile)) {
        html = fs.readFileSync(sourceFile, 'utf-8');
        if (verbosePerAct) {
          console.log(`  Using cached HTML for ${act.shortName ?? act.id}`);
        }
      } else {
        if (verbosePerAct) {
          process.stdout.write(`  Fetching ${act.shortName ?? act.id} (${act.url})...`);
        }
        const result = await fetchWithRateLimit(act.url);

        if (result.status !== 200) {
          if (verbosePerAct) {
            console.log(` HTTP ${result.status}`);
          } else {
            console.log(`  [${processed + 1}/${acts.length}] ${act.shortName ?? act.id} -> HTTP ${result.status}`);
          }
          results.push({
            act: act.shortName ?? act.id,
            provisions: 0,
            definitions: 0,
            status: `HTTP ${result.status}`,
          });
          failed++;
          processed++;
          continue;
        }

        html = result.body;
        fs.writeFileSync(sourceFile, html);

        if (!html.includes('jogszabalyMainTitle') || !html.includes('class="jhId"')) {
          const metadataOnly = toMetadataOnlyAct(act);
          fs.writeFileSync(seedFile, `${JSON.stringify(metadataOnly, null, 2)}\n`);

          if (verbosePerAct) {
            console.log(' NO_SECTION_CONTENT -> METADATA_ONLY');
          } else {
            console.log(`  [${processed + 1}/${acts.length}] ${act.shortName ?? act.id} -> METADATA_ONLY (NO_SECTION_CONTENT)`);
          }
          results.push({
            act: act.shortName ?? act.id,
            provisions: 0,
            definitions: 0,
            status: 'METADATA_ONLY',
          });
          processed++;
          continue;
        }

        if (verbosePerAct) {
          console.log(` OK (${(html.length / 1024).toFixed(0)} KB)`);
        }
      }

      const hydratedHtml = await hydrateDeferredBlocks(html, act, verbosePerAct);
      const parsed = parseHungarianHtml(hydratedHtml, act);

      if (parsed.provisions.length === 0) {
        const metadataOnly = toMetadataOnlyAct({
          ...act,
          title: parsed.title,
        });
        fs.writeFileSync(seedFile, `${JSON.stringify(metadataOnly, null, 2)}\n`);

        if (verbosePerAct) {
          console.log('    -> 0 provisions extracted, stored as METADATA_ONLY');
        } else {
          console.log(`  [${processed + 1}/${acts.length}] ${act.shortName ?? act.id} -> METADATA_ONLY (NO_SECTION_CONTENT)`);
        }

        results.push({
          act: act.shortName ?? act.id,
          provisions: 0,
          definitions: 0,
          status: 'METADATA_ONLY',
        });
        processed++;
        continue;
      }

      fs.writeFileSync(seedFile, `${JSON.stringify(parsed, null, 2)}\n`);

      totalProvisions += parsed.provisions.length;
      totalDefinitions += parsed.definitions.length;
      success++;

      results.push({
        act: act.shortName ?? act.id,
        provisions: parsed.provisions.length,
        definitions: parsed.definitions.length,
        status: 'OK',
      });

      const shouldLog = verbosePerAct || (processed + 1) % 25 === 0;
      if (shouldLog) {
        if (verbosePerAct) {
          console.log(`    -> ${parsed.provisions.length} provisions, ${parsed.definitions.length} definitions extracted`);
        } else {
          console.log(
            `  [${processed + 1}/${acts.length}] ok=${success} failed=${failed} cached=${cached} provisions=${totalProvisions} defs=${totalDefinitions}`
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (verbosePerAct) {
        console.log(`  ERROR ${act.shortName ?? act.id}: ${message}`);
      } else {
        console.log(`  [${processed + 1}/${acts.length}] ${act.shortName ?? act.id} -> ERROR: ${message.substring(0, 120)}`);
      }
      results.push({
        act: act.shortName ?? act.id,
        provisions: 0,
        definitions: 0,
        status: `ERROR: ${message.substring(0, 80)}`,
      });
      failed++;
    }

    processed++;
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('Ingestion Report');
  console.log('='.repeat(72));
  console.log('\n  Source:       https://njt.hu');
  console.log('  Authority:    Nemzeti Jogszabalytar / Magyar Kozlony');
  console.log(`  Processed:    ${processed}`);
  console.log(`  Cached:       ${cached}`);
  console.log(`  Failed:       ${failed}`);
  console.log(`  Provisions:   ${totalProvisions}`);
  console.log(`  Definitions:  ${totalDefinitions}`);

  if (results.length <= 20) {
    console.log('\n  Per-Act breakdown:');
    console.log(`  ${'Act'.padEnd(32)} ${'Provisions'.padStart(12)} ${'Definitions'.padStart(13)} ${'Status'.padStart(16)}`);
    console.log(`  ${'-'.repeat(32)} ${'-'.repeat(12)} ${'-'.repeat(13)} ${'-'.repeat(16)}`);

    for (const result of results) {
      console.log(
        `  ${result.act.padEnd(32)} ${String(result.provisions).padStart(12)} ${String(result.definitions).padStart(13)} ${result.status.padStart(16)}`
      );
    }
  } else {
    const metadataOnlyRows = results.filter(r => r.status === 'METADATA_ONLY');
    const errorRows = results.filter(r => r.status !== 'OK' && r.status !== 'cached' && r.status !== 'METADATA_ONLY');
    console.log(`  Window summary: ${success} OK, ${cached} cached, ${metadataOnlyRows.length} metadata-only, ${failed} failed/skipped`);
    if (metadataOnlyRows.length > 0) {
      console.log(`  Metadata-only entries in this window: ${metadataOnlyRows.length}`);
    }
    if (errorRows.length > 0) {
      console.log('  Non-OK entries in this window:');
      for (const row of errorRows.slice(0, 10)) {
        console.log(`    - ${row.act}: ${row.status}`);
      }
      if (errorRows.length > 10) {
        console.log(`    ... and ${errorRows.length - 10} more`);
      }
    }
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('Hungarian Law MCP -- Ingestion Pipeline');
  console.log('======================================\n');
  console.log('  Source: https://njt.hu (official Hungarian legal portal)');
  console.log('  Parse target: section-level text (szakasz, "§")');
  console.log('  Rate limit: 1200ms/request');
  console.log(`  Mode: ${args.full ? 'full corpus discovery' : 'curated corpus'}`);

  if (args.full) {
    console.log(`  In-force only: ${args.inForceOnly ? 'yes' : 'no'}`);
    console.log(`  Discovery page size: ${args.pageSize}`);
  }

  if (args.start > 1) console.log(`  --start ${args.start}`);
  if (args.limit) console.log(`  --limit ${args.limit}`);
  if (args.skipFetch) console.log('  --skip-fetch');
  if (args.resume) console.log('  --resume');
  if (args.discoverOnly) console.log('  --discover-only');
  if (args.refreshDiscovery) console.log('  --refresh-discovery');

  let acts: ActIndexEntry[];

  if (args.full) {
    let discovered = !args.refreshDiscovery
      ? readDiscoveryCache(args.inForceOnly, args.pageSize)
      : null;

    if (!discovered) {
      console.log('\nDiscovering laws from njt.hu search index...');
      discovered = await discoverLaws(args.inForceOnly, args.pageSize);
    } else {
      console.log(`\nLoaded discovery cache (${discovered.length} laws): ${discoveryCachePath(args.inForceOnly)}`);
    }

    acts = buildFullCorpusActList(discovered);

    console.log(`  Discovered laws: ${discovered.length}`);
    console.log(`  Ingestion act list: ${acts.length} (includes compatibility aliases where needed)`);
    console.log(`  Discovery cache: ${discoveryCachePath(args.inForceOnly)}`);
  } else {
    acts = [...KEY_HUNGARIAN_ACTS];
  }

  const startIndex = Math.max(0, args.start - 1);
  const fromStart = acts.slice(startIndex);
  const selectedActs = args.limit ? fromStart.slice(0, args.limit) : fromStart;

  if (args.discoverOnly) {
    console.log(`\nDiscovery-only run completed. Selected acts for ingestion would be: ${selectedActs.length}`);
    return;
  }

  await fetchAndParseActs(selectedActs, args.skipFetch, args.resume);
}

main().catch(error => {
  console.error('Fatal ingestion error:', error);
  process.exit(1);
});
