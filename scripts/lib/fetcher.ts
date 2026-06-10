/**
 * Rate-limited HTTP client for Hungarian legislation from njt.hu.
 *
 * - 1200ms minimum delay between requests (government-friendly 1-2s window)
 * - User-Agent header identifying this MCP
 * - Retry on 429/5xx with exponential backoff
 */

const USER_AGENT =
  'Hungarian-Law-MCP/1.0 (+https://github.com/Ansvar-Systems/Hungarian-law-mcp; hello@ansvar.eu)';
const MIN_DELAY_MS = 1200;
// Kérés-szintű timeout: beragadt kapcsolat ne lógassa örökre a futást —
// timeout után a hálózati-hiba ág retry-ol exponenciális backoffal.
const REQUEST_TIMEOUT_MS = 30_000;

let lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

export interface FetchResult {
  status: number;
  body: string;
  contentType: string;
  url: string;
}

async function requestWithRetry(
  url: string,
  init: RequestInit,
  maxRetries: number
): Promise<FetchResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      if (attempt < maxRetries) {
        const backoff = Math.pow(2, attempt + 1) * 1000;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  Network error for ${url}: ${message}. Retrying in ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      throw error;
    }

    if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
      const backoff = Math.pow(2, attempt + 1) * 1000;
      console.log(`  HTTP ${response.status} for ${url}, retrying in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      continue;
    }

    const body = await response.text();
    return {
      status: response.status,
      body,
      contentType: response.headers.get('content-type') ?? '',
      url: response.url,
    };
  }

  throw new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}

/**
 * Fetch a URL with rate limiting and retries on transient failures.
 */
export async function fetchWithRateLimit(url: string, maxRetries = 3): Promise<FetchResult> {
  await rateLimit();

  return requestWithRetry(
    url,
    {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    },
    maxRetries
  );
}

export async function postJsonWithRateLimit(
  url: string,
  payload: unknown,
  maxRetries = 3
): Promise<FetchResult> {
  await rateLimit();

  return requestWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, */*',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
    },
    maxRetries
  );
}
