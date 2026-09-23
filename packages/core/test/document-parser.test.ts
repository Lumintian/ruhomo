import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectFormat, parseDocument } from '../src/index.ts';

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8');

function codes(input: string, format: 'auto' | 'yaml' | 'text' = 'auto') {
  return parseDocument(input, format).diagnostics.items.map((d) => d.code);
}

describe('format detection', () => {
  it.each([
    ['rules:\n  - DOMAIN,a.com,DIRECT\n', 'yaml'],
    ['- DOMAIN,a.com,DIRECT\n', 'yaml'],
    ['# comment\n\n- DOMAIN,a.com,DIRECT\n', 'yaml'],
    ['---\nrules: []\n', 'yaml'],
    ['proxies:\n  - name: x\n', 'yaml'],
    ['DOMAIN,a.com,DIRECT\n', 'text'],
    ['// c\nDOMAIN-REGEX,^a:b$,DIRECT\n', 'text'],
    ['PROCESS-PATH,C:\\a.exe,DIRECT\n', 'text'],
    ['', 'text'],
  ] as const)('%j -> %s', (input, expected) => {
    expect(detectFormat(input)).toBe(expected);
  });
});

describe('acceptance fixtures', () => {
  it.each(['acceptance.yaml', 'acceptance-sequence.yaml', 'acceptance.txt', 'bom-crlf.yaml'])('%s parses', (name) => {
    const { document, diagnostics } = parseDocument(fixture(name));
    expect(diagnostics.items).toEqual([]);
    expect(document).toBeDefined();
    expect(document!.rules[0]!.raw).toBe('DOMAIN-SUFFIX,direct.example,DIRECT');
    expect(document!.rules[1]!.raw).toBe('DOMAIN-SUFFIX,proxy-one.example,示例代理');
  });

  it('tracks line numbers for YAML and text', () => {
    const yaml = parseDocument(fixture('acceptance.yaml')).document!;
    expect(yaml.format).toBe('yaml');
    expect(yaml.rules.map((r) => r.line)).toEqual([3, 4, 5, 6, 9, 10, 11]);
    expect(yaml.rules[0]!.column).toBe(5);
    const text = parseDocument(fixture('acceptance.txt')).document!;
    expect(text.format).toBe('text');
    expect(text.rules.map((r) => r.line)).toEqual([2, 3, 4, 5, 8, 9, 10]);
  });

  it('handles BOM and CRLF', () => {
    const doc = parseDocument(fixture('bom-crlf.yaml')).document!;
    expect(doc.rules.map((r) => r.raw)).toEqual(['DOMAIN-SUFFIX,direct.example,DIRECT', 'DOMAIN-SUFFIX,proxy-one.example,示例代理']);
    const text = parseDocument('\uFEFFDOMAIN,a.com,DIRECT\r\nDOMAIN,b.com,DIRECT\r\n').document!;
    expect(text.format).toBe('text');
    expect(text.rules.map((r) => r.raw)).toEqual(['DOMAIN,a.com,DIRECT', 'DOMAIN,b.com,DIRECT']);
  });
});

describe('text documents', () => {
  it('ignores blank lines and whole-line # and // comments only', () => {
    const doc = parseDocument('  # a\n\n// b\n  DOMAIN-REGEX,^a#b$,DIRECT  \nPROCESS-PATH,/opt/a#b,DIRECT\n', 'text').document!;
    expect(doc.rules.map((r) => r.raw)).toEqual(['DOMAIN-REGEX,^a#b$,DIRECT', 'PROCESS-PATH,/opt/a#b,DIRECT']);
    expect(doc.rules[0]!.column).toBe(3);
  });

  it('treats an empty or comment-only document as an error', () => {
    expect(codes('')).toEqual(['EMPTY_DOCUMENT']);
    expect(codes('\n\n  \n')).toEqual(['EMPTY_DOCUMENT']);
    expect(codes('# just a comment\n// another\n')).toEqual(['EMPTY_DOCUMENT']);
  });

  it('accepts the explicit empty marker', () => {
    const r = parseDocument('# 这个文件故意为空\n# mrp:empty\n');
    expect(r.diagnostics.items).toEqual([]);
    expect(r.document).toEqual({ format: 'text', rules: [], explicitEmpty: true });
  });

  it('rejects the empty marker together with rules', () => {
    expect(codes('# mrp:empty\nDOMAIN,a.com,DIRECT\n')).toEqual(['EMPTY_MARKER_WITH_RULES']);
  });

  it('does not honour the marker in explicit yaml mode', () => {
    expect(codes('# mrp:empty\n', 'yaml')).toEqual(['EMPTY_DOCUMENT']);
  });
});

describe('YAML documents', () => {
  it('allows explicit rules: []', () => {
    const r = parseDocument('rules: []\n');
    expect(r.diagnostics.items).toEqual([]);
    expect(r.document).toEqual({ format: 'yaml', rules: [], explicitEmpty: true });
  });

  it('distinguishes rules: null from rules: []', () => {
    expect(codes('rules:\n')).toEqual(['RULES_NULL']);
    expect(codes('rules: null\n')).toEqual(['RULES_NULL']);
    expect(codes('rules: ~\n')).toEqual(['RULES_NULL']);
  });

  it('reports syntax errors instead of falling back to text', () => {
    expect(codes('rules:\n  - DOMAIN,a.com,DIRECT\n - bad indent\n')).toContain('YAML_SYNTAX');
    expect(codes('rules: [\n')).toContain('YAML_SYNTAX');
  });

  it('rejects duplicate keys', () => {
    const r = parseDocument('rules:\n  - DOMAIN,a.com,DIRECT\nrules:\n  - DOMAIN,b.com,DIRECT\n');
    expect(r.diagnostics.items[0]).toMatchObject({ code: 'YAML_SYNTAX', message: '存在重复的键', line: 3 });
  });

  it('rejects multiple documents', () => {
    expect(codes('rules: []\n---\nrules: []\n')).toEqual(['YAML_MULTI_DOCUMENT']);
  });

  it('rejects anchors, aliases, merge keys and tags', () => {
    expect(codes('rules:\n  - &a DOMAIN,a.com,DIRECT\n  - *a\n')).toEqual(
      expect.arrayContaining(['YAML_ANCHOR_UNSUPPORTED', 'YAML_ALIAS_UNSUPPORTED']),
    );
    expect(codes('rules:\n  - DOMAIN,a.com,DIRECT\n<<: {}\n')).toContain('YAML_MERGE_KEY_UNSUPPORTED');
    expect(codes('rules:\n  - !!str DOMAIN,a.com,DIRECT\n')).toEqual(['YAML_TAG_UNSUPPORTED']);
    expect(codes('rules:\n  - !custom DOMAIN,a.com,DIRECT\n')).toContain('YAML_TAG_UNSUPPORTED');
  });

  it('rejects non-string elements', () => {
    const r = parseDocument('rules:\n  - 123\n  - true\n  - null\n  -\n  - [a]\n  - {a: b}\n');
    expect(r.diagnostics.items.map((d) => d.code)).toEqual(Array(6).fill('RULE_NOT_STRING'));
    expect(r.diagnostics.items.map((d) => d.sourceIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('rejects strings that contain newlines', () => {
    expect(codes('rules:\n  - |\n    DOMAIN,a.com,DIRECT\n    DOMAIN,b.com,DIRECT\n')).toEqual(['RULE_CONTAINS_NEWLINE']);
    expect(codes('rules:\n  - "DOMAIN,a.com,DIRECT\\nDOMAIN,b.com,DIRECT"\n')).toEqual(['RULE_CONTAINS_NEWLINE']);
  });

  it('rejects full configs without echoing their content', () => {
    const secret = 'server: 198.51.100.7\n    password: hunter2';
    const r = parseDocument(`proxies:\n  - name: a\n    ${secret}\nrules:\n  - MATCH,DIRECT\n`);
    expect(r.diagnostics.items.map((d) => d.code)).toEqual(['FULL_CONFIG_NOT_ACCEPTED']);
    expect(JSON.stringify(r.diagnostics.items)).not.toContain('hunter2');
    expect(codes('proxy-groups: []\n')).toEqual(['FULL_CONFIG_NOT_ACCEPTED']);
    expect(codes('dns:\n  enable: true\n')).toEqual(['FULL_CONFIG_NOT_ACCEPTED']);
  });

  it('rejects provider payload files and unknown keys', () => {
    expect(codes('payload:\n  - DOMAIN,a.com\n')).toEqual(['PROVIDER_PAYLOAD_NOT_ACCEPTED']);
    expect(codes('foo: bar\n')).toEqual(['UNSUPPORTED_TOP_LEVEL_KEY']);
    expect(codes('rules:\n  - DOMAIN,a.com,DIRECT\nextra: 1\n')).toEqual(['UNSUPPORTED_TOP_LEVEL_KEY']);
  });

  it('rejects scalar roots and rules that are not sequences', () => {
    expect(codes('just a string\n', 'yaml')).toEqual(['YAML_ROOT_INVALID']);
    expect(codes('rules: DOMAIN,a.com,DIRECT\n')).toEqual(['RULES_NOT_SEQUENCE']);
    expect(codes('rules:\n  a: b\n')).toEqual(['RULES_NOT_SEQUENCE']);
  });

  it('keeps regex quantifiers and backslashes in plain scalars', () => {
    const doc = parseDocument(
      'rules:\n  - DOMAIN-REGEX,^foo[0-9]{1,3}\\.example\\.com$,示例代理\n  - PROCESS-PATH,C:\\Windows\\a.exe,DIRECT\n',
    ).document!;
    expect(doc.rules.map((r) => r.raw)).toEqual([
      'DOMAIN-REGEX,^foo[0-9]{1,3}\\.example\\.com$,示例代理',
      'PROCESS-PATH,C:\\Windows\\a.exe,DIRECT',
    ]);
  });
});

describe('non-rule content', () => {
  it('rejects HTML error pages in every mode', () => {
    const html = '<!DOCTYPE html>\n<html><body>404: Not Found</body></html>\n';
    expect(codes(html)).toEqual(['SOURCE_LOOKS_LIKE_HTML']);
    expect(codes(html, 'text')).toEqual(['SOURCE_LOOKS_LIKE_HTML']);
    expect(codes(html, 'yaml')).toEqual(['SOURCE_LOOKS_LIKE_HTML']);
  });

  it('rejects JSON error objects', () => {
    expect(codes('{"error":"rate limited"}')).toEqual(['SOURCE_LOOKS_LIKE_JSON']);
    expect(codes('[]')).toEqual(['SOURCE_LOOKS_LIKE_JSON']);
  });

  it('enforces the size and rule count limits', () => {
    expect(parseDocument('DOMAIN,a.com,DIRECT\n'.repeat(10), 'auto', { maxSourceBytes: 50 }).diagnostics.items[0]!.code).toBe(
      'INPUT_TOO_LARGE',
    );
    expect(parseDocument('DOMAIN,a.com,DIRECT\n'.repeat(4), 'auto', { maxRules: 3 }).diagnostics.items[0]!.code).toBe(
      'TOO_MANY_RULES',
    );
  });
});
