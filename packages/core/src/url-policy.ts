/**
 * Source URL policy. The service is not a general URL proxy: only HTTPS
 * URLs on an explicit host allowlist are fetched, and every redirect hop is
 * re-checked with the same function.
 *
 * Allowlist entries are either an exact host (`raw.githubusercontent.com`)
 * or `*.example.com`, which matches strict subdomains of example.com but not
 * example.com itself. No substring or suffix matching is performed.
 */
import { MAX_SOURCE_URL_BYTES } from './limits.ts';
import { utf8ByteLength } from './encoding.ts';

export const DEFAULT_SOURCE_ALLOWLIST: readonly string[] = ['raw.githubusercontent.com', 'gist.githubusercontent.com'];

export interface SourcePolicy {
  allowlist: readonly string[];
  /** Hosts that must never be fetched, e.g. the service's own public host. */
  denyHosts?: readonly string[];
}

export type UrlPolicyCode =
  | 'SOURCE_URL_INVALID'
  | 'SOURCE_URL_TOO_LONG'
  | 'SOURCE_URL_NOT_HTTPS'
  | 'SOURCE_URL_USERINFO'
  | 'SOURCE_URL_FRAGMENT'
  | 'SOURCE_URL_PORT'
  | 'SOURCE_URL_FORBIDDEN_HOST'
  | 'SOURCE_URL_NOT_ALLOWED';

export interface UrlPolicyViolation {
  code: UrlPolicyCode;
  message: string;
}

const HOST_ENTRY = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Validates and lower-cases allowlist entries; throws on malformed ones. */
export function parseAllowlist(entries: readonly string[] | string): string[] {
  const list = typeof entries === 'string' ? entries.split(',') : [...entries];
  const out: string[] = [];
  for (const raw of list) {
    const e = raw.trim().toLowerCase();
    if (e === '') continue;
    if (!HOST_ENTRY.test(e)) throw new Error(`invalid allowlist entry: ${e}`);
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of allowlist) {
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      if (h.length > base.length + 1 && h.endsWith(`.${base}`)) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

function isIPv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Hosts that are rejected even if a deployer lists them: IP literals of any
 * kind (the allowlist is host-name based), localhost, internal-looking TLDs
 * and cloud metadata names.
 */
export function isForbiddenHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') || h.includes(':')) return true; // IPv6 literal
  if (isIPv4Literal(h)) return true;
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true; // numeric host forms
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/\.(local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(h)) return true;
  if (h === 'metadata' || h === 'metadata.google.internal') return true;
  if (!h.includes('.')) return true; // single-label names are internal by definition
  return false;
}

/**
 * Parses a source URL and returns its canonical WHATWG serialization. The
 * same serialization is used for fetching and for the recipe identity, so
 * validation and identity never diverge. Query order and path encoding are
 * left exactly as the URL parser produces them.
 */
export function canonicalizeSourceUrl(input: string): { url: string } | UrlPolicyViolation {
  if (utf8ByteLength(input) > MAX_SOURCE_URL_BYTES) {
    return { code: 'SOURCE_URL_TOO_LONG', message: `源 URL 超过 ${MAX_SOURCE_URL_BYTES} 字节` };
  }
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { code: 'SOURCE_URL_INVALID', message: '源 URL 无法解析' };
  }
  if (u.protocol !== 'https:') return { code: 'SOURCE_URL_NOT_HTTPS', message: '源 URL 必须使用 HTTPS' };
  if (u.username !== '' || u.password !== '') {
    return { code: 'SOURCE_URL_USERINFO', message: '源 URL 不能包含用户名或密码' };
  }
  if (u.hash !== '' || input.includes('#')) return { code: 'SOURCE_URL_FRAGMENT', message: '源 URL 不能包含 #fragment' };
  if (u.port !== '') return { code: 'SOURCE_URL_PORT', message: '源 URL 不能指定非默认端口' };
  if (isForbiddenHost(u.hostname)) {
    return { code: 'SOURCE_URL_FORBIDDEN_HOST', message: '源 URL 指向本地、内网、IP 字面量或元数据地址' };
  }
  if (utf8ByteLength(u.href) > MAX_SOURCE_URL_BYTES) {
    return { code: 'SOURCE_URL_TOO_LONG', message: `源 URL 超过 ${MAX_SOURCE_URL_BYTES} 字节` };
  }
  return { url: u.href };
}

/** Full check of an already canonical URL against a deployment policy. */
export function checkSourceUrl(url: string, policy: SourcePolicy): UrlPolicyViolation | undefined {
  const c = canonicalizeSourceUrl(url);
  if ('code' in c) return c;
  const host = new URL(c.url).hostname;
  if (policy.denyHosts?.some((d) => d.toLowerCase() === host)) {
    return { code: 'SOURCE_URL_FORBIDDEN_HOST', message: '源 URL 不能指向本服务自身' };
  }
  if (!hostAllowed(host, policy.allowlist)) {
    return { code: 'SOURCE_URL_NOT_ALLOWED', message: `源域名 ${host} 不在本部署的允许列表中` };
  }
  return undefined;
}
