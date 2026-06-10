#!/usr/bin/env tsx
/**
 * Seed-visszanyerő: a meglévő SQLite DB dokumentumait írja vissza
 * data/seed/{id}.json seed-fájlokká (a build-db.ts pontos inverze).
 *
 * Háttér: a data/seed/ könyvtárból a törvény-seedek hiányoznak (csak a
 * rendelet-seedek + 4 friss törvény van meg), a build-db viszont mindig
 * nulláról épít. A parser-javítás utáni újraépítéshez ezért a DB-ből kell
 * visszanyerni a változatlanul jó törvény-seedeket.
 *
 * Használat:
 *   npx tsx scripts/dump-db-to-seeds.ts --db data/database.db.flyprod [--include-decrees]
 *
 * Viselkedés:
 *   - alapból CSAK a nem-rendelet (NOT LIKE 'hu-decree-%') dokumentumokat dumpolja
 *   - a már létező seed-fájlokat NEM írja felül (a frissen újra-ingestelt
 *     seedek — pl. hu-alaptorveny — érintetlenek maradnak)
 *   - az EU-referenciák/citációk NEM kerülnek a seedbe: azokat a build-db
 *     a provision-tartalomból regenerálja
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEED_DIR = path.resolve(__dirname, '../data/seed');

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const dbPath = arg('--db');
if (!dbPath) {
  console.error('Usage: npx tsx scripts/dump-db-to-seeds.ts --db <path> [--include-decrees]');
  process.exit(1);
}
const includeDecrees = process.argv.includes('--include-decrees');

interface DocRow {
  id: string; type: string; title: string; title_en: string | null;
  short_name: string | null; status: string; issued_date: string | null;
  in_force_date: string | null; url: string | null; description: string | null;
}
interface ProvRow {
  provision_ref: string; chapter: string | null; section: string;
  title: string | null; content: string; metadata: string | null;
}
interface DefRow { term: string; definition: string; source_provision: string | null }

const db = new Database(path.resolve(dbPath), { readonly: true });
fs.mkdirSync(SEED_DIR, { recursive: true });

const docs = db.prepare(
  `SELECT id, type, title, title_en, short_name, status, issued_date, in_force_date, url, description
   FROM legal_documents ${includeDecrees ? '' : "WHERE id NOT LIKE 'hu-decree-%'"} ORDER BY id`,
).all() as DocRow[];

const provStmt = db.prepare(
  `SELECT provision_ref, chapter, section, title, content, metadata
   FROM legal_provisions WHERE document_id = ? ORDER BY id`,
);
const defStmt = db.prepare(
  `SELECT term, definition, source_provision FROM definitions WHERE document_id = ? ORDER BY id`,
);

let written = 0;
let skippedExisting = 0;

for (const doc of docs) {
  const seedFile = path.join(SEED_DIR, `${doc.id}.json`);
  if (fs.existsSync(seedFile)) {
    skippedExisting++;
    continue;
  }

  const provisions = (provStmt.all(doc.id) as ProvRow[]).map(p => ({
    provision_ref: p.provision_ref,
    ...(p.chapter ? { chapter: p.chapter } : {}),
    section: p.section,
    ...(p.title ? { title: p.title } : {}),
    content: p.content,
    ...(p.metadata ? { metadata: JSON.parse(p.metadata) as Record<string, unknown> } : {}),
  }));

  const definitions = (defStmt.all(doc.id) as DefRow[]).map(d => ({
    term: d.term,
    definition: d.definition,
    ...(d.source_provision ? { source_provision: d.source_provision } : {}),
  }));

  const seed = {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    ...(doc.title_en ? { title_en: doc.title_en } : {}),
    ...(doc.short_name ? { short_name: doc.short_name } : {}),
    status: doc.status,
    ...(doc.issued_date ? { issued_date: doc.issued_date } : {}),
    ...(doc.in_force_date ? { in_force_date: doc.in_force_date } : {}),
    ...(doc.url ? { url: doc.url } : {}),
    ...(doc.description ? { description: doc.description } : {}),
    provisions,
    definitions,
  };

  fs.writeFileSync(seedFile, `${JSON.stringify(seed, null, 2)}\n`);
  written++;
}

db.close();
console.log(`Dumped ${written} seeds to ${SEED_DIR} (skipped ${skippedExisting} existing).`);
