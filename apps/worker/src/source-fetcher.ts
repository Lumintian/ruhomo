/**
 * Restricted upstream fetcher. It is not a general proxy: every hop
 * (including redirects) is checked against the source policy, a single
 * timeout budget covers the whole chain, and the decoded body size is
 * enforced while streaming rather than trusted from Content-Length.
 * No request headers from the caller are forwarded.
 */
import type { SourcePolicy } from '@ruhomo/core';
import { checkSourceUrl, utf8DecodeStrict } from '@ruhomo/core';

export type SourceErrorCode =
  | 'SOURCE_URL_REJECTED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_NETWORK'
  | 'UPSTREAM_STATUS'
  | 'UPSTREAM_UNEXPECTED_304'
  | 'UPSTREAM_REDIRECT_LIMIT'
  | 'UPSTREAM_REDIRECT_REJECTED'
  | 'SOURCE_CONTENT_TYPE'
  | 'SOURCE_TOO_LARGE'
  | 'SOURCE_INVALID_UTF8'
  | 'SOURCE_INVALID';

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  /** HTTP status this service should answer with. */
  readonly status: number;
  readonly upstreamStatus: number | undefined;
  constructor(code: SourceErrorCode, status: number, message: string, upstreamStatus?: number) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

export interface Validators {
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export type FetchOutcome =
  | { kind: 'ok'; text: string; etag: string | undefined; lastModified: string | undefined }
  | { kind: 'not-modified' };

export interface FetchSourceOptions {
  fetch: typeof fetch;
  policy: SourcePolicy;
  timeoutMs: number;
  maxRedirects: number;
  maxBytes: number;
  validators?: Validators | undefined;
  userAgent?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const USER_AGENT = 'ruhomo/0.1';

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel();
    throw new SourceError('SOURCE_TOO_LARGE', 502, `源内容超过 ${maxBytes} 字节上限`);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SourceError('SOURCE_TOO_LARGE', 502, `源内容超过 ${maxBytes} 字节上限`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function checkContentType(res: Response): void {
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') {
    throw new SourceError('SOURCE_CONTENT_TYPE', 502, '上游返回了 HTML 页面，而不是规则文件');
  }
  if (type === 'application/json' || type.endsWith('+json')) {
    throw new SourceError('SOURCE_CONTENT_TYPE', 502, '上游返回了 JSON，而不是规则文件');
  }
}

export async function fetchSource(url: string, opts: FetchSourceOptions): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const conditional = Boolean(opts.validators?.etag || opts.validators?.lastModified);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const violation = checkSourceUrl(current, opts.policy);
      if (violation) {
        throw hop === 0
          ? new SourceError('SOURCE_URL_REJECTED', 403, violation.message)
          : new SourceError('UPSTREAM_REDIRECT_REJECTED', 502, `重定向目标被拒绝：${violation.message}`);
      }
      const headers = new Headers({
        'User-Agent': opts.userAgent ?? USER_AGENT,
        Accept: 'text/plain, text/yaml, application/yaml;q=0.9, */*;q=0.1',
      });
      if (opts.validators?.etag) headers.set('If-None-Match', opts.validators.etag);
      if (opts.validators?.lastModified) headers.set('If-Modified-Since', opts.validators.lastModified);

      let res: Response;
      try {
        res = await opts.fetch(current, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      } catch (e) {
        if (controller.signal.aborted) throw new SourceError('UPSTREAM_TIMEOUT', 504, `获取源内容超时（${opts.timeoutMs} ms）`);
        throw new SourceError('UPSTREAM_NETWORK', 502, `无法连接上游：${(e as Error).name}`);
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        if (!location) throw new SourceError('UPSTREAM_STATUS', 502, '上游重定向缺少 Location', res.status);
        if (hop >= opts.maxRedirects) throw new SourceError('UPSTREAM_REDIRECT_LIMIT', 502, `重定向超过 ${opts.maxRedirects} 次`);
        try {
          current = new URL(location, current).href;
        } catch {
          throw new SourceError('UPSTREAM_REDIRECT_REJECTED', 502, '上游重定向地址无效');
        }
        continue;
      }
      if (res.status === 304) {
        await res.body?.cancel();
        if (!conditional) throw new SourceError('UPSTREAM_UNEXPECTED_304', 502, '上游在未发送条件请求时返回 304', 304);
        return { kind: 'not-modified' };
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new SourceError('UPSTREAM_STATUS', 502, `上游返回 HTTP ${res.status}`, res.status);
      }
      checkContentType(res);
      let bytes: Uint8Array;
      try {
        bytes = await readLimited(res, opts.maxBytes);
      } catch (e) {
        if (e instanceof SourceError) throw e;
        if (controller.signal.aborted) throw new SourceError('UPSTREAM_TIMEOUT', 504, `获取源内容超时（${opts.timeoutMs} ms）`);
        throw new SourceError('UPSTREAM_NETWORK', 502, '读取上游内容失败');
      }
      let text: string;
      try {
        text = utf8DecodeStrict(bytes);
      } catch {
        throw new SourceError('SOURCE_INVALID_UTF8', 502, '源内容不是合法的 UTF-8');
      }
      return {
        kind: 'ok',
        text,
        etag: res.headers.get('etag') ?? undefined,
        lastModified: res.headers.get('last-modified') ?? undefined,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
