import { encodeRecipe, encodeTargetToken } from '@ruhomo/core';
import type { RecipeInput } from '@ruhomo/core';
import { createApp } from '../src/app.ts';
import type { Env } from '../src/config.ts';
import type { CacheLike } from '../src/snapshot-cache.ts';

export const SOURCE_URL = 'https://raw.githubusercontent.com/example/repo/main/rules.yaml';

export interface UpstreamReply {
  status?: number;
  body?: string | Uint8Array | ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
  /** Never resolve until the request is aborted. */
  hang?: boolean;
  throws?: boolean;
}

export type UpstreamHandler = (url: string, init: RequestInit) => UpstreamReply | Promise<UpstreamReply>;

export interface RecordedCall {
  url: string;
  headers: Headers;
}

export function fakeUpstream(handler: UpstreamHandler) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init.headers) });
    const reply = await handler(url, init);
    if (reply.throws) throw new TypeError('network down');
    if (reply.hang) {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return new Response(reply.body ?? null, { status: reply.status ?? 200, headers: reply.headers ?? { 'content-type': 'text/plain; charset=utf-8' } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export class FakeClock {
  t = Date.UTC(2026, 0, 1);
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export class FakeCache implements CacheLike {
  readonly store = new Map<string, string>();
  broken = false;
  async match(key: string) {
    if (this.broken) throw new Error('cache down');
    const v = this.store.get(key);
    return v === undefined ? undefined : new Response(v);
  }
  async put(key: string, res: Response) {
    if (this.broken) throw new Error('cache down');
    this.store.set(key, await res.text());
  }
}

export interface Harness {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  calls: RecordedCall[];
  clock: FakeClock;
  env: Env;
  logs: string[];
}

export function harness(
  handler: UpstreamHandler,
  opts: { env?: Partial<Env>; cache?: FakeCache | null | 'throw' } = {},
): Harness {
  const upstream = fakeUpstream(handler);
  const clock = new FakeClock();
  const logs: string[] = [];
  const cache = opts.cache;
  const app = createApp({
    upstreamFetch: upstream.fetch,
    now: clock.now,
    cache:
      cache === 'throw'
        ? () => {
            throw new Error('no cache api');
          }
        : () => cache ?? null,
    log: (e) => logs.push(JSON.stringify(e)),
  });
  const env: Env = { PUBLIC_BASE_URL: 'https://ruhomo.example.net', ...opts.env };
  return {
    request: async (path, init) => app.request(path, init, env),
    calls: upstream.calls,
    clock,
    env,
    logs,
  };
}

export function recipeToken(input: Partial<RecipeInput> = {}): string {
  return encodeRecipe({ source: { url: SOURCE_URL }, ...input });
}

export function providerPath(token: string, target: string): string {
  return `/r/v1/${token}/providers/${encodeTargetToken(target)}.list`;
}

export const ACCEPTANCE = `rules:
  # 科技站点
  - DOMAIN-SUFFIX,direct.example,DIRECT
  - DOMAIN-SUFFIX,proxy-one.example,示例代理
  - DOMAIN-SUFFIX,proxy-two.example,示例代理
  - DOMAIN-SUFFIX,proxy-three.example,示例代理

  # 国内镜像
  - DOMAIN-KEYWORD,demo-keyword,默认代理
  - DOMAIN-SUFFIX,mirror-one.example,DIRECT
  - DOMAIN-SUFFIX,mirror-two.example,DIRECT
`;
