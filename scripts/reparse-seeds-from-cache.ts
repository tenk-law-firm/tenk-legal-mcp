#!/usr/bin/env tsx
/**
 * Seed-tartalom újra-parse-olása a lokális forrás-cache-ből — hálózat nélkül
 * (kivéve a deferred blokkok hydrate-jét, ha az adott oldalon van ilyen).
 *
 * Használat: a sortörés-őrző parser (htmlToTextLines) utáni tartalom-frissítés
 * úgy, hogy a seed METAADATAI (id, status, title, dátumok) változatlanok
 * maradnak — discovery nem fut, a hatályosság-besorolás nem változik.
 *
 *   npx tsx scripts/reparse-seeds-from-cache.ts --pattern hu-decree-
 *   npx tsx scripts/reparse-seeds-from-cache.ts --pattern hu-law-
 *
 * Garanciák ("soha csendes hiba"):
 *   - hiányzó cache → a seed VÁLTOZATLAN marad, az id a riportba kerül
 *   - provision-szám eltérés az újra-parse után → riport (a seed frissül,
 *     de az eltérés látható)
 *
 * A extractNjtDocumentId/extractDeferredBlockStarts/hydrate logika az
 * ingest.ts-ből származó minimális másolat (az ingest.ts top-level main-t
 * futtat, ezért nem importálható).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postJsonWithRateLimit } from './lib/fetcher.js';
import { parseHungarianHtml, type ActIndexEntry, type ParsedAct } from './lib/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(__dirname, '../data/seed');
const SOURCE_DIR = path.resolve(__dirname, '../data/source');
const BLOCK_ENDPOINT = 'https://njt.jog.gov.hu/ajax/njtGetBlock.json';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const pattern = arg('--pattern') ?? 'hu-decree-';

function extractNjtDocumentId(url: string): string | null {
  const match = url.match(/\/jogszabaly\/([^/?#]+)/);
  return match ? match[1] : null;
}

function extractDeferredBlockStarts(html: string): number[] {
  return [...html.matchAll(/class="pH borderStart"data-show-order="(\d+)"/g)]
    .map(m => Number.parseInt(m[1], 10))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
}

async function hydrate(html: string, documentId: string): Promise<string> {
  const starts = extractDeferredBlockStarts(html);
  if (starts.length === 0) return html;

  const ranges = starts.map((start, i) => ({
    start,
    last: i + 1 < starts.length ? starts[i + 1] : null,
  }));
  const chunkSize = 20;
  let appended = '';
  for (let i = 0; i < ranges.length; i += chunkSize) {
    const chunk = ranges.slice(i, i + chunkSize).map(r =>
      r.last === null ? { start: r.start } : { start: r.start, last: r.last },
    );
    const response = await postJsonWithRateLimit(BLOCK_ENDPOINT, { documentId, data: chunk });
    if (response.status !== 200) {
      throw new Error(`Deferred block fetch failed for ${documentId} (HTTP ${response.status})`);
    }
    appended += `\n${response.body}`;
  }
  return `${html}\n${appended}`;
}

async function main(): Promise<void> {
  const seedFiles = fs.readdirSync(SEED_DIR)
    .filter(f => f.endsWith('.json') && f.startsWith(pattern));
  console.log(`Reparse: ${seedFiles.length} seed (pattern: ${pattern})`);

  let updated = 0;
  let metadataOnly = 0;
  let hydrated = 0;
  const missingCache: string[] = [];
  const countMismatch: string[] = [];
  const failed: string[] = [];

  for (const [idx, file] of seedFiles.entries()) {
    const seedPath = path.join(SEED_DIR, file);
    try {
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8')) as ParsedAct;

      if (!seed.provisions || seed.provisions.length === 0) {
        metadataOnly++;
        continue; // nincs tartalom, nincs mit újratördelni
      }

      const internalId = seed.url ? extractNjtDocumentId(seed.url) : null;
      const cacheFile = internalId ? path.join(SOURCE_DIR, `${internalId}.html`) : null;
      if (!cacheFile || !fs.existsSync(cacheFile)) {
        missingCache.push(seed.id);
        continue;
      }

      let html = fs.readFileSync(cacheFile, 'utf-8');
      const deferred = extractDeferredBlockStarts(html).length;
      if (deferred > 0) {
        html = await hydrate(html, internalId!);
        hydrated++;
      }

      const act: ActIndexEntry = {
        id: seed.id,
        title: seed.title,
        titleEn: seed.title_en,
        shortName: seed.short_name,
        status: seed.status,
        issuedDate: seed.issued_date,
        inForceDate: seed.in_force_date,
        url: seed.url ?? '',
        description: seed.description,
      };
      const parsed = parseHungarianHtml(html, act);

      if (parsed.provisions.length !== seed.provisions.length) {
        countMismatch.push(`${seed.id}: ${seed.provisions.length} → ${parsed.provisions.length}`);
      }

      // Metaadat a RÉGI seedből (státusz/cím nem változhat), tartalom az újból
      const out: ParsedAct = {
        ...seed,
        provisions: parsed.provisions,
        definitions: parsed.definitions,
      };
      fs.writeFileSync(seedPath, `${JSON.stringify(out, null, 2)}\n`);
      updated++;
    } catch (err) {
      // Egyetlen dokumentum hibája nem ölheti meg a teljes futást — a seed
      // változatlan marad, az id a riportba kerül.
      failed.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if ((idx + 1) % 250 === 0) {
      console.log(`  [${idx + 1}/${seedFiles.length}] updated=${updated} hydrated=${hydrated} failed=${failed.length}`);
    }
  }

  console.log('');
  console.log(`KÉSZ: updated=${updated}, metadata-only (kihagyva)=${metadataOnly}, hydrated=${hydrated}`);
  if (missingCache.length > 0) {
    console.log(`HIÁNYZÓ CACHE (${missingCache.length}) — ezek seedje VÁLTOZATLAN:`);
    for (const id of missingCache.slice(0, 20)) console.log(`  - ${id}`);
    if (missingCache.length > 20) console.log(`  … és még ${missingCache.length - 20}`);
  }
  if (countMismatch.length > 0) {
    console.log(`PROVISION-SZÁM ELTÉRÉS (${countMismatch.length}):`);
    for (const m of countMismatch.slice(0, 20)) console.log(`  - ${m}`);
  }
  if (failed.length > 0) {
    console.log(`SIKERTELEN (${failed.length}) — seedjük VÁLTOZATLAN:`);
    for (const f of failed.slice(0, 20)) console.log(`  - ${f}`);
  }
  process.exit(missingCache.length > 0 || failed.length > 0 ? 2 : 0);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
