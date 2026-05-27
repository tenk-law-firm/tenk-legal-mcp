#!/usr/bin/env node

/**
 * HTTP entry point for Law MCP Server (Docker proxy transport).
 *
 * Universal template — works with ANY law MCP that follows the standard
 * pattern: registerTools() in ./tools/registry.js, capabilities.js,
 * and @ansvar/mcp-sqlite database.
 *
 * Endpoints:
 *   GET  /health  → { status, server, version, uptime_seconds }
 *   POST /mcp     → MCP Streamable HTTP transport (new + existing sessions)
 *   GET  /mcp     → SSE stream (existing session) or metadata (no session)
 *   DELETE /mcp   → session termination
 *   OPTIONS *     → CORS preflight
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from '@ansvar/mcp-sqlite';

import { registerTools } from './tools/registry.js';
import { listSources as listSourcesFn } from './tools/list-sources.js';
import { getAbout as getAboutFn } from './tools/about.js';
import { detectCapabilities, readDbMetadata } from './capabilities.js';

// Local type — avoids import from ./tools/about.js which may not exist in all repos.
// The registerTools() `context` parameter is optional (`?`) so this is safe.
interface AboutContext {
  version: string;
  fingerprint: string;
  dbBuilt: string;
}

// ---------------------------------------------------------------------------
// Configuration (derived from package.json — works for any law MCP)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = parseInt(process.env.PORT || '3000', 10);

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const SERVER_NAME: string = pkg.name.replace(/^@ansvar\//, '');
const SERVER_VERSION: string = pkg.version;
const BASE_URL = process.env.BASE_URL || `https://law.49-13-169-95.nip.io`;

// ---------------------------------------------------------------------------
// OAuth 2.1 — minimal open authorization for Claude Desktop custom connectors
// ---------------------------------------------------------------------------

const oauthClients = new Map<string, { secret: string; redirectUris: string[] }>();
const oauthCodes = new Map<string, { clientId: string; codeChallenge: string; redirectUri: string; expiresAt: number }>();
const oauthTokens = new Set<string>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return computed === challenge;
}

function validateBearerToken(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  // TENK shared-secret elfogadása szerver-szerver hívásokhoz
  if (process.env.TENK_API_SECRET && token === process.env.TENK_API_SECRET) {
    return true;
  }
  // Eredeti OAuth tokens (Claude Desktop kompatibilitás)
  return oauthTokens.has(token);
}

// ---------------------------------------------------------------------------
// Database resolution (standard law MCP path convention)
// ---------------------------------------------------------------------------

function resolveDbPath(): string {
  // 1. Prefer *_LAW_DB_PATH env vars (most specific)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_LAW_DB_PATH') && value) return value;
  }
  // 2. Fall back to any *_DB_PATH env var
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_DB_PATH') && value) return value;
  }

  // 3. Standard relative paths
  const candidates = [
    join(__dirname, '..', 'data', 'database.db'),
    join(__dirname, '..', '..', 'data', 'database.db'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    `Database not found. Set a *_DB_PATH env var or place database.db in data/`,
  );
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/** UUID v4 pattern — prevents injection via session ID header. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validSessionId(raw: string | undefined): string | undefined {
  if (!raw || !UUID_RE.test(raw)) return undefined;
  return raw;
}

const sessions = new Map<string, StreamableHTTPServerTransport>();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dbPath = resolveDbPath();
  const db = new Database(dbPath, { readonly: true });
  db.pragma('foreign_keys = ON');

  const caps = detectCapabilities(db);
  const meta = readDbMetadata(db);
  console.error(`[${SERVER_NAME}] Database: ${dbPath}`);
  console.error(`[${SERVER_NAME}] Tier: ${meta.tier}, Capabilities: ${[...caps].join(', ')}`);

  // About context for the about tool — use partial hash to avoid loading
  // entire DB into memory (some are 200MB+).
  let fingerprint = 'unknown';
  let dbBuilt = new Date().toISOString();
  try {
    const SAMPLE = 64 * 1024;
    const fd = openSync(dbPath, 'r');
    const buf = Buffer.alloc(SAMPLE);
    readSync(fd, buf, 0, SAMPLE, 0);
    closeSync(fd);
    fingerprint = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    dbBuilt = statSync(dbPath).mtime.toISOString();
  } catch { /* non-fatal */ }

  // Try db_metadata table for built_at (newer repos have this)
  try {
    const row = db.prepare("SELECT value FROM db_metadata WHERE key = 'built_at'").get() as { value: string } | undefined;
    if (row) dbBuilt = row.value;
  } catch { /* table may not exist */ }

  const aboutContext: AboutContext = { version: SERVER_VERSION, fingerprint, dbBuilt };

  /** Create a fresh MCP server instance (one per session). */
  function createMCPServer(): Server {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {}, prompts: {}, resources: {} } },
    );
    registerTools(server, db, aboutContext);

    // Prompts
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: 'legal_review',
          description: 'Review a Hungarian legal document, contract, or policy for compliance issues, risks, and missing elements. Returns structured findings with risk levels and specific legal references.',
          arguments: [
            { name: 'document_text', description: 'The full text of the document to review', required: true },
            { name: 'focus_area', description: 'Optional focus: gdpr, contract, employment, consumer, corporate', required: false },
          ],
        },
        {
          name: 'legal_research',
          description: 'Research a Hungarian legal question across all statutes. Returns relevant provisions, EU cross-references, and practical guidance for SMEs.',
          arguments: [
            { name: 'question', description: 'The legal question in plain language (Hungarian or English)', required: true },
          ],
        },
      ],
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (name === 'legal_review') {
        return {
          messages: [{
            role: 'user',
            content: { type: 'text', text: `Review the following Hungarian legal document for compliance issues, risks, and missing elements.\n\nFocus area: ${args?.focus_area || 'all'}\n\nDocument:\n${args?.document_text || '(no document provided)'}` },
          }],
        };
      }
      if (name === 'legal_research') {
        return {
          messages: [{
            role: 'user',
            content: { type: 'text', text: `Research this Hungarian legal question using the legislation database. Cite specific provisions with section numbers.\n\nQuestion: ${args?.question || '(no question provided)'}` },
          }],
        };
      }
      throw new Error(`Unknown prompt: ${name}`);
    });

    // Resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'hungarian-law://sources',
          name: 'Data Sources & Provenance',
          description: 'Authoritative legal data sources, coverage scope, and database freshness metadata',
          mimeType: 'application/json',
        },
        {
          uri: 'hungarian-law://stats',
          name: 'Database Statistics',
          description: 'Document counts, provision counts, definition counts, and EU reference coverage',
          mimeType: 'application/json',
        },
      ],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      if (uri === 'hungarian-law://sources') {
        const sources = await listSourcesFn(db);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(sources, null, 2) }] };
      }
      if (uri === 'hungarian-law://stats') {
        const about = getAboutFn(db, aboutContext);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(about, null, 2) }] };
      }
      throw new Error(`Unknown resource: ${uri}`);
    });

    return server;
  }

  // -------------------------------------------------------------------------
  // HTTP server
  // -------------------------------------------------------------------------

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

    try {
      // OPTIONS — preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // GET /health
      if (url.pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        let dbOk = false;
        try {
          db.prepare('SELECT 1').get();
          dbOk = true;
        } catch { /* DB not healthy */ }

        res.writeHead(dbOk ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: dbOk ? 'ok' : 'degraded',
          server: SERVER_NAME,
          version: SERVER_VERSION,
          uptime_seconds: Math.floor(process.uptime()),
        }));
        return;
      }

      // -----------------------------------------------------------------------
      // OAuth 2.1 endpoints
      // -----------------------------------------------------------------------

      // Protected Resource Metadata (RFC 9728)
      if (url.pathname === '/.well-known/oauth-protected-resource' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          resource: `${BASE_URL}/mcp`,
          authorization_servers: [BASE_URL],
          bearer_methods_supported: ['header'],
        }));
        return;
      }

      // Authorization Server Metadata (RFC 8414)
      if (url.pathname === '/.well-known/oauth-authorization-server' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer: BASE_URL,
          authorization_endpoint: `${BASE_URL}/oauth/authorize`,
          token_endpoint: `${BASE_URL}/oauth/token`,
          registration_endpoint: `${BASE_URL}/oauth/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
        }));
        return;
      }

      // Dynamic Client Registration (RFC 7591)
      if (url.pathname === '/oauth/register' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const clientId = randomUUID();
        const clientSecret = randomUUID();
        const redirectUris: string[] = body.redirect_uris || [];

        oauthClients.set(clientId, { secret: clientSecret, redirectUris });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uris: redirectUris,
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
        }));
        return;
      }

      // Authorization endpoint — auto-approve (public server)
      if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
        const clientId = url.searchParams.get('client_id') || '';
        const redirectUri = url.searchParams.get('redirect_uri') || '';
        const codeChallenge = url.searchParams.get('code_challenge') || '';
        const state = url.searchParams.get('state') || '';
        const responseType = url.searchParams.get('response_type');

        if (responseType !== 'code' || !clientId || !redirectUri || !codeChallenge) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_request' }));
          return;
        }

        const code = randomUUID();
        oauthCodes.set(code, {
          clientId,
          codeChallenge,
          redirectUri,
          expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
        });

        const redirect = new URL(redirectUri);
        redirect.searchParams.set('code', code);
        if (state) redirect.searchParams.set('state', state);

        res.writeHead(302, { Location: redirect.toString() });
        res.end();
        return;
      }

      // Token endpoint
      if (url.pathname === '/oauth/token' && req.method === 'POST') {
        const raw = await readBody(req);
        const params = new URLSearchParams(raw);

        const grantType = params.get('grant_type');
        const code = params.get('code') || '';
        const codeVerifier = params.get('code_verifier') || '';
        const clientId = params.get('client_id') || '';

        if (grantType !== 'authorization_code') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
          return;
        }

        const stored = oauthCodes.get(code);
        if (!stored || stored.clientId !== clientId || stored.expiresAt < Date.now()) {
          oauthCodes.delete(code);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }

        if (!verifyPkce(codeVerifier, stored.codeChallenge)) {
          oauthCodes.delete(code);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }));
          return;
        }

        oauthCodes.delete(code);

        const accessToken = randomUUID();
        oauthTokens.add(accessToken);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: accessToken,
          token_type: 'bearer',
          expires_in: 3600,
        }));
        return;
      }

      // -----------------------------------------------------------------------
      // /mcp — MCP Streamable HTTP transport (Bearer token required)
      // -----------------------------------------------------------------------

      // /mcp — MCP Streamable HTTP transport
      if (url.pathname === '/mcp') {
        // Require Bearer token for POST (new session / tool calls)
        if (req.method === 'POST' && !validateBearerToken(req)) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
          });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const sessionId = validSessionId(req.headers['mcp-session-id'] as string | undefined);

        // Existing session — delegate
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.handleRequest(req, res);
          return;
        }

        // DELETE — session termination (no existing session found)
        if (req.method === 'DELETE') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }

        // POST — new session (initialize)
        if (req.method === 'POST') {
          // Pre-generate sessionId so we can store it before handleRequest.
          // This eliminates a race where the client sends a follow-up request
          // between handleRequest completing and sessions.set() executing.
          const newSessionId = randomUUID();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
          });

          sessions.set(newSessionId, transport);

          transport.onclose = () => {
            sessions.delete(newSessionId);
          };

          const server = createMCPServer();
          await server.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }

        // GET/HEAD without session — metadata
        if (req.method === 'GET' || req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            name: SERVER_NAME,
            version: SERVER_VERSION,
            description: 'Full-text search across 4,300+ Hungarian statutes and 130,000+ provisions from Nemzeti Jogszabálytár (njt.hu). Updated daily.',
            protocol: 'mcp',
            transport: 'streamable-http',
          }));
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request — missing or invalid session' }));
        return;
      }

      // GET /icon.png — server icon
      if ((url.pathname === '/icon.png' || url.pathname === '/icon.svg') && (req.method === 'GET' || req.method === 'HEAD')) {
        try {
          const iconPath = join(__dirname, '..', 'icon.png');
          const iconData = readFileSync(iconPath);
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Content-Length': iconData.length.toString() });
          if (req.method !== 'HEAD') res.end(iconData);
          else res.end();
        } catch {
          res.writeHead(404);
          res.end();
        }
        return;
      }

      // GET /.well-known/mcp/server-card.json — MCP server card for registries
      if (url.pathname === '/.well-known/mcp/server-card.json' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
            displayName: 'Hungarian Law MCP',
            description: 'Full-text search across 4,300+ Hungarian statutes and 130,000+ provisions. Covers the full corpus from Nemzeti Jogszabálytár (njt.hu) including Ptk., Infotv., Mt., Btk., and EU cross-references. Updated daily.',
            homepage: 'https://github.com/Ansvar-Systems/Hungarian-law-mcp',
            icon: 'https://law.49-13-169-95.nip.io/icon.png',
            keywords: ['hungarian-law', 'legislation', 'legal', 'mcp', 'gdpr', 'data-protection', 'cybersecurity', 'compliance', 'ptk', 'infotv'],
            author: 'Ansvar Systems / AVIAN Care Kft.',
            license: 'Apache-2.0',
          },
          capabilities: {
            tools: true,
            prompts: true,
            resources: true,
          },
          transport: {
            type: 'streamable-http',
            url: '/mcp',
          },
        }));
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      console.error(`[${SERVER_NAME}] Unhandled error:`, error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${SERVER_VERSION} HTTP server listening on port ${PORT}`);
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  const shutdown = (signal: string) => {
    console.error(`[${SERVER_NAME}] Shutting down (${signal})...`);
    for (const [, t] of sessions) t.close().catch(() => {});
    sessions.clear();
    try { db.close(); } catch { /* ignore */ }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
