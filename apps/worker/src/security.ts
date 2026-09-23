/**
 * Response hardening and privacy-preserving logging.
 *
 * Logs never contain source bodies, source URLs, recipe tokens, rules or
 * request headers — only event names, error codes and truncated digests.
 */

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export function applySecurityHeaders(headers: Headers): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
}

export type LogEvent = Record<string, string | number | boolean | undefined>;

export function createLogger(sink: (line: string) => void = console.log): (event: LogEvent) => void {
  return (event) => {
    try {
      sink(JSON.stringify({ svc: 'ruhomo', ...event }));
    } catch {
      // logging must never break a request
    }
  };
}

/** Client key for the optional rate limiter; CF-Connecting-IP is set by Cloudflare. */
export function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}
