import { describe, expect, it } from 'vitest';
import {
  NameCollisionError,
  RecipeError,
  assignProviderNames,
  base64urlEncode,
  canonicalJson,
  checkSourceUrl,
  decodeRecipe,
  decodeTargetToken,
  encodeRecipe,
  encodeTargetToken,
  hostAllowed,
  normalizeRecipe,
  parseAllowlist,
  providerName,
  recipeId,
  targetId,
  utf8Encode,
} from '../src/index.ts';

const URL_A = 'https://raw.githubusercontent.com/example/repo/main/rules.yaml';
const tokenOf = (json: string) => base64urlEncode(utf8Encode(json));
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RecipeError) return e.code;
    throw e;
  }
  return 'OK';
};

describe('recipe normalization', () => {
  it('fills defaults', () => {
    expect(normalizeRecipe({ source: { url: URL_A } })).toEqual({
      v: 1,
      source: { url: URL_A, format: 'auto' },
      interval: 3600,
      targetOrder: [],
    });
  });

  it('produces sorted canonical JSON', () => {
    const r = normalizeRecipe({ source: { url: URL_A } });
    expect(canonicalJson(r)).toBe(
      `{"interval":3600,"source":{"format":"auto","url":"${URL_A}"},"targetOrder":[],"v":1}`,
    );
  });

  it('maps semantically equal inputs to the same token', () => {
    const a = encodeRecipe({ source: { url: URL_A } });
    const b = encodeRecipe({ targetOrder: [], interval: 3600, source: { format: 'auto', url: URL_A }, v: 1 });
    const c = encodeRecipe({ source: { url: 'HTTPS://RAW.githubusercontent.com/example/repo/main/rules.yaml' } });
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('keeps array order and query parameter order', () => {
    const t1 = encodeRecipe({ source: { url: `${URL_A}?b=1&a=2` }, targetOrder: ['X', 'Y'] });
    const t2 = encodeRecipe({ source: { url: `${URL_A}?a=2&b=1` }, targetOrder: ['X', 'Y'] });
    const t3 = encodeRecipe({ source: { url: `${URL_A}?b=1&a=2` }, targetOrder: ['Y', 'X'] });
    expect(new Set([t1, t2, t3]).size).toBe(3);
    expect(decodeRecipe(t1).source.url).toBe(`${URL_A}?b=1&a=2`);
  });

  it('round-trips', () => {
    const recipe = normalizeRecipe({ source: { url: URL_A, format: 'yaml' }, interval: 600, targetOrder: ['示例代理', 'DIRECT'] });
    expect(decodeRecipe(encodeRecipe(recipe))).toEqual(recipe);
  });

  it.each([
    [{ source: { url: URL_A }, extra: 1 }, 'RECIPE_INVALID'],
    [{ source: { url: URL_A, token: 'x' } }, 'RECIPE_INVALID'],
    [{ v: 2, source: { url: URL_A } }, 'RECIPE_UNSUPPORTED_VERSION'],
    [{ source: { url: URL_A }, interval: 0 }, 'RECIPE_INVALID'],
    [{ source: { url: URL_A }, interval: 59 }, 'RECIPE_INVALID'],
    [{ source: { url: URL_A }, interval: 1.5 }, 'RECIPE_INVALID'],
    [{ source: { url: URL_A }, interval: 10_000_000 }, 'RECIPE_INVALID'],
    [{ source: { url: URL_A }, targetOrder: ['A', 'A'] }, 'RECIPE_INVALID'],
    [{ source: { url: URL_A }, targetOrder: [''] }, 'RECIPE_INVALID'],
    [{ source: { url: URL_A, format: 'json' } }, 'RECIPE_INVALID'],
    [{ source: { url: 'http://raw.githubusercontent.com/a' } }, 'SOURCE_URL_INVALID'],
    [{ source: { url: 'https://user:pw@raw.githubusercontent.com/a' } }, 'SOURCE_URL_INVALID'],
  ])('rejects %j', (input, code) => {
    expect(codeOf(() => normalizeRecipe(input))).toBe(code);
  });
});

describe('recipe token decoding', () => {
  const canonical = `{"interval":3600,"source":{"format":"auto","url":"${URL_A}"},"targetOrder":[],"v":1}`;

  it('accepts only the canonical encoding', () => {
    expect(codeOf(() => decodeRecipe(tokenOf(canonical)))).toBe('OK');
    expect(codeOf(() => decodeRecipe(tokenOf(`{"v":1,"interval":3600,"source":{"format":"auto","url":"${URL_A}"},"targetOrder":[]}`)))).toBe(
      'RECIPE_NON_CANONICAL',
    );
    expect(codeOf(() => decodeRecipe(tokenOf(canonical.replace(/:/, ': '))))).toBe('RECIPE_NON_CANONICAL');
    expect(
      codeOf(() => decodeRecipe(tokenOf(canonical.replace('raw.githubusercontent.com', 'RAW.githubusercontent.com')))),
    ).toBe('RECIPE_NON_CANONICAL');
  });

  it('rejects unknown fields, missing defaults and unknown versions', () => {
    expect(codeOf(() => decodeRecipe(tokenOf(canonical.replace('"v":1', '"v":1,"x":1'))))).toBe('RECIPE_INVALID');
    expect(codeOf(() => decodeRecipe(tokenOf(`{"source":{"format":"auto","url":"${URL_A}"},"v":1}`)))).toBe('RECIPE_INVALID');
    expect(codeOf(() => decodeRecipe(tokenOf(canonical.replace('"v":1', '"v":9'))))).toBe('RECIPE_UNSUPPORTED_VERSION');
  });

  it('rejects malformed tokens, invalid UTF-8, invalid JSON and oversize input', () => {
    expect(codeOf(() => decodeRecipe(`${tokenOf(canonical)}=`))).toBe('RECIPE_MALFORMED_TOKEN');
    expect(codeOf(() => decodeRecipe('a+b/'))).toBe('RECIPE_MALFORMED_TOKEN');
    expect(codeOf(() => decodeRecipe(base64urlEncode(new Uint8Array([0x7b, 0xff, 0x7d]))))).toBe('RECIPE_INVALID_UTF8');
    expect(codeOf(() => decodeRecipe(tokenOf('{not json')))).toBe('RECIPE_INVALID_JSON');
    expect(codeOf(() => decodeRecipe(tokenOf('[1]')))).toBe('RECIPE_INVALID');
    expect(codeOf(() => decodeRecipe('A'.repeat(7000)))).toBe('RECIPE_TOO_LONG');
  });

  it('refuses to encode recipes over the size limit', () => {
    expect(codeOf(() => encodeRecipe({ source: { url: `${URL_A}?${'q'.repeat(2100)}` } }))).toBe('SOURCE_URL_INVALID');
  });
});

describe('target tokens', () => {
  it('are reversible and validated', () => {
    for (const t of ['DIRECT', '示例代理', '🇯🇵 Tokyo', 'a/b?c#d']) {
      expect(decodeTargetToken(encodeTargetToken(t))).toBe(t);
    }
    expect(() => decodeTargetToken('')).toThrow();
    expect(() => decodeTargetToken('YQ==')).toThrow();
    expect(() => decodeTargetToken(base64urlEncode(utf8Encode('a,b')))).toThrow();
    expect(() => decodeTargetToken(base64urlEncode(utf8Encode('a\nb')))).toThrow();
    expect(() => decodeTargetToken(base64urlEncode(new Uint8Array([0xff])))).toThrow();
  });
});

describe('stable naming', () => {
  const recipe = normalizeRecipe({ source: { url: URL_A } });

  it('uses 128-bit ids and a safe character set', () => {
    const name = providerName(recipeId(recipe), '示例代理');
    expect(name).toMatch(/^mrp-[0-9a-f]{32}-[0-9a-f]{32}$/);
    expect(targetId('示例代理')).toHaveLength(32);
  });

  it('depends only on the recipe and the target', () => {
    const id = recipeId(recipe);
    expect(recipeId(normalizeRecipe({ source: { url: URL_A }, interval: 3600 }))).toBe(id);
    expect(recipeId(normalizeRecipe({ source: { url: URL_A }, interval: 600 }))).not.toBe(id);
    expect(providerName(id, 'A')).not.toBe(providerName(id, 'a'));
  });

  it('detects collisions instead of assuming truncated hashes never collide', () => {
    expect(assignProviderNames('x', ['A', 'B']).size).toBe(2);
    expect(() => assignProviderNames('x', ['A', 'B', 'A'])).not.toThrow();
    const colliding = () => 'mrp-x-same';
    expect(() => assignProviderNames('x', ['A', 'B'], colliding)).toThrow(NameCollisionError);
  });
});

describe('source URL policy', () => {
  const policy = { allowlist: parseAllowlist('raw.githubusercontent.com, *.example.org'), denyHosts: ['ruhomo.example.net'] };
  it.each([
    ['https://raw.githubusercontent.com/a/b/main/r.txt', undefined],
    ['https://cdn.example.org/r.txt', undefined],
    ['https://a.b.example.org/r.txt', undefined],
    ['https://example.org/r.txt', 'SOURCE_URL_NOT_ALLOWED'],
    ['https://evilexample.org/r.txt', 'SOURCE_URL_NOT_ALLOWED'],
    ['https://raw.githubusercontent.com.evil.com/r.txt', 'SOURCE_URL_NOT_ALLOWED'],
    ['https://ruhomo.example.net/r/v1/x/override.yaml', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['http://raw.githubusercontent.com/r.txt', 'SOURCE_URL_NOT_HTTPS'],
    ['https://u:p@raw.githubusercontent.com/r.txt', 'SOURCE_URL_USERINFO'],
    ['https://raw.githubusercontent.com/r.txt#x', 'SOURCE_URL_FRAGMENT'],
    ['https://raw.githubusercontent.com:8443/r.txt', 'SOURCE_URL_PORT'],
    ['https://127.0.0.1/r.txt', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['https://10.0.0.1/r.txt', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['https://169.254.169.254/latest/meta-data', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['https://0x7f000001/r.txt', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['https://[::1]/r.txt', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['https://localhost/r.txt', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['https://foo.localhost/r.txt', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['https://metadata.google.internal/r.txt', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['https://printer.local/r.txt', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['https://intranet/r.txt', 'SOURCE_URL_FORBIDDEN_HOST'],
    ['not a url', 'SOURCE_URL_INVALID'],
  ])('%s -> %s', (url, code) => {
    expect(checkSourceUrl(url, policy)?.code).toBe(code);
  });

  it('refuses the deployment own host even when allowlisted', () => {
    const p = { allowlist: ['ruhomo.example.net'], denyHosts: ['ruhomo.example.net'] };
    expect(checkSourceUrl('https://ruhomo.example.net/r.txt', p)?.code).toBe('SOURCE_URL_FORBIDDEN_HOST');
  });

  it('matches wildcard entries only on label boundaries', () => {
    expect(hostAllowed('x.example.org', ['*.example.org'])).toBe(true);
    expect(hostAllowed('xexample.org', ['*.example.org'])).toBe(false);
    expect(hostAllowed('example.org', ['*.example.org'])).toBe(false);
  });

  it('rejects malformed allowlist entries', () => {
    expect(() => parseAllowlist('*.org*')).toThrow();
    expect(() => parseAllowlist('https://raw.githubusercontent.com')).toThrow();
    expect(() => parseAllowlist('*')).toThrow();
  });
});
