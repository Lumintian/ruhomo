import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode, isWellFormed, sha256Hex, utf8DecodeStrict, utf8Encode } from '../src/index.ts';

describe('sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches node:crypto for random inputs of many lengths', () => {
    for (let len = 0; len < 300; len += 7) {
      const buf = randomBytes(len);
      expect(sha256Hex(new Uint8Array(buf))).toBe(createHash('sha256').update(buf).digest('hex'));
    }
    const text = '示例代理🇯🇵'.repeat(50);
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });
});

describe('base64url', () => {
  it('round-trips and matches Buffer base64url', () => {
    for (let len = 0; len < 64; len++) {
      const bytes = new Uint8Array(randomBytes(len));
      const enc = base64urlEncode(bytes);
      expect(enc).toBe(Buffer.from(bytes).toString('base64url'));
      expect(base64urlDecode(enc)).toEqual(bytes);
    }
  });

  it('rejects padding, foreign characters, bad lengths and non-canonical tails', () => {
    expect(() => base64urlDecode('YQ==')).toThrow();
    expect(() => base64urlDecode('Y+8')).toThrow();
    expect(() => base64urlDecode('Y/8')).toThrow();
    expect(() => base64urlDecode('YWJjZ')).toThrow();
    expect(() => base64urlDecode('YR')).toThrow(); // 'a' is canonically "YQ"
    expect(base64urlDecode('YQ')).toEqual(utf8Encode('a'));
  });
});

describe('utf8', () => {
  it('rejects malformed UTF-8', () => {
    expect(() => utf8DecodeStrict(new Uint8Array([0xff, 0xfe]))).toThrow();
    expect(() => utf8DecodeStrict(new Uint8Array([0xe7, 0xa8]))).toThrow();
    expect(utf8DecodeStrict(utf8Encode('示例代理'))).toBe('示例代理');
  });

  it('keeps a leading BOM for the document parser to handle', () => {
    expect(utf8DecodeStrict(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a');
  });

  it('detects lone surrogates', () => {
    expect(isWellFormed('ok🇯🇵')).toBe(true);
    expect(isWellFormed('\uD800')).toBe(false);
    expect(isWellFormed('\uDC00a')).toBe(false);
  });
});
