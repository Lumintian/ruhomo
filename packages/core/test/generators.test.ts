import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  buildInlineIntegration,
  buildRemoteIntegration,
  compile,
  decodeTargetToken,
  generateJsOverride,
  generateYamlOverride,
  normalizeRecipe,
  orderTargets,
  providerRulesOf,
  recipeLinks,
} from '../src/index.ts';
import { applyYamlPatch, loadMain } from './helpers/override-host.ts';

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8');
const BASE = 'https://ruhomo.example.net';
const recipe = normalizeRecipe({ source: { url: 'https://raw.githubusercontent.com/example/repo/main/rules.yaml' } });

function remoteIR(text: string, r = recipe, base = BASE) {
  const c = compile(text);
  if (!c.ok) throw new Error('compile failed');
  const ordered = orderTargets(c.snapshot, r.targetOrder).targets.map((t) => t.target);
  return buildRemoteIntegration({ recipe: r, baseUrl: base, targets: ordered });
}

function originalConfig() {
  return {
    'mixed-port': 7890,
    proxies: [{ name: 'node-a', type: 'ss', server: '198.51.100.1', port: 443, cipher: 'aes-128-gcm', password: 'x' }],
    'proxy-groups': [
      { name: '示例代理', type: 'select', proxies: ['node-a', 'DIRECT'] },
      { name: '默认代理', type: 'select', proxies: ['示例代理', 'DIRECT'] },
    ],
    'rule-providers': {
      other: { type: 'http', behavior: 'domain', url: 'https://example.com/other.yaml', path: './other.yaml', interval: 86400 },
    },
    rules: ['RULE-SET,other,示例代理', 'GEOIP,CN,DIRECT', 'MATCH,默认代理'],
  };
}

describe('remote YAML override', () => {
  const ir = remoteIR(fixture('acceptance.yaml'));
  const yaml = generateYamlOverride(ir);
  const doc = parseYaml(yaml) as Record<string, unknown>;

  it('uses rule-providers and +rules exactly', () => {
    expect(Object.keys(doc)).toEqual(['rule-providers', '+rules']);
    expect(yaml).not.toMatch(/^\+rule-providers:/m);
    expect(yaml).not.toMatch(/^rules\+?:/m);
  });

  it('generates http classical text providers with safe unique paths', () => {
    const providers = doc['rule-providers'] as Record<string, Record<string, unknown>>;
    const names = Object.keys(providers);
    expect(names).toHaveLength(3);
    const paths = names.map((n) => providers[n]!.path);
    expect(new Set(paths).size).toBe(3);
    for (const n of names) {
      const p = providers[n]!;
      expect(n).toMatch(/^mrp-[0-9a-f]{32}-[0-9a-f]{32}$/);
      expect(p).toMatchObject({ type: 'http', behavior: 'classical', format: 'text', interval: 3600 });
      expect(p.path).toBe(`./rule-providers/${n}.list`);
      expect(p).not.toHaveProperty('proxy');
      expect(String(p.url)).toMatch(/^https:\/\/ruhomo\.example\.net\/r\/v1\/[A-Za-z0-9_-]+\/providers\/[A-Za-z0-9_-]+\.list$/);
    }
    const targets = names.map((n) => decodeTargetToken(String(providers[n]!.url).split('/providers/')[1]!.replace(/\.list$/, '')));
    expect(targets).toEqual(['DIRECT', '示例代理', '默认代理']);
  });

  it('orders RULE-SET entries DIRECT, 示例代理, 默认代理', () => {
    const rules = doc['+rules'] as string[];
    expect(rules.map((r) => r.split(',')[2])).toEqual(['DIRECT', '示例代理', '默认代理']);
    expect(rules.every((r) => r.startsWith('RULE-SET,mrp-'))).toBe(true);
  });

  it('contains no payloads, counts, hashes or timestamps', () => {
    expect(yaml).not.toContain('direct.example');
    expect(yaml).not.toContain('payload');
    expect(yaml).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(yaml).toContain('not a complete Mihomo config');
  });

  it('preserves the original config and appends original rules after RULE-SET', () => {
    const before = originalConfig();
    const merged = applyYamlPatch(structuredClone(before), doc);
    expect(merged.rules).toEqual([...(doc['+rules'] as string[]), ...before.rules]);
    expect((merged['rule-providers'] as Record<string, unknown>).other).toEqual(before['rule-providers'].other);
    expect(merged.proxies).toEqual(before.proxies);
    expect(merged['proxy-groups']).toEqual(before['proxy-groups']);
    expect(merged['mixed-port']).toBe(7890);
  });
});

describe('override stability', () => {
  it('does not change when only rules inside existing targets change', () => {
    const a = remoteIR('DOMAIN,a.com,A\nDOMAIN,b.com,B\n');
    const b = remoteIR('DOMAIN,x.com,A\nDOMAIN,y.com,A\nDOMAIN,z.com,B\nIP-CIDR,1.1.1.0/24,B,no-resolve\n');
    expect(generateYamlOverride(b)).toBe(generateYamlOverride(a));
    expect(generateJsOverride(b)).toBe(generateJsOverride(a));
  });

  it('keeps provider names and URLs when a target gains or loses rules', () => {
    const a = remoteIR('DOMAIN,a.com,A\nDOMAIN,b.com,B\n');
    const b = remoteIR('DOMAIN,b.com,B\nDOMAIN,c.com,C\n');
    const pa = a.providers.find((p) => p.target === 'B')!;
    const pb = b.providers.find((p) => p.target === 'B')!;
    expect(pb).toEqual(pa);
  });

  it('changes names when the recipe changes', () => {
    const other = normalizeRecipe({ ...recipe, interval: 7200 });
    const a = remoteIR('DOMAIN,a.com,A\n');
    const b = remoteIR('DOMAIN,a.com,A\n', other);
    expect(b.providers[0]!.name).not.toBe(a.providers[0]!.name);
    expect(b.providers[0]!.definition).toMatchObject({ interval: 7200 });
  });

  it('follows targetOrder in the override', () => {
    const r = normalizeRecipe({ ...recipe, targetOrder: ['默认代理'] });
    const ir = remoteIR(fixture('acceptance.yaml'), r);
    expect(ir.rules.map((x) => x.split(',')[2])).toEqual(['默认代理', 'DIRECT', '示例代理']);
  });

  it('normalizes the base URL consistently', () => {
    const a = remoteIR('DOMAIN,a.com,A\n', recipe, 'https://ruhomo.example.net/');
    const b = remoteIR('DOMAIN,a.com,A\n', recipe, 'https://ruhomo.example.net');
    expect(generateYamlOverride(a)).toBe(generateYamlOverride(b));
    const c = remoteIR('DOMAIN,a.com,A\n', recipe, 'https://example.net/tools/ruhomo//');
    expect((c.providers[0]!.definition as { url: string }).url).toMatch(/^https:\/\/example\.net\/tools\/ruhomo\/r\/v1\//);
    expect(recipeLinks('https://example.net/x/', 'TOKEN').overrideJs).toBe('https://example.net/x/r/v1/TOKEN/override.js');
  });

  it('refuses to emit over-long links', () => {
    expect(() => recipeLinks(`https://example.net/${'p'.repeat(8200)}`, 'TOKEN')).toThrow(/8192/);
  });
});

describe('JavaScript override', () => {
  const ir = remoteIR(fixture('acceptance.yaml'));
  const js = generateJsOverride(ir);
  const main = loadMain(js);

  it('is a plain function main(config) without imports or I/O', () => {
    expect(js).toMatch(/^function main\(config\) \{$/m);
    expect(js).not.toMatch(/\bimport\b|\brequire\(|\bfetch\(|process\.|globalThis|XMLHttpRequest/);
  });

  it('is not mistaken for a YAML patch by override hosts', () => {
    let parsed: unknown;
    try {
      parsed = parseYaml(js);
    } catch {
      parsed = 'error';
    }
    expect(typeof parsed === 'object' && parsed !== null).toBe(false);
  });

  it('matches the YAML result on a clean config', () => {
    const viaJs = main(originalConfig());
    const viaYaml = applyYamlPatch(originalConfig(), parseYaml(generateYamlOverride(ir)) as Record<string, unknown>);
    expect(viaJs).toEqual(viaYaml);
  });

  it('is idempotent', () => {
    const once = main(originalConfig());
    const twice = main(main(originalConfig()));
    expect(twice).toEqual(once);
    expect((twice as { rules: string[] }).rules.filter((r) => r.startsWith('RULE-SET,mrp-'))).toHaveLength(3);
  });

  it('replaces entries of the same recipe that are no longer needed', () => {
    const old = loadMain(generateJsOverride(remoteIR('DOMAIN,a.com,Gone\nDOMAIN,b.com,DIRECT\n')));
    const updated = main(old(originalConfig())) as { rules: string[]; 'rule-providers': Record<string, unknown> };
    const fresh = main(originalConfig()) as typeof updated;
    expect(updated).toEqual(fresh);
    expect(updated.rules.some((r) => r.endsWith(',Gone'))).toBe(false);
  });

  it('never touches other recipes, other providers or original rules', () => {
    const otherRecipe = normalizeRecipe({ source: { url: 'https://raw.githubusercontent.com/someone/else/main/r.txt' } });
    const other = loadMain(generateJsOverride(remoteIR('DOMAIN,z.com,DIRECT\n', otherRecipe)));
    const withOther = other(originalConfig()) as { rules: string[]; 'rule-providers': Record<string, unknown> };
    const result = main(structuredClone(withOther)) as typeof withOther;
    for (const [name, def] of Object.entries(withOther['rule-providers'])) {
      expect(result['rule-providers'][name]).toEqual(def);
    }
    for (const rule of withOther.rules) expect(result.rules).toContain(rule);
    expect(result.rules.slice(3)).toEqual(withOther.rules);
    // original ordinary rules and user RULE-SET entries keep their order
    expect(result.rules.slice(-3)).toEqual(originalConfig().rules);
  });

  it('does not delete rules by target name', () => {
    const cfg = originalConfig();
    cfg.rules.unshift('DOMAIN-SUFFIX,proxy-one.example,示例代理');
    const out = main(cfg) as { rules: string[] };
    expect(out.rules).toContain('DOMAIN-SUFFIX,proxy-one.example,示例代理');
  });

  it('initializes missing fields', () => {
    const out = main({ proxies: [] }) as { rules: string[]; 'rule-providers': Record<string, unknown> };
    expect(out.rules).toHaveLength(3);
    expect(Object.keys(out['rule-providers'])).toHaveLength(3);
    expect(main({ rules: null, 'rule-providers': null })).toMatchObject({ rules: expect.any(Array) });
  });

  it('fails before mutating on unexpected shapes', () => {
    const bad1 = { rules: 'MATCH,DIRECT', 'rule-providers': {} };
    expect(() => main(bad1)).toThrow(/"rules" must be a list/);
    expect(bad1).toEqual({ rules: 'MATCH,DIRECT', 'rule-providers': {} });
    const bad2 = { rules: [], 'rule-providers': [] };
    expect(() => main(bad2)).toThrow(/"rule-providers" must be a mapping/);
    expect(bad2).toEqual({ rules: [], 'rule-providers': [] });
    expect(() => main(null)).toThrow();
  });

  it('reports a conflict for a foreign provider using the namespace', () => {
    const cfg = originalConfig() as ReturnType<typeof originalConfig> & { 'rule-providers': Record<string, unknown> };
    const name = ir.providers[0]!.name;
    cfg['rule-providers'][name] = { type: 'http', behavior: 'domain', url: 'https://elsewhere.example/x.yaml', path: './x.yaml' };
    const snapshot = structuredClone(cfg);
    expect(() => main(cfg)).toThrow(/refusing to overwrite/);
    expect(cfg).toEqual(snapshot);
  });

  it('is safe against prototype pollution keys in the config', () => {
    const cfg = JSON.parse('{"rule-providers":{"__proto__":{"polluted":true}},"rules":[]}');
    main(cfg);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(cfg['rule-providers'], '__proto__')).toBe(true);
  });
});

describe('string injection', () => {
  const nasty = `x"; globalThis.pwned = 1; //</script>${String.fromCharCode(0x2028)}'\``;
  const hostile = [
    'DOMAIN,a.com,"quoted"',
    "DOMAIN,b.com,it's",
    'DOMAIN,c.com,{{template}}',
    'DOMAIN,d.com,: yaml: colon #hash',
    'DOMAIN,e.com,- dash',
    'DOMAIN,f.com,*alias',
    'DOMAIN,g.com,!tag',
    'DOMAIN,h.com,\\backslash\\',
  ];

  it('escapes targets in JS output', () => {
    const r = compile(`DOMAIN,n.com,${nasty}\n`);
    expect(r.ok).toBe(false); // U+2028 is refused as a control character
    const c = compile(`DOMAIN,n.com,${nasty.replace(String.fromCharCode(0x2028), '')}\n${hostile.join('\n')}\n`);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const ir = buildRemoteIntegration({ recipe, baseUrl: BASE, targets: c.snapshot.targets.map((t) => t.target) });
    const js = generateJsOverride(ir);
    expect(js).not.toContain('</script>');
    const out = loadMain(js)({}) as { rules: string[] };
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
    expect(out.rules.map((x) => x.split(',').slice(2).join(','))).toEqual(c.snapshot.targets.map((t) => t.target));
  });

  it('round-trips hostile targets through YAML', () => {
    const c = compile(`${hostile.join('\n')}\n`);
    if (!c.ok) throw new Error('compile failed');
    const ir = buildRemoteIntegration({ recipe, baseUrl: BASE, targets: c.snapshot.targets.map((t) => t.target) });
    const doc = parseYaml(generateYamlOverride(ir)) as { '+rules': string[] };
    expect(doc['+rules'].map((x) => x.split(',').slice(2).join(','))).toEqual(c.snapshot.targets.map((t) => t.target));
  });
});

describe('inline (static) export', () => {
  const c = compile(fixture('complex.txt'));
  if (!c.ok) throw new Error('compile failed');
  const groups = orderTargets(c.snapshot).targets.map((t) => ({ target: t.target, providerRules: providerRulesOf(t) }));
  const ir = buildInlineIntegration(groups);

  it('uses inline classical payloads and no URLs', () => {
    const yaml = generateYamlOverride(ir);
    const doc = parseYaml(yaml) as { 'rule-providers': Record<string, Record<string, unknown>>; '+rules': string[] };
    for (const p of Object.values(doc['rule-providers'])) {
      expect(p.type).toBe('inline');
      expect(p.behavior).toBe('classical');
      expect(Array.isArray(p.payload)).toBe(true);
      expect(p).not.toHaveProperty('url');
    }
    expect(yaml).toContain('静态导出');
    expect(yaml).not.toContain('http');
    const stable = Object.values(doc['rule-providers']).find((p) =>
      (p.payload as string[]).includes('DOMAIN-REGEX,^foo[0-9]{1,3}\\.example\\.com$'),
    );
    expect(stable).toBeDefined();
  });

  it('JS static export is idempotent and matches YAML on a clean config', () => {
    const js = generateJsOverride(ir);
    expect(js).toContain('静态导出');
    const main = loadMain(js);
    const viaYaml = applyYamlPatch(originalConfig(), parseYaml(generateYamlOverride(ir)) as Record<string, unknown>);
    expect(main(originalConfig())).toEqual(viaYaml);
    expect(main(main(originalConfig()))).toEqual(viaYaml);
  });
});
