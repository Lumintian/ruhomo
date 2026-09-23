import type { Page, Request } from '@playwright/test';
import { createApp } from '../../worker/src/app.ts';

export const PUBLIC_BASE = 'https://ruhomo.example.net';
export const SOURCE_URL = 'https://raw.githubusercontent.com/example/repo/main/extra-rules.yaml';

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

export interface Upstream {
  status: number;
  body: string;
}

/**
 * Serves /api/* and /r/* from an in-process Worker app whose upstream is a
 * mutable fake; records every browser request for privacy assertions.
 */
export async function installBackend(page: Page, upstream: Upstream = { status: 200, body: ACCEPTANCE }) {
  const requests: Request[] = [];
  page.on('request', (r) => requests.push(r));
  const app = createApp({
    upstreamFetch: (async (input: string | URL | globalThis.Request) => {
      if (String(input) !== SOURCE_URL) return new Response('not found', { status: 404 });
      return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }) as typeof fetch,
    log: () => {},
  });
  const env = { PUBLIC_BASE_URL: PUBLIC_BASE };
  await page.route(/\/(api|r)\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const res = await app.request(`${url.pathname}${url.search}`, { method: req.method(), headers: req.headers() }, env);
    await route.fulfill({
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
  return { requests, upstream };
}
