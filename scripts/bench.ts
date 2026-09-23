/**
 * Local micro-benchmark. It measures wall time in the current Node process
 * only: cold compilation of N rules and hot (cached-snapshot) responses of
 * the real Worker app. These numbers are NOT Cloudflare Workers CPU time and
 * say nothing about Workers Free quotas; see docs/deployment.md.
 */
import { compile, encodeRecipe, encodeTargetToken } from '@ruhomo/core';
import { createApp } from '../apps/worker/src/app.ts';

function makeRules(n: number): string {
  const targets = ['DIRECT', '示例代理', '默认代理', 'Streaming', 'AI'];
  const lines: string[] = ['rules:'];
  for (let i = 0; i < n; i++) {
    const t = targets[i % targets.length];
    switch (i % 5) {
      case 0:
        lines.push(`  - DOMAIN-SUFFIX,host${i}.example.com,${t}`);
        break;
      case 1:
        lines.push(`  - IP-CIDR,10.${(i >> 8) & 255}.${i & 255}.0/24,${t},no-resolve`);
        break;
      case 2:
        lines.push(`  - DOMAIN-REGEX,^h${i}[0-9]{1,3}\\.example\\.net$,${t}`);
        break;
      case 3:
        lines.push(`  - AND,((DOMAIN-SUFFIX,a${i}.example),(DST-PORT,443)),${t}`);
        break;
      default:
        lines.push(`  - DOMAIN-KEYWORD,kw${i},${t}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function time(fn: () => void, runs: number): { median: number; p95: number } {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(runs / 2)]!, p95: samples[Math.floor(runs * 0.95)]! };
}

async function timeAsync(fn: () => Promise<unknown>, runs: number): Promise<{ median: number; p95: number }> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(runs / 2)]!, p95: samples[Math.floor(runs * 0.95)]! };
}

const SOURCE = 'https://raw.githubusercontent.com/bench/bench/main/rules.yaml';
console.log('# ruhomo local benchmark — Node.js wall time (not Workers CPU time)');
console.log('| rules | source KiB | cold compile median ms | p95 ms | hot provider median ms | hot override.js median ms |');
console.log('|---:|---:|---:|---:|---:|---:|');
for (const n of [100, 1000, 5000]) {
  const text = makeRules(n);
  for (let i = 0; i < 3; i++) compile(text); // warm up the JIT
  const cold = time(() => {
    const r = compile(text);
    if (!r.ok) throw new Error('compile failed');
  }, 20);

  const app = createApp({
    upstreamFetch: (async () => new Response(text, { headers: { 'content-type': 'text/plain' } })) as typeof fetch,
    log: () => {},
  });
  const env = { PUBLIC_BASE_URL: 'https://bench.example', CACHE_FRESH_SECONDS: '3600' };
  const token = encodeRecipe({ source: { url: SOURCE } });
  const provider = `/r/v1/${token}/providers/${encodeTargetToken('DIRECT')}.list`;
  await app.request(provider, {}, env); // populate the snapshot cache
  const hotProvider = await timeAsync(async () => (await app.request(provider, {}, env)).arrayBuffer(), 50);
  const hotJs = await timeAsync(async () => (await app.request(`/r/v1/${token}/override.js`, {}, env)).arrayBuffer(), 50);
  console.log(
    `| ${n} | ${(new TextEncoder().encode(text).length / 1024).toFixed(1)} | ${cold.median.toFixed(2)} | ${cold.p95.toFixed(2)} | ${hotProvider.median.toFixed(3)} | ${hotJs.median.toFixed(3)} |`,
  );
}
