import { describe, expect, it } from 'vitest';
import { parseRule } from '../src/index.ts';

const at = (raw: string) => ({ raw, line: 7, column: 3, sourceIndex: 0 });
const ok = (raw: string) => {
  const r = parseRule(at(raw));
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(r.rule).toBeDefined();
  return r.rule!;
};
const errorCodes = (raw: string) => {
  const r = parseRule(at(raw));
  expect(r.rule).toBeUndefined();
  return r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
};
const warningCodes = (raw: string) => ok(raw).validationWarnings.map((d) => d.code);

describe('ordinary rules', () => {
  it('extracts the third field as target', () => {
    const r = ok('DOMAIN-SUFFIX,example.com,示例代理');
    expect(r).toMatchObject({ type: 'DOMAIN-SUFFIX', payload: 'example.com', target: '示例代理', params: [] });
    expect(r.providerRule).toBe('DOMAIN-SUFFIX,example.com');
    expect(r).toMatchObject({ line: 7, column: 3, sourceIndex: 0 });
  });

  it('removes only the target and keeps params in order', () => {
    expect(ok('IP-CIDR,203.0.113.0/24,示例代理,no-resolve').providerRule).toBe('IP-CIDR,203.0.113.0/24,no-resolve');
    expect(ok('IP-CIDR6,2001:db8::/32,X,src,no-resolve').providerRule).toBe('IP-CIDR6,2001:db8::/32,src,no-resolve');
    expect(ok('GEOIP,CN,DIRECT,no-resolve').providerRule).toBe('GEOIP,CN,no-resolve');
  });

  it('trims spaces around fields like Mihomo and upper-cases the type', () => {
    const r = ok('domain-suffix , example.com , My Proxy ');
    expect(r.target).toBe('My Proxy');
    expect(r.providerRule).toBe('DOMAIN-SUFFIX,example.com');
  });

  it('preserves case and Unicode in target names', () => {
    expect(ok('DOMAIN,a.com,🇯🇵 日本 Proxy').target).toBe('🇯🇵 日本 Proxy');
    expect(ok('DOMAIN,a.com,e\u0301').target).toBe('e\u0301');
  });

  it('warns when a target only differs from a built-in by case', () => {
    expect(warningCodes('DOMAIN,a.com,direct')).toEqual(['TARGET_CASE_BUILTIN']);
  });

  it('keeps Windows paths and Unicode payloads verbatim', () => {
    expect(ok('PROCESS-PATH,C:\\Windows\\System32\\curl.exe,DIRECT').providerRule).toBe(
      'PROCESS-PATH,C:\\Windows\\System32\\curl.exe',
    );
    expect(ok('DOMAIN-SUFFIX,例子.测试,默认代理').providerRule).toBe('DOMAIN-SUFFIX,例子.测试');
  });

  it('reports missing payload and target', () => {
    expect(errorCodes('DOMAIN')).toEqual(['MISSING_PAYLOAD']);
    expect(errorCodes('DOMAIN,,DIRECT')).toEqual(['MISSING_PAYLOAD']);
    expect(errorCodes('DOMAIN,a.com')).toEqual(['MISSING_TARGET']);
    expect(errorCodes('DOMAIN,a.com,')).toEqual(['MISSING_TARGET']);
    expect(errorCodes('IP-CIDR,1.1.1.1/32,no-resolve')).toEqual(['INVALID_TARGET']);
  });

  it('rejects extra fields for types without params', () => {
    expect(errorCodes('DOMAIN,a.com,DIRECT,no-resolve')).toEqual(['UNEXPECTED_FIELD']);
    expect(errorCodes('DOMAIN-SUFFIX,a.com,DIRECT,extra')).toEqual(['UNEXPECTED_FIELD']);
    expect(errorCodes('DOMAIN,a.com,DIRECT,')).toEqual(['EMPTY_FIELD']);
  });

  it('rejects unknown or misspelled params', () => {
    expect(errorCodes('IP-CIDR,1.1.1.0/24,DIRECT,no_resolve')).toEqual(['UNKNOWN_PARAM']);
    expect(errorCodes('IP-CIDR,1.1.1.0/24,DIRECT,No-Resolve')).toEqual(['UNKNOWN_PARAM']);
    expect(parseRule(at('IP-CIDR,1.1.1.0/24,DIRECT,No-Resolve')).diagnostics[0]!.message).toContain('区分大小写');
  });

  it('flags redundant and duplicate params as warnings', () => {
    expect(warningCodes('SRC-IP-CIDR,10.0.0.0/8,DIRECT,no-resolve')).toEqual(['REDUNDANT_PARAM']);
    expect(warningCodes('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve,no-resolve')).toEqual(['DUPLICATE_PARAM']);
  });

  it('rejects forbidden and unknown types', () => {
    expect(errorCodes('MATCH,DIRECT')).toEqual(['FORBIDDEN_RULE_TYPE']);
    expect(errorCodes('RULE-SET,foo,DIRECT')).toEqual(['FORBIDDEN_RULE_TYPE']);
    expect(errorCodes('SUB-RULE,(NETWORK,tcp),sub')).toEqual(['FORBIDDEN_RULE_TYPE']);
    expect(errorCodes('FINAL,DIRECT')).toEqual(['UNKNOWN_RULE_TYPE']);
    expect(errorCodes('DOMAIN-SUFFIXX,a.com,DIRECT')).toEqual(['UNKNOWN_RULE_TYPE']);
    expect(errorCodes('SCRIPT,quic,REJECT')).toEqual(['UNKNOWN_RULE_TYPE']);
  });

  it('rejects control characters and oversized rules', () => {
    expect(errorCodes('DOMAIN,a.com,DIR\tECT')).toEqual(['CONTROL_CHARACTER']);
    expect(errorCodes(`DOMAIN,a.com,X${String.fromCharCode(0x2028)}`)).toEqual(['CONTROL_CHARACTER']);
    const r = parseRule(at(`DOMAIN,${'a'.repeat(100)},DIRECT`), { maxRuleBytes: 50 });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['RULE_TOO_LONG']);
  });

  it('limits target length', () => {
    expect(parseRule(at('DOMAIN,a.com,abcdef'), { maxTargetChars: 5 }).diagnostics[0]!.code).toBe('INVALID_TARGET');
  });
});

describe('payload validation', () => {
  it.each([
    'IP-CIDR,0.0.0.0/0,X',
    'IP-CIDR,203.0.113.7/24,X',
    'IP-CIDR6,::/0,X',
    'IP-CIDR6,::ffff:1.2.3.4/128,X',
    'IP-CIDR6,2001:db8:0:0:0:0:0:1/128,X',
    'IP-SUFFIX,8.8.8.8/24,X',
    'DST-PORT,443,X',
    'DST-PORT,80/443/1000-2000,X',
    'SRC-PORT,[1000-2000],X',
    'IN-PORT,7890,X',
    'DSCP,46,X',
    'DSCP,0-63,X',
    'NETWORK,TCP,X',
    'NETWORK,udp,X',
    'IN-TYPE,SOCKS/HTTP,X',
    'IN-USER,alice/bob,X',
    'IN-NAME,mixed-in,X',
    'REMATCH-NAME,a,X',
    'IP-ASN,13335,X,no-resolve',
    'GEOIP,lan,X',
    'PROCESS-NAME,curl,X',
    'PROCESS-NAME-WILDCARD,*chrome*,X',
    'DOMAIN-WILDCARD,*.example.com,X',
  ])('accepts %s', (raw) => {
    ok(raw);
  });

  it.each([
    'IP-CIDR,1.2.3.4,X',
    'IP-CIDR,1.2.3.4/33,X',
    'IP-CIDR,1.2.3/24,X',
    'IP-CIDR,01.2.3.4/24,X',
    'IP-CIDR,1.2.3.256/24,X',
    'IP-CIDR,1.2.3.4/024,X',
    'IP-CIDR6,2001:db8::1::/64,X',
    'IP-CIDR6,fe80::1%eth0/64,X',
    'IP-CIDR6,2001:db8::/129,X',
    'IP-CIDR,example.com/24,X',
    'DST-PORT,70000,X',
    'DST-PORT,*,X',
    'DST-PORT,abc,X',
    'DST-PORT,1-2-3,X',
    'DSCP,64,X',
    'DSCP,256,X',
    'UID,-1,X',
    'NETWORK,icmp,X',
    'IN-TYPE,FOO,X',
    'IN-USER,a//b,X',
    'IP-ASN,AS13335,X',
  ])('rejects %s', (raw) => {
    expect(errorCodes(raw)).toEqual(['INVALID_PAYLOAD']);
  });

  it('warns about environment dependent rules', () => {
    expect(warningCodes('GEOSITE,cn,DIRECT')).toEqual(['GEODATA_DEPENDENCY']);
    expect(warningCodes('GEOIP,CN,DIRECT')).toEqual(['GEODATA_DEPENDENCY']);
    expect(warningCodes('UID,1000,DIRECT')).toEqual(['PLATFORM_DEPENDENT']);
  });
});

describe('regex rules (comma payload)', () => {
  it('takes the last field as target and keeps commas inside the payload', () => {
    const r = ok('DOMAIN-REGEX,^foo[0-9]{1,3}\\.example\\.com$,示例代理');
    expect(r.payload).toBe('^foo[0-9]{1,3}\\.example\\.com$');
    expect(r.target).toBe('示例代理');
    expect(r.providerRule).toBe('DOMAIN-REGEX,^foo[0-9]{1,3}\\.example\\.com$');
    expect(r.validationWarnings.map((d) => d.code)).toEqual(['REGEX_SEMANTICS_NOT_VALIDATED']);
  });

  it('does not use JS RegExp to judge Mihomo regex', () => {
    // Invalid in JS RegExp but meaningful for .NET-style regexp2 (possessive / atomic / named groups).
    ok('DOMAIN-REGEX,(?>foo|foob)ar,DIRECT');
    ok('PROCESS-NAME-REGEX,(?<name>chrome)\\.exe,DIRECT');
    ok('DOMAIN-REGEX,[,DIRECT');
  });

  it('keeps Windows path backslashes in PROCESS-PATH-REGEX', () => {
    expect(ok('PROCESS-PATH-REGEX,^C:\\\\Program Files\\\\.+\\.exe$,DIRECT').providerRule).toBe(
      'PROCESS-PATH-REGEX,^C:\\\\Program Files\\\\.+\\.exe$',
    );
  });

  it('warns when field trimming changes the regex', () => {
    const r = ok('DOMAIN-REGEX,^a{1, 3}$,DIRECT');
    expect(r.payload).toBe('^a{1,3}$');
    expect(r.validationWarnings.map((d) => d.code)).toContain('PAYLOAD_WHITESPACE_TRIMMED');
  });

  it('requires a target', () => {
    expect(errorCodes('DOMAIN-REGEX,^a$')).toEqual(['MISSING_TARGET']);
    expect(errorCodes('DOMAIN-REGEX,,DIRECT')).toEqual(['MISSING_PAYLOAD']);
  });
});

describe('logic rules', () => {
  it('extracts the outer target from the last field', () => {
    const r = ok('AND,((DOMAIN-SUFFIX,example.com),(DST-PORT,443)),示例代理');
    expect(r.target).toBe('示例代理');
    expect(r.payload).toBe('((DOMAIN-SUFFIX,example.com),(DST-PORT,443))');
    expect(r.providerRule).toBe('AND,((DOMAIN-SUFFIX,example.com),(DST-PORT,443))');
    expect(r.children).toEqual([
      { type: 'DOMAIN-SUFFIX', payload: 'example.com', params: [] },
      { type: 'DST-PORT', payload: '443', params: [] },
    ]);
  });

  it('keeps nested params such as no-resolve and src', () => {
    const r = ok('OR,((IP-CIDR,198.51.100.0/24,no-resolve),(GEOIP,lan,src)),X');
    expect(r.children![0]).toEqual({ type: 'IP-CIDR', payload: '198.51.100.0/24', params: ['no-resolve'] });
    expect(r.children![1]!.params).toEqual(['src']);
    expect(r.providerRule).toBe('OR,((IP-CIDR,198.51.100.0/24,no-resolve),(GEOIP,lan,src))');
  });

  it('supports nested AND/OR/NOT', () => {
    const r = ok('AND,((OR,((DOMAIN,a.com),(DOMAIN,b.com))),(NOT,((NETWORK,udp)))),X');
    expect(r.children!.map((c) => c.type)).toEqual(['OR', 'NOT']);
    expect(r.children![0]!.children!.map((c) => c.payload)).toEqual(['a.com', 'b.com']);
    expect(r.children![1]!.children).toEqual([{ type: 'NETWORK', payload: 'udp', params: [] }]);
  });

  it('allows spaces between sub-rules', () => {
    ok('AND, ((DOMAIN,a.com), (DST-PORT,443)) ,X');
  });

  it('enforces NOT arity', () => {
    expect(errorCodes('NOT,((DOMAIN,a.com),(DOMAIN,b.com)),X')).toEqual(['LOGIC_NOT_ARITY']);
    ok('NOT,((DOMAIN,a.com)),X');
  });

  it('reports parenthesis errors', () => {
    expect(errorCodes('AND,((DOMAIN,a.com),(DST-PORT,443),X')).toEqual(['LOGIC_UNBALANCED_PARENS']);
    expect(errorCodes('AND,(DOMAIN,a.com)),X')).toEqual(['LOGIC_UNBALANCED_PARENS']);
    expect(errorCodes('AND,(DOMAIN,a.com),(DST-PORT,443),X')).toEqual(['LOGIC_SYNTAX']);
    expect(errorCodes('AND,((DOMAIN,a.com)junk(DST-PORT,443)),X')).toEqual(['LOGIC_SYNTAX']);
    expect(errorCodes('AND,DOMAIN,a.com,X')).toEqual(['LOGIC_SYNTAX']);
    expect(errorCodes('AND,(),X')).toEqual(['LOGIC_EMPTY']);
    expect(errorCodes('AND,(()),X')).toEqual(['LOGIC_SYNTAX']);
  });

  it('does not delete params of nested rules nor accept a nested target', () => {
    expect(errorCodes('AND,((DOMAIN,a.com,DIRECT),(DST-PORT,443)),X')).toEqual(['UNEXPECTED_FIELD']);
    expect(errorCodes('AND,((IP-CIDR,1.1.1.0/24,bogus)),X')).toEqual(['UNKNOWN_PARAM']);
  });

  it('validates nested payloads', () => {
    expect(errorCodes('AND,((DST-PORT,99999),(DOMAIN,a.com)),X')).toEqual(['INVALID_PAYLOAD']);
    expect(errorCodes('AND,((FOO,bar)),X')).toEqual(['UNKNOWN_RULE_TYPE']);
    expect(errorCodes('AND,((DOMAIN,)),X')).toEqual(['MISSING_PAYLOAD']);
  });

  it('forbids MATCH, SUB-RULE and RULE-SET inside logic', () => {
    expect(errorCodes('AND,((MATCH,x)),X')).toEqual(['LOGIC_FORBIDDEN_SUBRULE']);
    expect(errorCodes('OR,((RULE-SET,foo),(DOMAIN,a.com)),X')).toEqual(['LOGIC_FORBIDDEN_SUBRULE']);
    expect(parseRule(at('OR,((RULE-SET,foo)),X')).diagnostics[0]!.message).toContain('本工具的约束');
  });

  it('warns about regex nested in logic', () => {
    const r = ok('AND,((DOMAIN-REGEX,^(a|b)\\.com$),(DST-PORT,443)),X');
    expect(r.children![0]).toEqual({ type: 'DOMAIN-REGEX', payload: '^(a|b)\\.com$', params: [] });
    expect(r.validationWarnings.map((d) => d.code)).toEqual(
      expect.arrayContaining(['LOGIC_NESTED_REGEX', 'REGEX_SEMANTICS_NOT_VALIDATED']),
    );
    // Regex with a comma quantifier nested in logic: payload keeps the comma.
    expect(ok('AND,((DOMAIN-REGEX,^a{1,3}$)),X').children![0]!.payload).toBe('^a{1,3}$');
    // An unbalanced paren inside a nested regex breaks Mihomo's pairing too.
    expect(errorCodes('AND,((DOMAIN-REGEX,^a\\($)),X')).toEqual(['LOGIC_UNBALANCED_PARENS']);
  });

  it('limits nesting depth', () => {
    let expr = '(DOMAIN,a.com)';
    for (let i = 0; i < 10; i++) expr = `(AND,(${expr}))`;
    expect(parseRule(at(`AND,(${expr}),X`), { maxLogicDepth: 8 }).diagnostics.map((d) => d.code)).toEqual([
      'LOGIC_TOO_DEEP',
    ]);
  });
});
