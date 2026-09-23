/**
 * Real-kernel integration: the pinned Mihomo binary loads the HTTP
 * classical/text providers produced by the real Worker app over loopback.
 * Everything runs in temporary directories with isolated configs; no user
 * kernel, controller or infrastructure is touched. The controller calls
 * below target only this isolated test kernel.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeRecipe, parseRule } from '@ruhomo/core';
import { applyYamlPatch, loadMain } from '../../packages/core/test/helpers/override-host.ts';
import type { Kernel, ProviderInfo } from './harness.ts';
import { MIHOMO_BIN, SOURCE_URL, baseConfig, startKernel, startService, testConfig, waitFor } from './harness.ts';

const IS_LINUX = process.platform === 'linux';

const RULES = [
  'DOMAIN-SUFFIX,direct.example,DIRECT',
  'DOMAIN-SUFFIX,proxy-one.example,示例代理',
  'IP-CIDR,203.0.113.0/24,示例代理,no-resolve',
  'IP-CIDR6,2001:db8::/32,示例代理,no-resolve',
  'DOMAIN-REGEX,^foo[0-9]{1,3}\\.example\\.com$,示例代理',
  'AND,((DOMAIN-SUFFIX,example.com),(DST-PORT,443)),示例代理',
  'OR,((IP-CIDR,198.51.100.0/24,no-resolve),(NOT,((NETWORK,tcp)))),默认代理',
  'AND,((DOMAIN-REGEX,^a{1,3}\\.example$),(NETWORK,udp)),默认代理',
  'DOMAIN-KEYWORD,demo-keyword,默认代理',
  'DST-PORT,22/80-443,DIRECT',
  'PROCESS-PATH,C:\\Windows\\System32\\curl.exe,DIRECT',
  'IN-TYPE,SOCKS/HTTP,DIRECT',
  'DSCP,46,DIRECT',
  ...(IS_LINUX ? ['UID,1000,DIRECT'] : []),
];
const INITIAL = `${RULES.join('\n')}\n`;
const EXPECTED = { DIRECT: IS_LINUX ? 6 : 5, 示例代理: 5, 默认代理: 3 };

const upstream = { status: 200, body: INITIAL };
let service: Awaited<ReturnType<typeof startService>>;
const token = encodeRecipe({ source: { url: SOURCE_URL }, interval: 3600 });

async function get(path: string) {
  const res = await fetch(`${service.base}${path}`);
  return { status: res.status, text: await res.text() };
}

async function providers(k: Kernel): Promise<Record<string, ProviderInfo>> {
  const r = await k.api<{ providers: Record<string, ProviderInfo> }>('/providers/rules');
  return r.body.providers;
}

async function countsByTarget(k: Kernel, names: Record<string, string>) {
  const p = await providers(k);
  return Object.fromEntries(Object.entries(names).map(([target, name]) => [target, p[name]?.ruleCount]));
}

function parseErrors(logs: string): string[] {
  return logs.split('\n').filter((l) => /parse classical rule|unsupported rule type|format error/i.test(l));
}

beforeAll(async () => {
  const v = spawnSync(MIHOMO_BIN, ['-v'], { encoding: 'utf8' });
  expect(v.stdout).toContain('v1.19.31');
  service = await startService(upstream);
});

afterAll(async () => {
  await service?.close();
});

describe('JS override applied to an isolated config', () => {
  let kernel: Kernel;
  let names: Record<string, string>;

  beforeAll(async () => {
    const js = await get(`/r/v1/${token}/override.js`);
    expect(js.status).toBe(200);
    const config = loadMain(js.text)(baseConfig()) as Record<string, unknown>;
    const providersCfg = config['rule-providers'] as Record<string, { url: string }>;
    names = {};
    for (const rule of (config.rules as string[]).slice(0, 3)) {
      const [, name, target] = rule.split(',');
      names[target!] = name!;
      expect(providersCfg[name!]!.url.startsWith(`${service.base}/r/v1/${token}/providers/`)).toBe(true);
    }
    const check = testConfig(config);
    expect(check.ok, check.output).toBe(true);
    kernel = await startKernel(config);
  });

  afterAll(async () => {
    await kernel?.stop();
  });

  it('actually loads every generated provider with the expected rule count', async () => {
    const counts = await waitFor(async () => {
      const c = await countsByTarget(kernel, names);
      return Object.values(c).every((n) => typeof n === 'number' && n > 0) ? c : undefined;
    }, 'initial provider load');
    expect(counts).toEqual(EXPECTED);
    const p = await providers(kernel);
    for (const name of Object.values(names)) {
      expect(p[name]).toMatchObject({ vehicleType: 'HTTP', behavior: 'Classical', format: 'TextRule' });
    }
    // The kernel only warns and skips bad lines, so the logs must be clean too.
    expect(parseErrors(kernel.logs())).toEqual([]);
  });

  it('prepends RULE-SET entries in target order and keeps original rules after them', async () => {
    const r = await kernel.api<{ rules: { type: string; payload: string; proxy: string }[] }>('/rules');
    const rules = r.body.rules;
    expect(rules.slice(0, 3).map((x) => [x.type, x.payload, x.proxy])).toEqual([
      ['RuleSet', names.DIRECT, 'DIRECT'],
      ['RuleSet', names['示例代理'], '示例代理'],
      ['RuleSet', names['默认代理'], '默认代理'],
    ]);
    expect(rules.slice(3).map((x) => [x.type, x.payload, x.proxy])).toEqual([
      ['DomainSuffix', 'original.example', 'DIRECT'],
      ['Match', '', '默认代理'],
    ]);
  });

  it('picks up rule changes and emptied targets without restarting the kernel', async () => {
    const pid = kernel.pid;
    upstream.body = 'DOMAIN-SUFFIX,direct.example,DIRECT\nDOMAIN-SUFFIX,new.example,DIRECT\nDOMAIN-KEYWORD,demo-keyword,默认代理\n';
    for (const name of Object.values(names)) {
      expect((await kernel.api(`/providers/rules/${name}`, { method: 'PUT' })).status).toBe(204);
    }
    expect(await countsByTarget(kernel, names)).toEqual({ DIRECT: 2, 示例代理: 0, 默认代理: 1 });
    expect((await get(`/r/v1/${token}/providers/${Buffer.from('示例代理').toString('base64url')}.list`)).text).toBe('# empty\n');
    expect(kernel.pid).toBe(pid);
    expect((await kernel.api('/version')).status).toBe(200);
    expect(parseErrors(kernel.logs())).toEqual([]);
  });

  it('does not clear rules when the source fails', async () => {
    upstream.status = 500;
    const res = await kernel.api(`/providers/rules/${names.DIRECT}`, { method: 'PUT' });
    expect(res.status).not.toBe(204);
    expect(await countsByTarget(kernel, names)).toEqual({ DIRECT: 2, 示例代理: 0, 默认代理: 1 });
  });

  it('refills an emptied target after the source recovers', async () => {
    upstream.status = 200;
    upstream.body = INITIAL;
    await new Promise((r) => setTimeout(r, 5200)); // service failure backoff
    for (const name of Object.values(names)) {
      expect((await kernel.api(`/providers/rules/${name}`, { method: 'PUT' })).status).toBe(204);
    }
    expect(await countsByTarget(kernel, names)).toEqual(EXPECTED);
  });
});

describe('YAML override applied to an isolated config', () => {
  it('loads the same providers with the same counts', async () => {
    upstream.status = 200;
    upstream.body = INITIAL;
    const yaml = await get(`/r/v1/${token}/override.yaml`);
    const config = applyYamlPatch(baseConfig(), parseYaml(yaml.text) as Record<string, unknown>);
    const check = testConfig(config);
    expect(check.ok, check.output).toBe(true);
    const kernel = await startKernel(config);
    try {
      const names = Object.fromEntries(
        (config.rules as string[]).slice(0, 3).map((r) => {
          const [, name, target] = r.split(',');
          return [target!, name!];
        }),
      );
      const counts = await waitFor(async () => {
        const c = await countsByTarget(kernel, names);
        return Object.values(c).every((n) => typeof n === 'number' && n > 0) ? c : undefined;
      }, 'YAML provider load');
      expect(counts).toEqual(EXPECTED);
      expect(parseErrors(kernel.logs())).toEqual([]);
    } finally {
      await kernel.stop();
    }
  });
});

/**
 * Kernel acceptance probe for provider lines. Lines this project accepts
 * must load; lines it rejects (or only structurally checks) are recorded to
 * document where the project is stricter than, or cannot vouch for, the
 * kernel. Results are written to .cache/compat-probe.json.
 */
describe('kernel acceptance probe', () => {
  const PROBES: { provider: string; rule: string; category: 'accepted' | 'rejected' | 'regex-unvalidated' }[] = [
    { provider: 'DOMAIN-REGEX,(?>foo|foob)ar', rule: 'DOMAIN-REGEX,(?>foo|foob)ar,X', category: 'accepted' },
    { provider: 'PROCESS-NAME-REGEX,(?<name>chrome)\\.exe', rule: 'PROCESS-NAME-REGEX,(?<name>chrome)\\.exe,X', category: 'accepted' },
    { provider: 'IP-CIDR,203.0.113.7/24', rule: 'IP-CIDR,203.0.113.7/24,X', category: 'accepted' },
    { provider: 'IP-CIDR6,::ffff:1.2.3.4/128', rule: 'IP-CIDR6,::ffff:1.2.3.4/128,X', category: 'accepted' },
    { provider: 'SRC-IP-CIDR,192.168.0.0/16', rule: 'SRC-IP-CIDR,192.168.0.0/16,X', category: 'accepted' },
    { provider: 'DST-PORT,[1000-2000]', rule: 'DST-PORT,[1000-2000],X', category: 'accepted' },
    { provider: 'DSCP,*', rule: 'DSCP,*,X', category: 'accepted' },
    { provider: 'IN-TYPE,socks', rule: 'IN-TYPE,socks,X', category: 'accepted' },
    { provider: 'NETWORK,UDP', rule: 'NETWORK,UDP,X', category: 'accepted' },
    { provider: 'DOMAIN-WILDCARD,*.example.com', rule: 'DOMAIN-WILDCARD,*.example.com,X', category: 'accepted' },
    { provider: 'PROCESS-NAME-WILDCARD,*chrome*', rule: 'PROCESS-NAME-WILDCARD,*chrome*,X', category: 'accepted' },
    { provider: 'IN-USER,alice/bob', rule: 'IN-USER,alice/bob,X', category: 'accepted' },
    { provider: 'NOT,((DOMAIN,a.com))', rule: 'NOT,((DOMAIN,a.com)),X', category: 'accepted' },
    { provider: 'AND,((DOMAIN-REGEX,^(a|b)\\.com$),(DST-PORT,443))', rule: 'AND,((DOMAIN-REGEX,^(a|b)\\.com$),(DST-PORT,443)),X', category: 'accepted' },
    { provider: 'OR,((AND,((DOMAIN,a.com),(NETWORK,tcp))),(IP-CIDR,10.0.0.0/8,no-resolve))', rule: 'OR,((AND,((DOMAIN,a.com),(NETWORK,tcp))),(IP-CIDR,10.0.0.0/8,no-resolve)),X', category: 'accepted' },
    { provider: 'IP-CIDR,1.2.3.4/024', rule: 'IP-CIDR,1.2.3.4/024,X', category: 'rejected' },
    { provider: 'IP-CIDR,01.2.3.4/24', rule: 'IP-CIDR,01.2.3.4/24,X', category: 'rejected' },
    { provider: 'DST-PORT,70000', rule: 'DST-PORT,70000,X', category: 'rejected' },
    { provider: 'DSCP,256', rule: 'DSCP,256,X', category: 'rejected' },
    { provider: 'DOMAIN,a.com,extra', rule: 'DOMAIN,a.com,X,extra', category: 'rejected' },
    { provider: 'IP-CIDR,1.1.1.0/24,No-Resolve', rule: 'IP-CIDR,1.1.1.0/24,X,No-Resolve', category: 'rejected' },
    { provider: 'AND,(DOMAIN,a.com),(DST-PORT,443)', rule: 'AND,(DOMAIN,a.com),(DST-PORT,443),X', category: 'rejected' },
    { provider: 'AND,((DOMAIN,a.com)junk(DST-PORT,443))', rule: 'AND,((DOMAIN,a.com)junk(DST-PORT,443)),X', category: 'rejected' },
    { provider: 'AND,((DOMAIN,a.com,DIRECT))', rule: 'AND,((DOMAIN,a.com,DIRECT)),X', category: 'rejected' },
    { provider: 'AND,()', rule: 'AND,(),X', category: 'rejected' },
    { provider: 'DOMAIN-REGEX,[', rule: 'DOMAIN-REGEX,[,X', category: 'regex-unvalidated' },
    { provider: 'DOMAIN-REGEX,(?<=a)b', rule: 'DOMAIN-REGEX,(?<=a)b,X', category: 'regex-unvalidated' },
  ];

  it('loads every line this project accepts and records the rest', async () => {
    const config = baseConfig();
    const ruleProviders: Record<string, unknown> = {};
    const probeDir = join('probe');
    const kernelFiles: { name: string; content: string }[] = [];
    PROBES.forEach((p, i) => {
      const name = `probe-${i}`;
      kernelFiles.push({ name, content: `${p.provider}\n` });
      ruleProviders[name] = { type: 'file', behavior: 'classical', format: 'text', path: `./${probeDir}/${name}.list` };
    });
    config['rule-providers'] = ruleProviders;
    config.rules = [...PROBES.map((_, i) => `RULE-SET,probe-${i},DIRECT`), 'MATCH,DIRECT'];
    // startKernel creates the home dir; write provider files first via a pre-created layout.
    const kernel = await startKernelWithFiles(config, kernelFiles, probeDir);
    try {
      const p = await providers(kernel);
      const report = PROBES.map((probe, i) => ({
        ...probe,
        ruhomoAccepts: parseRule({ raw: probe.rule, line: 1, column: 1, sourceIndex: 0 }).rule !== undefined,
        kernelRuleCount: p[`probe-${i}`]?.ruleCount,
      }));
      mkdirSync('.cache', { recursive: true });
      writeFileSync('.cache/compat-probe.json', `${JSON.stringify(report, null, 2)}\n`);
      console.table(report.map((r) => ({ line: r.provider, category: r.category, ruhomo: r.ruhomoAccepts, kernel: r.kernelRuleCount })));
      for (const r of report) {
        if (r.category === 'accepted') {
          expect(r.ruhomoAccepts, r.provider).toBe(true);
          expect(r.kernelRuleCount, r.provider).toBe(1);
        } else if (r.category === 'rejected') {
          expect(r.ruhomoAccepts, r.provider).toBe(false);
        } else {
          expect(r.ruhomoAccepts, r.provider).toBe(true);
        }
      }
    } finally {
      await kernel.stop();
    }
  });
});

async function startKernelWithFiles(config: Record<string, unknown>, files: { name: string; content: string }[], sub: string) {
  // Relative provider paths resolve against the kernel home. Provide the files
  // through inline-free absolute layout: start, write files, then reload them.
  const kernel = await startKernel(config);
  mkdirSync(join(kernel.dir, sub), { recursive: true });
  for (const f of files) writeFileSync(join(kernel.dir, sub, `${f.name}.list`), f.content);
  for (const f of files) await kernel.api(`/providers/rules/${f.name}`, { method: 'PUT' });
  return kernel;
}
