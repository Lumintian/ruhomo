import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { encodeRecipe } from '@ruhomo/core';
import { ACCEPTANCE, FakeCache, SOURCE_URL, harness, providerPath, recipeToken } from './helpers.ts';

const text = (body: string, headers: Record<string, string> = {}) => ({
  status: 200,
  body,
  headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
});

describe('provider endpoint', () => {
  it('serves one rule per line without the target', async () => {
    const h = harness(() => text(ACCEPTANCE));
    const res = await h.request(providerPath(recipeToken(), '示例代理'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-rule-count')).toBe('3');
    expect(res.headers.get('x-result-stale')).toBe('false');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('DOMAIN-SUFFIX,proxy-one.example\nDOMAIN-SUFFIX,proxy-two.example\nDOMAIN-SUFFIX,proxy-three.example\n');
  });

  it('returns a parseable empty set for a target missing from a validated source', async () => {
    const h = harness(() => text(ACCEPTANCE));
    const res = await h.request(providerPath(recipeToken(), '已删除的目标'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-rule-count')).toBe('0');
    expect(await res.text()).toBe('# empty\n');
  });

  it('returns an empty set for every target when the source is explicitly empty', async () => {
    const h = harness(() => text('rules: []\n'));
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('# empty\n');
  });

  it('uses byte-based ETags and answers If-None-Match with 304', async () => {
    const h = harness(() => text(ACCEPTANCE));
    const path = providerPath(recipeToken(), 'DIRECT');
    const a = await h.request(path);
    const b = await h.request(path);
    const etag = a.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(b.headers.get('etag')).toBe(etag);
    const c = await h.request(path, { headers: { 'If-None-Match': `W/"nope", ${etag}` } });
    expect(c.status).toBe(304);
    expect(await c.text()).toBe('');
    expect(c.headers.get('etag')).toBe(etag);
    const other = await h.request(providerPath(recipeToken(), '示例代理'));
    expect(other.headers.get('etag')).not.toBe(etag);
  });

  it('supports HEAD', async () => {
    const h = harness(() => text(ACCEPTANCE));
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'), { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-rule-count')).toBe('3');
  });

  it('rejects malformed target tokens', async () => {
    const h = harness(() => text(ACCEPTANCE));
    const res = await h.request(`/r/v1/${recipeToken()}/providers/YQ==.list`);
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('overrides and inspect', () => {
  it('serves YAML and JS overrides with proper content types and stable links', async () => {
    const h = harness(() => text(ACCEPTANCE), { env: { PUBLIC_BASE_URL: 'https://ruhomo.example.net/' } });
    const token = recipeToken();
    const yaml = await h.request(`/r/v1/${token}/override.yaml`, { headers: { 'X-Forwarded-Host': 'evil.example' } });
    expect(yaml.status).toBe(200);
    expect(yaml.headers.get('content-type')).toBe('application/yaml; charset=utf-8');
    const doc = parseYaml(await yaml.text()) as { 'rule-providers': Record<string, { url: string }>; '+rules': string[] };
    expect(doc['+rules'].map((r) => r.split(',')[2])).toEqual(['DIRECT', '示例代理', '默认代理']);
    for (const p of Object.values(doc['rule-providers'])) {
      expect(p.url.startsWith(`https://ruhomo.example.net/r/v1/${token}/providers/`)).toBe(true);
    }
    const js = await h.request(`/r/v1/${token}/override.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await js.text()).toMatch(/^function main\(config\) \{$/m);
  });

  it('keeps override bodies identical when only rules change', async () => {
    let body = ACCEPTANCE;
    const h = harness(() => text(body), { env: { CACHE_FRESH_SECONDS: '0' } });
    const token = recipeToken();
    const a = await (await h.request(`/r/v1/${token}/override.js`)).text();
    body = ACCEPTANCE.replace('proxy-three.example', 'example.org').replace('demo-keyword', 'new-keyword');
    h.clock.advance(1000);
    const b = await (await h.request(`/r/v1/${token}/override.js`)).text();
    expect(b).toBe(a);
    const p = await (await h.request(providerPath(token, '默认代理'))).text();
    expect(p).toBe('DOMAIN-KEYWORD,new-keyword\n');
  });

  it('applies targetOrder from the recipe', async () => {
    const h = harness(() => text(ACCEPTANCE));
    const token = recipeToken({ targetOrder: ['默认代理', 'DIRECT'] });
    const doc = parseYaml(await (await h.request(`/r/v1/${token}/override.yaml`)).text()) as { '+rules': string[] };
    expect(doc['+rules'].map((r) => r.split(',')[2])).toEqual(['默认代理', 'DIRECT', '示例代理']);
  });

  it('describes the snapshot in inspect.json', async () => {
    const h = harness(() => text(ACCEPTANCE));
    const token = recipeToken();
    const res = await h.request(`/r/v1/${token}/inspect.json`);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      validation: 'structural',
      mihomoBaseline: 'v1.19.31',
      status: { stale: false, lastError: null },
      source: { url: SOURCE_URL, detectedFormat: 'yaml', ruleCount: 7 },
    });
    expect(body.targets.map((t: { target: string; ruleCount: number }) => [t.target, t.ruleCount])).toEqual([
      ['DIRECT', 3],
      ['示例代理', 3],
      ['默认代理', 1],
    ]);
    expect(body.targets[0].providerName).toMatch(/^mrp-[0-9a-f]{32}-[0-9a-f]{32}$/);
    expect(body.diagnostics.map((d: { code: string }) => d.code)).toContain('ORDER_CHANGED_BY_GROUPING');
    expect(body.links.overrideYaml).toBe(`https://ruhomo.example.net/r/v1/${token}/override.yaml`);
  });
});

describe('failure semantics', () => {
  it.each([
    [404, 502],
    [500, 502],
    [403, 502],
  ])('upstream %i without cache -> %i JSON, never an empty set', async (upstream, expected) => {
    const h = harness(() => ({ status: upstream, body: 'Not Found' }));
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(expected);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: { code: 'UPSTREAM_STATUS' }, upstreamStatus: upstream });
  });

  it('times out with 504', async () => {
    const h = harness(() => ({ hang: true }), { env: { FETCH_TIMEOUT_MS: '1000' } });
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(504);
    expect((await res.json()).error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('reports network errors', async () => {
    const h = harness(() => ({ throws: true }));
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('UPSTREAM_NETWORK');
  });

  it('rejects an HTML error page served with 200', async () => {
    const html = '<!DOCTYPE html><html><body>Rate limited</body></html>';
    const h1 = harness(() => text(html, { 'content-type': 'text/html; charset=utf-8' }));
    const r1 = await h1.request(providerPath(recipeToken(), 'DIRECT'));
    expect(r1.status).toBe(502);
    expect((await r1.json()).error.code).toBe('SOURCE_CONTENT_TYPE');
    const h2 = harness(() => text(html));
    const r2 = await h2.request(providerPath(recipeToken(), 'DIRECT'));
    expect(r2.status).toBe(422);
    const body = await r2.json();
    expect(body.error.code).toBe('SOURCE_INVALID');
    expect(body.diagnostics[0].code).toBe('SOURCE_LOOKS_LIKE_HTML');
  });

  it('rejects an empty upstream body instead of clearing rules', async () => {
    const h = harness(() => text(''));
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(422);
    expect((await res.json()).diagnostics[0].code).toBe('EMPTY_DOCUMENT');
  });

  it('fails the whole source when any rule is invalid, with located diagnostics', async () => {
    const h = harness(() => text('DOMAIN,a.com,DIRECT\nMATCH,DIRECT\n'));
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.diagnostics).toEqual([expect.objectContaining({ code: 'FORBIDDEN_RULE_TYPE', line: 2 })]);
  });

  it('rejects invalid UTF-8', async () => {
    const h = harness(() => ({ status: 200, body: new Uint8Array([0x44, 0xff, 0x0a]), headers: { 'content-type': 'text/plain' } }));
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect((await res.json()).error.code).toBe('SOURCE_INVALID_UTF8');
  });

  it('rejects an unexpected 304', async () => {
    const h = harness(() => ({ status: 304 }));
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect((await res.json()).error.code).toBe('UPSTREAM_UNEXPECTED_304');
  });
});

describe('limits and URL policy', () => {
  it('enforces the decoded size limit while streaming, ignoring missing Content-Length', async () => {
    const big = `rules:\n${'  - DOMAIN,a.com,DIRECT\n'.repeat(2000)}`;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(big);
        for (let i = 0; i < bytes.length; i += 1000) c.enqueue(bytes.slice(i, i + 1000));
        c.close();
      },
    });
    const h = harness(() => ({ status: 200, body: stream, headers: { 'content-type': 'text/plain' } }), { env: { MAX_SOURCE_BYTES: '4096' } });
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('SOURCE_TOO_LARGE');
  });

  it('rejects by Content-Length before reading', async () => {
    const h = harness(() => ({ status: 200, body: 'x', headers: { 'content-type': 'text/plain', 'content-length': '999999' } }));
    expect((await (await h.request(providerPath(recipeToken(), 'DIRECT'))).json()).error.code).toBe('SOURCE_TOO_LARGE');
  });

  it('does not fetch sources outside the allowlist', async () => {
    const h = harness(() => text(ACCEPTANCE), { env: { SOURCE_ALLOWLIST: 'gist.githubusercontent.com' } });
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('SOURCE_URL_NOT_ALLOWED');
    expect(h.calls).toHaveLength(0);
  });

  it('refuses the deployment own host as a source', async () => {
    const token = encodeRecipe({ source: { url: 'https://ruhomo.example.net/r/v1/x/override.yaml' } });
    const h = harness(() => text(ACCEPTANCE), { env: { SOURCE_ALLOWLIST: 'ruhomo.example.net' } });
    const res = await h.request(`/r/v1/${token}/inspect.json`);
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it('re-checks every redirect hop', async () => {
    const h = harness((url) =>
      url === SOURCE_URL ? { status: 302, headers: { location: 'https://evil.example.com/rules.txt' } } : text(ACCEPTANCE),
    );
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('UPSTREAM_REDIRECT_REJECTED');
    expect(h.calls.map((c) => c.url)).toEqual([SOURCE_URL]);
  });

  it('rejects redirects to private addresses', async () => {
    const h = harness(() => ({ status: 301, headers: { location: 'https://169.254.169.254/latest' } }));
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect((await res.json()).error.code).toBe('UPSTREAM_REDIRECT_REJECTED');
  });

  it('follows allowed redirects up to the limit', async () => {
    let n = 0;
    const h = harness((url) => {
      if (url.endsWith('/final.yaml')) return text(ACCEPTANCE);
      n++;
      return { status: 307, headers: { location: n < 3 ? `/hop${n}` : '/final.yaml' } };
    });
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(4);

    const loop = harness(() => ({ status: 302, headers: { location: '/again' } }));
    const r2 = await loop.request(providerPath(recipeToken(), 'DIRECT'));
    expect((await r2.json()).error.code).toBe('UPSTREAM_REDIRECT_LIMIT');
    expect(loop.calls).toHaveLength(4);
  });

  it('does not forward caller headers upstream', async () => {
    const h = harness(() => text(ACCEPTANCE));
    await h.request(providerPath(recipeToken(), 'DIRECT'), {
      headers: { Cookie: 'session=secret', Authorization: 'Bearer secret', 'X-Custom': 'x' },
    });
    const sent = h.calls[0]!.headers;
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('authorization')).toBeNull();
    expect(sent.get('x-custom')).toBeNull();
    expect(sent.get('user-agent')).toMatch(/^ruhomo\//);
  });

  it('rejects invalid, non-canonical and oversize recipe tokens', async () => {
    const h = harness(() => text(ACCEPTANCE));
    expect((await h.request('/r/v1/not-base64!/override.yaml')).status).toBe(400);
    expect((await (await h.request(`/r/v1/${recipeToken()}=/override.yaml`)).json()).error.code).toBe('RECIPE_MALFORMED_TOKEN');
    const long = await h.request(`/r/v1/${'A'.repeat(9000)}/override.yaml`);
    expect(long.status).toBe(414);
    expect(h.calls).toHaveLength(0);
  });

  it('never leaks stack traces or configuration', async () => {
    const h = harness(() => text(ACCEPTANCE), { env: { CACHE_FRESH_SECONDS: 'abc' } });
    const res = await h.request(providerPath(recipeToken(), 'DIRECT'));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('CONFIG_ERROR');
    expect(body).not.toMatch(/at \w+ \(|CACHE_FRESH_SECONDS/);
  });
});

describe('routing boundaries', () => {
  const assets = { fetch: async () => new Response('<!doctype html><title>SPA</title>', { headers: { 'content-type': 'text/html' } }) };

  it.each(['/api/unknown', '/r/v1', '/r/v1/x/unknown.txt', '/r/anything'])('%s is a JSON 404, not the SPA', async (path) => {
    const h = harness(() => text(ACCEPTANCE), { env: { ASSETS: assets } });
    const res = await h.request(path);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('a provider path with a wrong extension is a 404', async () => {
    const h = harness(() => text(ACCEPTANCE), { env: { ASSETS: assets } });
    const res = await h.request(`/r/v1/${recipeToken()}/providers/RElSRUNU.txt`);
    expect(res.status).toBe(404);
  });

  it('non-GET methods on /r are rejected', async () => {
    const h = harness(() => text(ACCEPTANCE));
    expect((await h.request(`/r/v1/${recipeToken()}/override.yaml`, { method: 'POST' })).status).toBe(405);
  });

  it('other paths go to static assets', async () => {
    const h = harness(() => text(ACCEPTANCE), { env: { ASSETS: assets } });
    const res = await h.request('/some/page');
    expect(await res.text()).toContain('SPA');
  });

  it('exposes deployment config for the UI', async () => {
    const h = harness(() => text(ACCEPTANCE));
    const body = await (await h.request('/api/config')).json();
    expect(body).toMatchObject({
      publicBaseUrl: 'https://ruhomo.example.net',
      allowlist: ['raw.githubusercontent.com', 'gist.githubusercontent.com'],
      cache: { freshSeconds: 60, staleSeconds: 86400 },
    });
  });

  it('falls back to the request origin without PUBLIC_BASE_URL', async () => {
    const h = harness(() => text(ACCEPTANCE), { env: { PUBLIC_BASE_URL: '' } });
    const body = await (await h.request('http://localhost:8787/api/config')).json();
    expect(body.publicBaseUrl).toBe('http://localhost:8787');
  });
});

describe('snapshot cache', () => {
  const FRESH = 60_000;

  it('serves from memory while fresh and shares one snapshot across endpoints', async () => {
    const h = harness(() => text(ACCEPTANCE, { etag: '"v1"' }));
    const token = recipeToken();
    await h.request(providerPath(token, 'DIRECT'));
    await h.request(providerPath(token, '示例代理'));
    await h.request(`/r/v1/${token}/override.yaml`);
    await h.request(`/r/v1/${recipeToken({ targetOrder: ['DIRECT'] })}/inspect.json`);
    expect(h.calls).toHaveLength(1);
  });

  it('revalidates with conditional headers after the fresh window and accepts 304', async () => {
    const h = harness((_url, init) =>
      new Headers(init.headers).get('if-none-match') === '"v1"' ? { status: 304 } : text(ACCEPTANCE, { etag: '"v1"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' }),
    );
    const path = providerPath(recipeToken(), 'DIRECT');
    await h.request(path);
    h.clock.advance(FRESH + 1);
    const res = await h.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cache-status')).toBe('revalidated');
    expect(await res.text()).toContain('direct.example');
    expect(h.calls[1]!.headers.get('if-none-match')).toBe('"v1"');
    expect(h.calls[1]!.headers.get('if-modified-since')).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
  });

  it('serves stale results on failure, marks them, and never extends the stale window', async () => {
    let fail = false;
    const h = harness(() => (fail ? { status: 500 } : text(ACCEPTANCE)));
    const path = providerPath(recipeToken(), 'DIRECT');
    const good = await (await h.request(path)).text();
    fail = true;

    h.clock.advance(FRESH + 1);
    const s1 = await h.request(path);
    expect(s1.status).toBe(200);
    expect(s1.headers.get('x-result-stale')).toBe('true');
    expect(s1.headers.get('x-last-error')).toBe('UPSTREAM_STATUS');
    expect(await s1.text()).toBe(good);

    h.clock.advance(86_400_000 - FRESH - 1000); // just inside 24 h of the last success
    const s2 = await h.request(path);
    expect(s2.status).toBe(200);
    expect(s2.headers.get('x-result-stale')).toBe('true');

    h.clock.advance(2000); // past 24 h since the last success
    const s3 = await h.request(path);
    expect(s3.status).toBe(502);
    expect((await s3.json()).error.code).toBe('UPSTREAM_STATUS');
  });

  it('shows stale state and the last error in inspect', async () => {
    let fail = false;
    const h = harness(() => (fail ? { throws: true } : text(ACCEPTANCE)));
    const token = recipeToken();
    await h.request(`/r/v1/${token}/inspect.json`);
    fail = true;
    h.clock.advance(FRESH + 1);
    const body = await (await h.request(`/r/v1/${token}/inspect.json`)).json();
    expect(body.status).toMatchObject({ stale: true, cache: 'stale', lastError: { code: 'UPSTREAM_NETWORK' } });
  });

  it('an invalid new version does not replace the last good snapshot', async () => {
    let body = ACCEPTANCE;
    const h = harness(() => text(body));
    const path = providerPath(recipeToken(), 'DIRECT');
    const good = await (await h.request(path)).text();
    body = 'rules:\n  - MATCH,DIRECT\n';
    h.clock.advance(FRESH + 1);
    const res = await h.request(path);
    expect(res.headers.get('x-result-stale')).toBe('true');
    expect(res.headers.get('x-last-error')).toBe('SOURCE_INVALID');
    expect(await res.text()).toBe(good);
  });

  it('does not cache errors as results', async () => {
    let fail = true;
    const h = harness(() => (fail ? { status: 503 } : text(ACCEPTANCE)));
    const path = providerPath(recipeToken(), 'DIRECT');
    expect((await h.request(path)).status).toBe(502);
    fail = false;
    h.clock.advance(6000); // past the failure backoff
    const res = await h.request(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('direct.example');
  });

  it('backs off after a failure instead of hammering the upstream', async () => {
    const h = harness(() => ({ status: 500 }));
    const path = providerPath(recipeToken(), 'DIRECT');
    await h.request(path);
    await h.request(path);
    await h.request(path);
    expect(h.calls).toHaveLength(1);
  });

  it('coalesces concurrent requests and never exposes partial results', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async () => {
      await gate;
      return text(ACCEPTANCE);
    });
    const token = recipeToken();
    const pending = [
      ...['DIRECT', '示例代理', '默认代理', 'DIRECT', '示例代理'].map((t) => h.request(providerPath(token, t))),
      h.request(`/r/v1/${token}/override.yaml`),
    ];
    release();
    const results = await Promise.all(pending);
    expect(h.calls).toHaveLength(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const counts = results.slice(0, 5).map((r) => r.headers.get('x-rule-count'));
    expect(counts).toEqual(['3', '3', '1', '3', '3']);
  });

  it('uses the Cache API store when memory is empty and survives its absence', async () => {
    const cache = new FakeCache();
    const h1 = harness(() => text(ACCEPTANCE), { cache });
    const path = providerPath(recipeToken(), 'DIRECT');
    await h1.request(path);
    expect(cache.store.size).toBe(1);

    // A new isolate (fresh memory) with the same Cache API contents.
    const h2 = harness(() => ({ status: 500 }), { cache });
    const res = await h2.request(path);
    expect(res.status).toBe(200);
    expect(h2.calls).toHaveLength(0);

    // Evicted from both layers: must refetch; failure is an error, not empty.
    cache.store.clear();
    const h3 = harness(() => ({ status: 500 }), { cache });
    expect((await h3.request(path)).status).toBe(502);
  });

  it('works when the Cache API is unavailable or failing', async () => {
    const h1 = harness(() => text(ACCEPTANCE), { cache: 'throw' });
    expect((await h1.request(providerPath(recipeToken(), 'DIRECT'))).status).toBe(200);
    const broken = new FakeCache();
    broken.broken = true;
    const h2 = harness(() => text(ACCEPTANCE), { cache: broken });
    expect((await h2.request(providerPath(recipeToken(), 'DIRECT'))).status).toBe(200);
  });

  it('never stores failed results in the Cache API', async () => {
    const cache = new FakeCache();
    const h = harness(() => text('MATCH,DIRECT\n'), { cache });
    expect((await h.request(providerPath(recipeToken(), 'DIRECT'))).status).toBe(422);
    expect(cache.store.size).toBe(0);
  });

  it('keys the cache by source and format, not by recipe options', async () => {
    const h = harness(() => text(ACCEPTANCE));
    await h.request(providerPath(recipeToken({ interval: 600 }), 'DIRECT'));
    await h.request(providerPath(recipeToken({ interval: 7200 }), 'DIRECT'));
    expect(h.calls).toHaveLength(1);
    await h.request(providerPath(recipeToken({ source: { url: SOURCE_URL, format: 'yaml' } }), 'DIRECT'));
    expect(h.calls).toHaveLength(2);
  });
});

describe('privacy', () => {
  it('logs no source URLs, tokens or rule content', async () => {
    const h = harness(() => ({ status: 500 }));
    const token = recipeToken();
    await h.request(providerPath(token, 'DIRECT'));
    const h2 = harness(() => text(ACCEPTANCE));
    await h2.request(providerPath(token, 'DIRECT'));
    const all = [...h.logs, ...h2.logs].join('\n');
    expect(all).not.toContain('githubusercontent');
    expect(all).not.toContain(token.slice(0, 20));
    expect(all).not.toContain('direct.example');
    expect(all.length).toBeGreaterThan(0);
  });
});
