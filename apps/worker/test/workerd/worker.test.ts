import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { encodeRecipe, encodeTargetToken } from '@ruhomo/core';
import { createApp } from '../../src/app.ts';
import type { CacheLike } from '../../src/snapshot-cache.ts';

const SOURCE = 'https://raw.githubusercontent.com/example/repo/main/rules.txt';
const RULES = 'DOMAIN-SUFFIX,a.example,DIRECT\nDOMAIN-SUFFIX,b.example,示例代理\n';

describe('workerd runtime', () => {
  it('routes unknown API and recipe paths to JSON 404 through the real entry', async () => {
    for (const path of ['/api/unknown', '/r/v1/x/unknown']) {
      const res = await SELF.fetch(`https://ruhomo.test${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    }
    const bad = await SELF.fetch('https://ruhomo.test/r/v1/!!/override.yaml');
    expect(bad.status).toBe(400);
    const health = await SELF.fetch('https://ruhomo.test/api/health');
    expect(await health.json()).toMatchObject({ ok: true });
  });

  it('persists complete snapshots in the real Cache API across app instances', async () => {
    let upstreamCalls = 0;
    const upstream = (async () => {
      upstreamCalls++;
      return new Response(RULES, { headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;
    const failing = (async () => {
      upstreamCalls++;
      return new Response('boom', { status: 500 });
    }) as typeof fetch;
    const cache = () => (caches as unknown as { default: CacheLike }).default;
    const env = { PUBLIC_BASE_URL: 'https://ruhomo.test' };
    const token = encodeRecipe({ source: { url: SOURCE } });
    const path = `https://ruhomo.test/r/v1/${token}/providers/${encodeTargetToken('示例代理')}.list`;

    const first = createApp({ upstreamFetch: upstream, cache, log: () => {} });
    const r1 = await first.request(path, {}, env);
    expect(r1.status).toBe(200);
    expect(await r1.text()).toBe('DOMAIN-SUFFIX,b.example\n');

    const second = createApp({ upstreamFetch: failing, cache, log: () => {} });
    const r2 = await second.request(path, {}, env);
    expect(r2.status).toBe(200);
    expect(r2.headers.get('x-cache-status')).toBe('hit');
    expect(await r2.text()).toBe('DOMAIN-SUFFIX,b.example\n');
    expect(upstreamCalls).toBe(1);
  });
});
