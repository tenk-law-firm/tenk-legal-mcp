#!/usr/bin/env node
/**
 * Hungarian Law MCP — B2 Atomic Update Wrapper
 *
 * Orchestrates a safe, zero-downtime DB refresh:
 *   1. check-updates  → exit 0 means "fresh", exit 1 means "stale"
 *   2. ingest         → writes seed JSON to data/seed/
 *   3. build-db       → builds into STAGING file (data/database.db.new)
 *   4. integrity gate → validates staging DB before touching live DB
 *   5. atomic rename  → data/database.db.new → data/database.db
 *
 * The live server NEVER sees a half-built DB.
 *
 * Exit codes:
 *   0   = no update needed (DB was already fresh)
 *   2   = DB was stale and has been successfully updated (restart recommended)
 *   1   = update failed (staging gate did not pass; live DB is untouched)
 *   3   = unexpected / infrastructure error
 *
 * Usage (dev):   npx tsx scripts/cron-update.ts [--force]
 * Usage (prod):  node dist/scripts/cron-update.js [--force]
 *   --force  skip check-updates and always run ingest+build
 *
 * Path resolution
 * ---------------
 * This file is compiled to dist/scripts/cron-update.js.
 * Sub-scripts are compiled siblings:  dist/scripts/{check-updates,ingest,build-db}.js
 * The data directory lives at <repo-root>/data/, which is two levels above dist/scripts/.
 * We resolve it with a multi-candidate walk (same pattern as http-server.ts) so it
 * works whether run as the .ts source (one level below repo root) or as compiled JS
 * (two levels below repo root).  Env overrides LIVE_DB_PATH / STAGING_DB_PATH take
 * precedence for Fly volume mounts.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── path resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the data directory by walking up from __dirname until we find a
 * directory that contains both "data/" and "package.json" (= repo root).
 * Candidates, in order:
 *   dist/scripts/ → .. → dist/ → ../.. → repo root   (compiled)
 *   scripts/      → ..         → repo root            (tsx source)
 */
function resolveDataDir(): string {
  // 1. Env override (Fly volume mount)
  if (process.env['DATA_DIR']) {
    return path.resolve(process.env['DATA_DIR']);
  }

  // 2. Walk up looking for package.json + data/
  let dir = __dirname;
  for (let i = 0; i < 4; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'data'))
    ) {
      return path.join(dir, 'data');
    }
    dir = path.dirname(dir);
  }

  // 3. Explicit two-step fallback candidates
  const candidates = [
    path.join(__dirname, '..', 'data'),       // scripts/ → repo root
    path.join(__dirname, '..', '..', 'data'), // dist/scripts/ → repo root
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    `Cannot locate data/ directory from ${__dirname}. ` +
    `Set the DATA_DIR env var to the absolute path of the data/ folder.`,
  );
}

/**
 * Resolve a sibling compiled script (.js in prod, .ts in dev via tsx).
 * When running as dist/scripts/cron-update.js the siblings are in the same dir.
 * When running as scripts/cron-update.ts via tsx the .ts files are siblings too.
 */
function resolveScript(name: string): string {
  // In compiled form __filename ends with .js; in tsx dev it ends with .ts
  const ext = __filename.endsWith('.ts') ? '.ts' : '.js';
  return path.join(__dirname, `${name}${ext}`);
}

const DATA_DIR   = resolveDataDir();
const LIVE_DB    = process.env['LIVE_DB_PATH']    ?? path.join(DATA_DIR, 'database.db');
const STAGING_DB = process.env['STAGING_DB_PATH'] ?? path.join(DATA_DIR, 'database.db.new');

const FORCE = process.argv.includes('--force');

// ── helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[cron-update ${ts}] ${msg}`);
}

function cleanupStaging(): void {
  if (fs.existsSync(STAGING_DB)) {
    try { fs.unlinkSync(STAGING_DB); } catch { /* ignore */ }
  }
}

/**
 * Run a compiled sub-script synchronously and return its exit code.
 * In production (no tsx): runs `node <script>.js`
 * In dev (tsx available):  runs `node --import tsx <script>.ts`
 */
function runScript(scriptPath: string, args: string[], env?: Record<string, string>): number {
  const isTsx = scriptPath.endsWith('.ts');
  const nodeArgs = isTsx
    ? ['--import', 'tsx', scriptPath, ...args]
    : [scriptPath, ...args];

  const result = spawnSync(process.execPath, nodeArgs, {
    stdio: 'inherit',
    cwd: path.dirname(path.dirname(DATA_DIR)), // repo root (parent of data/)
    env: { ...process.env, ...env },
  });

  if (result.error) {
    throw new Error(`Failed to spawn ${scriptPath}: ${result.error.message}`);
  }
  return result.status ?? 1;
}

// ── integrity gate ────────────────────────────────────────────────────────────

interface GateResult {
  pass: boolean;
  failures: string[];
}

async function runIntegrityGate(stagingPath: string, liveProvCount: number): Promise<GateResult> {
  const failures: string[] = [];

  const { default: Database } = await import('better-sqlite3') as { default: typeof import('better-sqlite3') };
  const db = new Database(stagingPath, { readonly: true });

  try {
    // Gate 1: provision count ≥ 95 % of live
    const provRow = db.prepare('SELECT COUNT(*) as c FROM legal_provisions').get() as { c: number };
    const stagingProv = provRow.c;
    const threshold = Math.floor(liveProvCount * 0.95);
    if (stagingProv < threshold) {
      failures.push(
        `Provision count too low: staging has ${stagingProv}, ` +
        `need ≥ ${threshold} (95 % of live ${liveProvCount})`,
      );
    } else {
      log(`Gate 1 OK: staging provisions ${stagingProv} ≥ threshold ${threshold}`);
    }

    // Gate 2: built_at is today (UTC date prefix)
    const metaRow = db.prepare("SELECT value FROM db_metadata WHERE key = 'built_at'").get() as { value: string } | undefined;
    const builtAt = metaRow?.value ?? '';
    const todayPrefix = new Date().toISOString().slice(0, 10);
    if (!builtAt.startsWith(todayPrefix)) {
      failures.push(`built_at mismatch: staging has "${builtAt}", expected prefix "${todayPrefix}"`);
    } else {
      log(`Gate 2 OK: built_at ${builtAt}`);
    }

    // Gate 3: Ptk. 6:419 § not empty
    const ptkRow = db.prepare(
      "SELECT content FROM legal_provisions " +
      "WHERE document_id = 'hu-law-2013-5-00-00' AND section = '6:419' LIMIT 1",
    ).get() as { content: string } | undefined;
    if (!ptkRow?.content?.trim()) {
      failures.push('Gate 3 FAIL: Ptk. 6:419 § missing/empty (document_id=hu-law-2013-5-00-00, section=6:419)');
    } else {
      log(`Gate 3 OK: Ptk. 6:419 § present (${ptkRow.content.length} chars)`);
    }

    // Gate 4: Btk. 36. § not empty
    const btkRow = db.prepare(
      "SELECT content FROM legal_provisions " +
      "WHERE document_id = 'hu-law-2012-100-00-00' AND provision_ref = 's36' LIMIT 1",
    ).get() as { content: string } | undefined;
    if (!btkRow?.content?.trim()) {
      failures.push('Gate 4 FAIL: Btk. 36. § missing/empty (document_id=hu-law-2012-100-00-00, provision_ref=s36)');
    } else {
      log(`Gate 4 OK: Btk. 36. § present (${btkRow.content.length} chars)`);
    }
  } finally {
    db.close();
  }

  return { pass: failures.length === 0, failures };
}

// ── live DB baseline ──────────────────────────────────────────────────────────

async function getLiveProvCount(): Promise<number> {
  if (!fs.existsSync(LIVE_DB)) return 0;
  try {
    const { default: Database } = await import('better-sqlite3') as { default: typeof import('better-sqlite3') };
    const db = new Database(LIVE_DB, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as c FROM legal_provisions').get() as { c: number };
    db.close();
    return row.c;
  } catch {
    return 0;
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('=== Hungarian Law MCP — cron-update started ===');
  log(`Live DB:    ${LIVE_DB}`);
  log(`Staging DB: ${STAGING_DB}`);
  log(`Force mode: ${FORCE}`);

  // ── Step 1: check-updates ────────────────────────────────────────────────
  if (!FORCE) {
    log('Running check-updates...');
    const checkCode = runScript(resolveScript('check-updates'), []);

    if (checkCode === 0) {
      log('RESULT: Database is current — no update needed. Exiting 0.');
      process.exit(0);
    } else if (checkCode === 1) {
      log('RESULT: Database is STALE — proceeding with ingest + build.');
    } else {
      log(`ERROR: check-updates exited with unexpected code ${checkCode}. Aborting.`);
      process.exit(3);
    }
  } else {
    log('--force flag set: skipping check-updates, running full ingest+build.');
  }

  // Read live prov count BEFORE touching anything
  const liveProvCount = await getLiveProvCount();
  log(`Live DB provision count (baseline): ${liveProvCount}`);

  // ── Step 2: ingest (törvények) ────────────────────────────────────────────
  log('Running ingest (--full --in-force-only --resume)...');
  const ingestCode = runScript(
    resolveScript('ingest'),
    ['--full', '--in-force-only', '--resume'],
  );
  if (ingestCode !== 0) {
    log(`ERROR: ingest exited with code ${ingestCode}. Live DB untouched.`);
    process.exit(1);
  }
  log('Ingest (statutes) completed successfully.');

  // ── Step 2b: ingest (Korm. rendeletek — idei + előző év) ─────────────────
  // A teljes 1990–aktuális év korpusz megvan a seed-ekben; heti frissítéshez
  // csak az aktuális és az előző év szükséges (év eleji/végi új rendeletek).
  // A státusz-VÁLTOZÁSOK követéséhez (év közben hatályát vesztő rendelet) az
  // érintett évek seedjeit töröljük és resume NÉLKÜL futunk — a --resume a
  // meglévő (időközben esetleg hatálytalanná vált) seedet változatlanul
  // hagyná. A --skip-fetch a discovery által frissen cache-elt oldalból
  // parse-ol, így nincs dupla letöltés.
  const currentYear = new Date().getFullYear();
  for (const decreeYear of [currentYear, currentYear - 1]) {
    const seedDir = path.join(DATA_DIR, 'seed');
    if (fs.existsSync(seedDir)) {
      for (const f of fs.readdirSync(seedDir)) {
        if (f.startsWith(`hu-decree-Korm-${decreeYear}-`) && f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(seedDir, f)); } catch { /* ignore */ }
        }
      }
    }
    log(`Running decree ingest for year ${decreeYear}...`);
    const decreeCode = runScript(
      resolveScript('ingest'),
      ['--decrees', '--decree-year', String(decreeYear), '--decrees-in-force-only', '--skip-fetch'],
    );
    if (decreeCode !== 0) {
      // Rendelet-ingest hiba: figyelmeztetés, de NEM állítjuk le a teljes folyamatot
      // (a törvény-ingest rendben lefutott; a rendeletek pótlása következő héten).
      log(`WARN: decree ingest for year ${decreeYear} exited with code ${decreeCode}. Continuing.`);
    } else {
      log(`Decree ingest for year ${decreeYear} completed.`);
    }
  }

  // ── Step 3: build-db into staging ────────────────────────────────────────
  cleanupStaging();
  log(`Building staging DB at ${STAGING_DB}...`);
  const buildCode = runScript(
    resolveScript('build-db'),
    ['--output', STAGING_DB],
  );
  if (buildCode !== 0) {
    log(`ERROR: build-db exited with code ${buildCode}. Cleaning up staging.`);
    cleanupStaging();
    process.exit(1);
  }
  if (!fs.existsSync(STAGING_DB)) {
    log('ERROR: build-db succeeded but staging file is absent. Aborting.');
    process.exit(1);
  }
  log('Staging DB built successfully.');

  // ── Step 4: integrity gate ────────────────────────────────────────────────
  log('Running integrity gate on staging DB...');
  let gate: GateResult;
  try {
    gate = await runIntegrityGate(STAGING_DB, liveProvCount);
  } catch (err) {
    log(`ERROR: Integrity gate threw: ${String(err)}`);
    cleanupStaging();
    process.exit(1);
  }

  if (!gate.pass) {
    log('GATE FAILED — staging DB did not pass all checks:');
    for (const f of gate.failures) {
      log(`  ✗ ${f}`);
    }
    log('Live DB is untouched. Deleting staging file.');
    cleanupStaging();
    process.exit(1);
  }

  log('All integrity gates passed.');

  // ── Step 5: atomic rename ─────────────────────────────────────────────────
  log('Promoting staging DB → live DB (fs.renameSync)...');
  try {
    fs.renameSync(STAGING_DB, LIVE_DB);
  } catch (err) {
    log(`ERROR: renameSync failed: ${String(err)}`);
    log('Live DB may be in an inconsistent state — manual check required!');
    process.exit(3);
  }

  log('=== DB successfully updated. Server restart recommended. ===');
  process.exit(2);
}

main().catch((err) => {
  log(`FATAL: ${String(err)}`);
  cleanupStaging();
  process.exit(3);
});
