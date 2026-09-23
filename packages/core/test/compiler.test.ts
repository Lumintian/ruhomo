import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROVIDER_BODY, compile, orderTargets, providerRulesOf } from '../src/index.ts';

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8');

function mustCompile(text: string, format: 'auto' | 'yaml' | 'text' = 'auto') {
  const r = compile(text, format);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
  return r.snapshot;
}

describe('acceptance sample', () => {
  it.each(['acceptance.yaml', 'acceptance-sequence.yaml', 'acceptance.txt'])('%s groups by target', (name) => {
    const s = mustCompile(fixture(name));
    expect(s.targets.map((t) => [t.target, t.ruleCount])).toEqual([
      ['DIRECT', 3],
      ['示例代理', 3],
      ['默认代理', 1],
    ]);
    expect(s.targets[0]!.body).toBe(
      'DOMAIN-SUFFIX,direct.example\nDOMAIN-SUFFIX,mirror-one.example\nDOMAIN-SUFFIX,mirror-two.example\n',
    );
    expect(s.targets[1]!.body).toBe('DOMAIN-SUFFIX,proxy-one.example\nDOMAIN-SUFFIX,proxy-two.example\nDOMAIN-SUFFIX,proxy-three.example\n');
    expect(s.targets[2]!.body).toBe('DOMAIN-KEYWORD,demo-keyword\n');
    for (const t of s.targets) {
      expect(t.body).not.toContain(t.target);
      expect(t.body.endsWith('\n')).toBe(true);
      expect(t.body).not.toContain('\r');
    }
  });

  it('reports that grouping changed cross-target order', () => {
    const s = mustCompile(fixture('acceptance.yaml'));
    const { targets, diagnostics } = orderTargets(s);
    expect(targets.map((t) => t.target)).toEqual(['DIRECT', '示例代理', '默认代理']);
    expect(diagnostics.map((d) => d.code)).toEqual(['ORDER_CHANGED_BY_GROUPING']);
  });

  it('does not report reordering when groups are already contiguous', () => {
    const s = mustCompile('DOMAIN,a.com,A\nDOMAIN,b.com,A\nDOMAIN,c.com,B\n');
    expect(orderTargets(s).diagnostics).toEqual([]);
  });
});

describe('complex fixture', () => {
  it('compiles every rule class and keeps params', () => {
    const s = mustCompile(fixture('complex.txt'));
    const stable = s.targets.find((t) => t.target === '示例代理')!;
    expect(providerRulesOf(stable)).toEqual([
      'IP-CIDR,203.0.113.0/24,no-resolve',
      'IP-CIDR6,2001:db8::/32,no-resolve',
      'DOMAIN-REGEX,^foo[0-9]{1,3}\\.example\\.com$',
      'AND,((DOMAIN-SUFFIX,example.com),(DST-PORT,443))',
    ]);
    const fallback = s.targets.find((t) => t.target === '默认代理')!;
    expect(providerRulesOf(fallback)).toEqual([
      'DOMAIN-SUFFIX,例子.测试',
      'OR,((IP-CIDR,198.51.100.0/24,no-resolve),(NOT,((NETWORK,tcp))))',
    ]);
    expect(s.diagnostics.some((d) => d.code === 'REGEX_SEMANTICS_NOT_VALIDATED')).toBe(true);
  });
});

describe('failure semantics', () => {
  it('fails the whole compilation on any error and never returns partial groups', () => {
    const r = compile('DOMAIN,a.com,DIRECT\nMATCH,DIRECT\nDOMAIN,b.com,X\nFOO,bar,X\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.filter((d) => d.severity === 'error').map((d) => [d.code, d.line])).toEqual([
      ['FORBIDDEN_RULE_TYPE', 2],
      ['UNKNOWN_RULE_TYPE', 4],
    ]);
    expect(r).not.toHaveProperty('snapshot');
  });

  it('keeps warnings alongside errors for the preview', () => {
    const r = compile('GEOSITE,cn,DIRECT\nDOMAIN,a.com\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.map((d) => d.severity)).toEqual(['warning', 'error']);
  });

  it('limits the number of targets', () => {
    const text = Array.from({ length: 5 }, (_, i) => `DOMAIN,a${i}.com,T${i}`).join('\n');
    const r = compile(text, 'auto', { maxTargets: 4 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.map((d) => d.code)).toEqual(['TOO_MANY_TARGETS']);
  });

  it('distinguishes explicit empty from errors', () => {
    const empty = mustCompile('rules: []\n');
    expect(empty.targets).toEqual([]);
    expect(empty.explicitEmpty).toBe(true);
    expect(mustCompile('# mrp:empty\n').explicitEmpty).toBe(true);
    expect(compile('').ok).toBe(false);
    expect(EMPTY_PROVIDER_BODY).toBe('# empty\n');
  });
});

describe('ordering', () => {
  const text = [
    'DOMAIN,a.com,A',
    'DOMAIN,b.com,B',
    'DOMAIN,c.com,A',
    'DOMAIN,d.com,C',
    'DOMAIN,e.com,B',
  ].join('\n');

  it('keeps relative order inside each target', () => {
    const s = mustCompile(text);
    expect(s.targets.map((t) => [t.target, providerRulesOf(t)])).toEqual([
      ['A', ['DOMAIN,a.com', 'DOMAIN,c.com']],
      ['B', ['DOMAIN,b.com', 'DOMAIN,e.com']],
      ['C', ['DOMAIN,d.com']],
    ]);
  });

  it('applies an explicit targetOrder and appends the rest by first occurrence', () => {
    const s = mustCompile(text);
    expect(orderTargets(s, ['C']).targets.map((t) => t.target)).toEqual(['C', 'A', 'B']);
    expect(orderTargets(s, ['B', 'A']).targets.map((t) => t.target)).toEqual(['B', 'A', 'C']);
  });

  it('ignores targetOrder entries that are not real targets without creating providers', () => {
    const s = mustCompile(text);
    const r = orderTargets(s, ['Z', 'B']);
    expect(r.targets.map((t) => t.target)).toEqual(['B', 'A', 'C']);
    expect(r.diagnostics.map((d) => d.code)).toContain('TARGET_ORDER_UNUSED');
  });
});

describe('duplicates', () => {
  it('warns about identical conditions with different targets without deduplicating', () => {
    const s = mustCompile('DOMAIN,a.com,A\nDOMAIN,a.com,B\nDOMAIN,a.com,A\n');
    expect(s.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['DUPLICATE_CONDITION_DIFFERENT_TARGET', 2],
      ['DUPLICATE_RULE', 3],
    ]);
    expect(s.targets.find((t) => t.target === 'A')!.ruleCount).toBe(2);
  });
});

describe('snapshot', () => {
  it('records digest and compiler versions', () => {
    const s = mustCompile(fixture('acceptance.yaml'));
    expect(s.compilerVersion).toBe('ruhomo-compiler/1');
    expect(s.mihomoBaseline).toBe('v1.19.31');
    expect(s.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(s.documentFormat).toBe('yaml');
  });

  it('is JSON serializable without loss', () => {
    const s = mustCompile(fixture('complex.txt'));
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});
