/**
 * Parser for Hungarian legislation HTML served by https://njt.hu.
 *
 * The parser reads section-level content ("§") from the rendered HTML and
 * produces seed JSON compatible with the database builder.
 */

export interface ActIndexEntry {
  id: string;
  title: string;
  titleEn?: string;
  shortName?: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issuedDate?: string;
  inForceDate?: string;
  url: string;
  description?: string;
}

export interface ParsedProvision {
  provision_ref: string;
  chapter?: string;
  section: string;
  title: string;
  content: string;
}

export interface ParsedDefinition {
  term: string;
  definition: string;
  source_provision?: string;
}

export interface ParsedAct {
  id: string;
  type: 'statute';
  title: string;
  title_en?: string;
  short_name?: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issued_date?: string;
  in_force_date?: string;
  url: string;
  description?: string;
  provisions: ParsedProvision[];
  definitions: ParsedDefinition[];
}

interface SectionAccumulator {
  key: string;
  section?: string;
  chapter?: string;
  firstPos: number;
  blocks: string[];
}

interface NjtBlock {
  blockId: string;
  blockClass: string;
  blockHtml: string;
  blockPos: number;
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

function normalizeExtractedText(input: string): string {
  return input
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

function htmlToText(html: string): string {
  const text = decodeHtmlEntities(
    html
      // A <script>/<style> blokkok TARTALMA nem jogszabályszöveg (njtConfig JS-keret,
      // CSS) — a tag-eltávolítás előtt a teljes blokkot el kell dobni, különben a
      // belső szöveg simán bekerülne a §-tartalomba.
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<sup[^>]*class="fnSup"[^>]*>[\s\S]*?<\/sup>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(?:p|div|li|ul|ol|tr|td|th|table|tbody|thead|tfoot|h[1-6])[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );

  return normalizeExtractedText(text);
}

function parseSectionFromMarker(rawMarker: string): string {
  const markerText = htmlToText(rawMarker);
  return markerText
    .replace(/§/g, '')
    .replace(/\./g, '')
    .replace(/\s+/g, '')
    .trim();
}

function parseSectionFromKey(key: string): string {
  if (key.startsWith('ART_')) return key.slice(4);
  if (key.startsWith('LEGACY_')) return key.slice(7);
  if (key.startsWith('CIKK_')) return key.slice(5);   // 'CIKK_A' → 'A'
  if (key.startsWith('REND_')) return key.slice(5);   // 'REND_1' → '1'
  if (key === 'PREAMB') return 'preamb';              // provision_ref: 'spreamb'

  const match = key.match(/^(\d+)([A-Z]+)?$/);
  if (!match) return key;
  const num = match[1];
  const suffix = match[2] ?? '';
  return suffix ? `${num}/${suffix}` : num;
}

function sectionToKey(section: string): string {
  const match = section.match(/^(\d+)(?:\/([A-Za-z]+))?$/);
  if (match) {
    return `${match[1]}${(match[2] ?? '').toUpperCase()}`;
  }

  return section.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function parseSectionKeyFromBlockId(blockId: string): string | null {
  // §-alapú szakaszok (törvények, rendeletek): SZ1, SZ1A, stb.
  const sectionMatch = blockId.match(/^SZ(\d+)([A-Z]+)?(?:@.*)?$/);
  if (sectionMatch) return `${sectionMatch[1]}${sectionMatch[2] ?? ''}`;

  // Alaptörvény: Nemzeti Hitvallás (preambulum)
  if (blockId === 'PR') return 'PREAMB';

  // Alaptörvény: betűs cikkek — A)–U) cikk — csak a top-level blokk (CBA, CBB, ...), al-blokkok
  // (CBA@BE1 stb.) nem kapnak új kulcsot, az activeSectionKey alá sorolódnak be.
  const letterCikkMatch = blockId.match(/^CB([A-Z]+)$/);
  if (letterCikkMatch) return `CIKK_${letterCikkMatch[1]}`;

  // Alaptörvény: záró rendelkezések (AR1–AR32) — csak top-level blokk
  const rendMatch = blockId.match(/^AR(\d+)$/);
  if (rendMatch) return `REND_${rendMatch[1]}`;

  return null;
}

function parseSectionFromText(blockHtml: string): string | null {
  const text = htmlToText(blockHtml);
  const match = text.match(/^(\d+[A-Za-z]?(?:\/[A-Za-z]+)?)\s*\.?\s*§/);
  if (!match) return null;

  return match[1].toUpperCase();
}

function parseArticleFromText(blockHtml: string): string | null {
  const text = htmlToText(blockHtml);
  const match = text.match(/^([IVXLCDM]+|\d+)\s*\.\s*(?:Czikk|Cikk|CZIKK)\.?/i);
  if (!match) return null;

  return match[1].toUpperCase();
}

function articleToKey(article: string): string {
  return `ART_${article.replace(/[^0-9A-Za-z]/g, '').toUpperCase()}`;
}

/**
 * Az njt.hu oldal-keret kezdetét jelző elemek. A tartalmi (jhId-) blokkokban
 * jogszerű szövegként SOHA nem fordulnak elő — ha egy blokk tartalmazza
 * valamelyiket, ott a jogszabályszöveg véget ért és a lap-keret kezdődik
 * (versionWindow, lábjegyzet-popup, mobil navigáció, footer, cookie-banner,
 * njtConfig <script>). Két okból nyúlhat be a keret egy blokkba:
 *   1. az utolsó jhId-marker utáni blokk a HTML végéig tart;
 *   2. a hydrateDeferredBlocks az oldal-HTML UTÁN fűzi a deferred blokkokat,
 *      így a keret a parser-input KÖZEPÉRE kerül (törvényeknél ez volt a
 *      szennyezés útja).
 */
const PAGE_FRAME_CUT_RE =
  /<div[^>]*(?:class="(?:versionWindow|footnoteDisplay)|id="(?:fake_footnote_display|navigation_panel|blank-clipboard-select-area))|<footer\b|<script\b|<style\b/i;

function extractNjtBlocks(html: string): NjtBlock[] {
  const markerRegex = /<span class="jhId" id="([^"]+)"><\/span>/g;
  const markers = Array.from(html.matchAll(markerRegex));
  const blocks: NjtBlock[] = [];

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const start = marker.index;
    if (typeof start !== 'number') continue;

    const chunkStart = start + marker[0].length;
    const nextStart = (i + 1 < markers.length && typeof markers[i + 1].index === 'number')
      ? markers[i + 1].index as number
      : html.length;

    let blockHtml = html.slice(chunkStart, nextStart).trim();
    const frameCut = blockHtml.search(PAGE_FRAME_CUT_RE);
    if (frameCut !== -1) blockHtml = blockHtml.slice(0, frameCut).trim();
    if (blockHtml.length === 0) continue;

    const classMatch = blockHtml.match(/^<(?:div|h1|h2)\b[^>]*class="([^"]*)"/i);
    const blockClass = classMatch?.[1] ?? '';

    blocks.push({
      blockId: marker[1],
      blockClass,
      blockHtml,
      blockPos: start,
    });
  }

  return blocks;
}

function isSectionContentClass(blockClass: string): boolean {
  // cikk: elkapja a cikkBetu, cikkArab, cikkRomai Alaptörvény-osztályokat;
  // rendelkezes: az Alaptörvény záró rendelkezéseinek top-level blokkjait.
  // A meglévő törvény/rendelet osztályok (szakasz, bekezdes stb.) változatlanul működnek.
  return /(szakasz|bekezdes|pont|alpont|mondat|szoveg|szelet|cikk|rendelkezes)/i.test(blockClass);
}

function isLegacyContentClass(blockClass: string): boolean {
  return /(preambulum|bekezdes|pont|alpont|mondat|szoveg|szelet)/i.test(blockClass);
}

function provisionTitleFromKey(key: string, section: string): string {
  if (key.startsWith('ART_')) return `${section}. Cikk`;
  if (key.startsWith('CIKK_')) return `${section}) cikk`;   // 'A) cikk', 'B) cikk', stb.
  if (key.startsWith('REND_')) return `${section}.`;         // '1.', '2.', stb.
  if (key === 'PREAMB') return 'Nemzeti Hitvallás';
  if (key.startsWith('LEGACY_')) return section;
  return `${section}. §`;
}

function toProvisionRef(section: string): string {
  return `s${section.replace(/[^0-9A-Za-z]/g, '').toLowerCase()}`;
}

function shouldIncludeSection(actId: string, section: string): boolean {
  const base = Number.parseInt(section.match(/^\d+/)?.[0] ?? '0', 10);

  if (actId === 'act-cxii-2011-public-data') {
    return base >= 26 && base <= 39;
  }

  if (actId === 'criminal-code-cybercrime') {
    return section === '422' || section === '423' || section === '424';
  }

  return true;
}

function extractDefinitions(content: string, sourceProvision: string, defs: ParsedDefinition[]): void {
  if (!/alkalmazásában/i.test(content)) return;

  const pattern = /\b\d+\.\s*([^:;]{2,120}):\s*([^;]{10,500})(?=;\s*\d+\.|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const term = match[1].trim();
    const definition = match[2].trim();

    if (term.length < 2 || definition.length < 10) continue;

    defs.push({
      term,
      definition,
      source_provision: sourceProvision,
    });
  }
}

function extractOfficialTitle(html: string): string | null {
  const main = html.match(/<h1[^>]*class="[^"]*jogszabalyMainTitle[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const subtitleMatches = [...html.matchAll(
    /<h2[^>]*class="([^"]*jogszabalySubtitle[^"]*)"[^>]*>([\s\S]*?)<\/h2>/gi
  )];
  const subtitle =
    subtitleMatches.find(match => !/\bmainTitle\b/i.test(match[1]))?.[2]
    ?? subtitleMatches.at(-1)?.[2];

  const mainText = main ? htmlToText(main) : '';
  const subtitleText = subtitle ? htmlToText(subtitle) : '';
  const combined = subtitleText && subtitleText !== mainText
    ? `${mainText} ${subtitleText}`.trim()
    : mainText;

  return combined.length > 0 ? combined : null;
}

/**
 * Parse njt.hu HTML into seed-compatible structure.
 */
export function parseHungarianHtml(html: string, act: ActIndexEntry): ParsedAct {
  const sections = new Map<string, SectionAccumulator>();
  const definitions: ParsedDefinition[] = [];
  const blocks = extractNjtBlocks(html);

  let currentChapterNumber = '';
  let currentChapterTitle = '';
  let activeSectionKey: string | null = null;

  for (const block of blocks) {
    const { blockId, blockClass, blockHtml, blockPos } = block;

    if (blockClass === 'fejezet') {
      currentChapterNumber = htmlToText(blockHtml);
    } else if (blockClass === 'fejezetCim') {
      currentChapterTitle = htmlToText(blockHtml);
    }

    // Alaptörvény: alaptorvenyFejezet divek nincs jhId markerük, ezért a megelőző
    // blokk HTML-jébe ágyazódnak be. Minden blokkban végigkeressük, és ha találunk,
    // frissítjük a fejezetszámot (az utolsó nyer, ha több is van ugyanabban a blokkban).
    for (const fejM of blockHtml.matchAll(
      /<div[^>]*class="alaptorvenyFejezet"[^>]*>([\s\S]*?)<\/div>/gi
    )) {
      const fejText = htmlToText(fejM[1]);
      if (fejText) {
        currentChapterNumber = fejText;
        currentChapterTitle = '';
      }
    }

    const markerMatch = blockHtml.match(/<span class="szakasz-jel">([\s\S]*?)<\/span>/i);
    const sectionFromMarker = markerMatch ? parseSectionFromMarker(markerMatch[1]) : null;
    const sectionFromText = sectionFromMarker ?? parseSectionFromText(blockHtml);
    const articleFromText = parseArticleFromText(blockHtml);
    const keyFromId = parseSectionKeyFromBlockId(blockId);

    let key: string | null = null;
    if (keyFromId) {
      key = keyFromId;
      activeSectionKey = keyFromId;
    } else if (sectionFromText && sectionFromText.length > 0) {
      key = sectionToKey(sectionFromText);
      activeSectionKey = key;
    } else if (articleFromText) {
      key = articleToKey(articleFromText);
      activeSectionKey = key;
    } else if (activeSectionKey && isSectionContentClass(blockClass)) {
      key = activeSectionKey;
    }

    if (!key) continue;
    let acc = sections.get(key);

    if (!acc) {
      const chapter = [currentChapterNumber, currentChapterTitle]
        .filter(Boolean)
        .join(' - ') || undefined;

      acc = {
        key,
        chapter,
        firstPos: blockPos,
        blocks: [],
      };
      sections.set(key, acc);
    }

    if (sectionFromText && sectionFromText.length > 0) {
      acc.section = sectionFromText;
    } else if (articleFromText) {
      acc.section = articleFromText;
    } else if (!acc.section) {
      acc.section = parseSectionFromKey(key);
    }

    if (isSectionContentClass(blockClass) || !!sectionFromText || !!articleFromText) {
      acc.blocks.push(blockHtml);
    }
  }

  if (sections.size === 0) {
    let legacyIndex = 0;
    for (const block of blocks) {
      if (!isLegacyContentClass(block.blockClass)) continue;

      const text = htmlToText(block.blockHtml);
      if (text.length === 0) continue;

      legacyIndex++;
      const key = `LEGACY_${legacyIndex}`;
      sections.set(key, {
        key,
        section: String(legacyIndex),
        firstPos: block.blockPos,
        blocks: [block.blockHtml],
      });
    }
  }

  const provisions: ParsedProvision[] = [];
  const sortedSections = Array.from(sections.values()).sort((a, b) => a.firstPos - b.firstPos);

  for (const sectionData of sortedSections) {
    const section = sectionData.section ?? parseSectionFromKey(sectionData.key);
    if (!shouldIncludeSection(act.id, section)) continue;

    const contentParts = sectionData.blocks
      .map(htmlToText)
      .filter(part => part.length > 0);

    if (contentParts.length === 0) continue;

    const content = contentParts.join(' ').replace(/\s+/g, ' ').trim();
    if (content.length === 0) continue;

    // Egyedi provision_ref az Alaptörvény betűs cikkeihez és záró rendelkezéseihez,
    // megelőzve a 'si' (CIKK_I vs ART_I) és 's1–s32' (ART_1–32 vs REND_1–32) ütközést.
    const provisionRef = sectionData.key.startsWith('CIKK_')
      ? `scikk${sectionData.key.slice(5).toLowerCase()}`   // CIKK_A → 'scikka'
      : sectionData.key.startsWith('REND_')
      ? `srend${sectionData.key.slice(5)}`                  // REND_1 → 'srend1'
      : toProvisionRef(section);

    provisions.push({
      provision_ref: provisionRef,
      chapter: sectionData.chapter,
      section,
      title: provisionTitleFromKey(sectionData.key, section),
      content,
    });

    extractDefinitions(content, provisionRef, definitions);
  }

  const dedupDefinitions: ParsedDefinition[] = [];
  const seenDefinitions = new Set<string>();
  for (const def of definitions) {
    const key = `${def.term.toLowerCase()}|${def.source_provision ?? ''}`;
    if (seenDefinitions.has(key)) continue;
    seenDefinitions.add(key);
    dedupDefinitions.push(def);
  }

  const officialTitle = extractOfficialTitle(html);
  const keepCustomTitle = act.id === 'act-cxii-2011-public-data' || act.id === 'criminal-code-cybercrime';

  return {
    id: act.id,
    type: 'statute',
    title: keepCustomTitle ? act.title : (officialTitle ?? act.title),
    title_en: act.titleEn,
    short_name: act.shortName,
    status: act.status,
    issued_date: act.issuedDate,
    in_force_date: act.inForceDate,
    url: act.url,
    description: act.description,
    provisions,
    definitions: dedupDefinitions,
  };
}

/**
 * Curated statutes covered by the MCP.
 */
export const KEY_HUNGARIAN_ACTS: ActIndexEntry[] = [
  {
    id: 'act-cxii-2011-info-self-determination',
    title: '2011. évi CXII. törvény az információs önrendelkezési jogról és az információszabadságról',
    titleEn: 'Act CXII of 2011 on Informational Self-Determination and Freedom of Information',
    shortName: 'Infotörvény',
    status: 'in_force',
    issuedDate: '2011-07-26',
    inForceDate: '2012-01-01',
    url: 'https://njt.hu/jogszabaly/2011-112-00-00',
    description:
      'Hungary\'s primary data protection and freedom of information statute, including GDPR-aligned provisions.',
  },
  {
    id: 'act-cxii-2011-public-data',
    title: '2011. évi CXII. törvény - Közérdekű adatok megismerése (III. fejezet)',
    titleEn: 'Act CXII of 2011 - Access to Public Interest Data (Chapter III)',
    shortName: 'Infotörvény - Public Data',
    status: 'in_force',
    issuedDate: '2011-07-26',
    inForceDate: '2012-01-01',
    url: 'https://njt.hu/jogszabaly/2011-112-00-00',
    description:
      'Public-data access provisions extracted from the Infotörvény (sections 26-39).',
  },
  {
    id: 'act-l-2013-electronic-info-security',
    title: '2013. évi L. törvény az állami és önkormányzati szervek elektronikus információbiztonságáról',
    titleEn: 'Act L of 2013 on Electronic Information Security of State and Municipal Bodies',
    shortName: 'Ibtv.',
    status: 'in_force',
    issuedDate: '2013-04-25',
    inForceDate: '2013-07-01',
    url: 'https://njt.hu/jogszabaly/2013-50-00-00',
    description:
      'Core Hungarian public-sector cybersecurity framework (Ibtv.).',
  },
  {
    id: 'act-cviii-2001-electronic-commerce',
    title:
      '2001. évi CVIII. törvény az elektronikus kereskedelmi szolgáltatások, valamint az információs társadalommal összefüggő szolgáltatások egyes kérdéseiről',
    titleEn:
      'Act CVIII of 2001 on Electronic Commerce and Certain Information Society Services',
    shortName: 'Ekertv.',
    status: 'in_force',
    issuedDate: '2001-12-21',
    inForceDate: '2002-01-16',
    url: 'https://njt.hu/jogszabaly/2001-108-00-00',
    description: 'Hungarian e-commerce and intermediary liability statute.',
  },
  {
    id: 'act-c-2003-electronic-communications',
    title: '2003. évi C. törvény az elektronikus hírközlésről',
    titleEn: 'Act C of 2003 on Electronic Communications',
    shortName: 'Eht.',
    status: 'in_force',
    issuedDate: '2003-11-17',
    inForceDate: '2004-01-01',
    url: 'https://njt.hu/jogszabaly/2003-100-00-00',
    description: 'Primary telecommunications statute (Eht.).',
  },
  {
    id: 'act-clxvi-2012-critical-infrastructure',
    title:
      '2012. évi CLXVI. törvény a létfontosságú rendszerek és létesítmények azonosításáról, kijelöléséről és védelméről',
    titleEn:
      'Act CLXVI of 2012 on Identification, Designation and Protection of Vital Systems and Facilities',
    shortName: 'Lrtv.',
    status: 'in_force',
    issuedDate: '2012-11-12',
    inForceDate: '2012-12-01',
    url: 'https://njt.hu/jogszabaly/2012-166-00-00',
    description: 'Critical infrastructure statute.',
  },
  {
    id: 'act-liv-2018-trade-secrets',
    title: '2018. évi LIV. törvény az üzleti titok védelméről',
    titleEn: 'Act LIV of 2018 on the Protection of Trade Secrets',
    shortName: 'Üzleti titok tv.',
    status: 'in_force',
    issuedDate: '2018-06-29',
    inForceDate: '2018-08-08',
    url: 'https://njt.hu/jogszabaly/2018-54-00-00',
    description: 'Hungarian trade secrets statute (EU 2016/943 implementation context).',
  },
  {
    id: 'act-ccxxii-2015-trust-services',
    title:
      '2015. évi CCXXII. törvény az elektronikus ügyintézés és a bizalmi szolgáltatások általános szabályairól',
    titleEn: 'Act CCXXII of 2015 on Electronic Administration and Trust Services',
    shortName: 'E-ügyintézési tv.',
    status: 'in_force',
    issuedDate: '2015-12-21',
    inForceDate: '2016-07-01',
    url: 'https://njt.hu/jogszabaly/2015-222-00-00',
    description: 'Electronic administration and trust services statute.',
  },
  {
    id: 'act-lxiii-1999-public-procurement',
    title: '2015. évi CXLIII. törvény a közbeszerzésekről',
    titleEn: 'Act CXLIII of 2015 on Public Procurement',
    shortName: 'Kbt.',
    status: 'in_force',
    issuedDate: '2015-11-02',
    inForceDate: '2015-11-01',
    url: 'https://njt.hu/jogszabaly/2015-143-00-00',
    description: 'Public procurement statute.',
  },
  {
    id: 'criminal-code-cybercrime',
    title: '2012. évi C. törvény a Büntető Törvénykönyvről - Informatikai bűncselekmények',
    titleEn: 'Act C of 2012 on the Criminal Code - Cybercrime Provisions',
    shortName: 'Btk. (Cybercrime)',
    status: 'in_force',
    issuedDate: '2012-07-13',
    inForceDate: '2013-07-01',
    url: 'https://njt.hu/jogszabaly/2012-100-00-00',
    description: 'Cybercrime-relevant sections (422-424) from the Criminal Code.',
  },
];
