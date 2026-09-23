/**
 * Portable, self-describing recipes. A recipe token is
 * Base64url(UTF-8(canonical JSON)) without padding. This is an encoding,
 * not encryption or authentication: anyone holding a token (or a provider
 * URL containing it) can read the source URL.
 */
import { z } from 'zod';
import type { InputFormat } from './document-parser.ts';
import { INPUT_FORMATS } from './document-parser.ts';
import { Base64urlError, Utf8Error, base64urlDecode, base64urlEncode, isWellFormed, utf8DecodeStrict, utf8Encode } from './encoding.ts';
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_LIMITS,
  MAX_INTERVAL_SECONDS,
  MAX_RECIPE_TOKEN_CHARS,
  MIN_INTERVAL_SECONDS,
} from './limits.ts';
import { validateTargetName } from './rule-parser.ts';
import { canonicalizeSourceUrl } from './url-policy.ts';

export const RECIPE_VERSION = 1;

export interface Recipe {
  v: 1;
  source: { url: string; format: InputFormat };
  interval: number;
  targetOrder: string[];
}

export interface RecipeInput {
  v?: number;
  source: { url: string; format?: InputFormat };
  interval?: number;
  targetOrder?: string[];
}

export type RecipeErrorCode =
  | 'RECIPE_TOO_LONG'
  | 'RECIPE_MALFORMED_TOKEN'
  | 'RECIPE_INVALID_UTF8'
  | 'RECIPE_INVALID_JSON'
  | 'RECIPE_UNSUPPORTED_VERSION'
  | 'RECIPE_INVALID'
  | 'RECIPE_NON_CANONICAL'
  | 'SOURCE_URL_INVALID';

export class RecipeError extends Error {
  readonly code: RecipeErrorCode;
  constructor(code: RecipeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'RecipeError';
  }
}

const formatSchema = z.enum(INPUT_FORMATS as [InputFormat, ...InputFormat[]]);

const inputSchema = z.strictObject({
  v: z.literal(RECIPE_VERSION).optional(),
  source: z.strictObject({
    url: z.string(),
    format: formatSchema.optional(),
  }),
  interval: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS).optional(),
  targetOrder: z.array(z.string()).max(DEFAULT_LIMITS.maxTargets).optional(),
});

const canonicalSchema = z.strictObject({
  v: z.literal(RECIPE_VERSION),
  source: z.strictObject({ url: z.string(), format: formatSchema }),
  interval: z.number().int().min(MIN_INTERVAL_SECONDS).max(MAX_INTERVAL_SECONDS),
  targetOrder: z.array(z.string()).max(DEFAULT_LIMITS.maxTargets),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function checkTargetOrder(order: string[]): void {
  const seen = new Set<string>();
  for (const t of order) {
    const invalid = validateTargetName(t, DEFAULT_LIMITS);
    if (invalid) throw new RecipeError('RECIPE_INVALID', `targetOrder 项无效：${invalid.message}`);
    if (seen.has(t)) throw new RecipeError('RECIPE_INVALID', `targetOrder 存在重复项 "${t}"`);
    seen.add(t);
  }
}

/** Validates user input, fills defaults and canonicalizes the source URL. */
export function normalizeRecipe(input: unknown): Recipe {
  if (typeof input === 'object' && input !== null && 'v' in input && (input as { v: unknown }).v !== RECIPE_VERSION) {
    throw new RecipeError('RECIPE_UNSUPPORTED_VERSION', `不支持的 recipe 版本 ${String((input as { v: unknown }).v)}`);
  }
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new RecipeError('RECIPE_INVALID', `recipe 无效：${describeIssues(parsed.error)}`);
  const src = canonicalizeSourceUrl(parsed.data.source.url);
  if ('code' in src) throw new RecipeError('SOURCE_URL_INVALID', src.message);
  const targetOrder = parsed.data.targetOrder ?? [];
  checkTargetOrder(targetOrder);
  return {
    v: RECIPE_VERSION,
    source: { url: src.url, format: parsed.data.source.format ?? 'auto' },
    interval: parsed.data.interval ?? DEFAULT_INTERVAL_SECONDS,
    targetOrder: [...targetOrder],
  };
}

/** JSON with object keys sorted recursively; array order is preserved. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function encodeRecipe(input: RecipeInput | Recipe): string {
  const recipe = normalizeRecipe(input);
  const token = base64urlEncode(utf8Encode(canonicalJson(recipe)));
  if (token.length > MAX_RECIPE_TOKEN_CHARS) throw new RecipeError('RECIPE_TOO_LONG', 'recipe 过长');
  return token;
}

/**
 * Decodes a token and requires it to be the canonical encoding of a valid
 * recipe, so each recipe has exactly one accepted token.
 */
export function decodeRecipe(token: string): Recipe {
  if (token.length > MAX_RECIPE_TOKEN_CHARS) throw new RecipeError('RECIPE_TOO_LONG', 'recipe token 过长');
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(token);
  } catch (e) {
    if (e instanceof Base64urlError) throw new RecipeError('RECIPE_MALFORMED_TOKEN', 'recipe token 不是规范的无填充 Base64url');
    throw e;
  }
  let text: string;
  try {
    text = utf8DecodeStrict(bytes);
  } catch (e) {
    if (e instanceof Utf8Error) throw new RecipeError('RECIPE_INVALID_UTF8', 'recipe token 不是合法的 UTF-8');
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RecipeError('RECIPE_INVALID_JSON', 'recipe token 不是合法的 JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RecipeError('RECIPE_INVALID', 'recipe 必须是对象');
  }
  if ((raw as { v?: unknown }).v !== RECIPE_VERSION) {
    throw new RecipeError('RECIPE_UNSUPPORTED_VERSION', `不支持的 recipe 版本 ${String((raw as { v?: unknown }).v)}`);
  }
  const parsed = canonicalSchema.safeParse(raw);
  if (!parsed.success) throw new RecipeError('RECIPE_INVALID', `recipe 无效：${describeIssues(parsed.error)}`);
  const recipe = normalizeRecipe(parsed.data);
  if (base64urlEncode(utf8Encode(canonicalJson(recipe))) !== token) {
    throw new RecipeError('RECIPE_NON_CANONICAL', 'recipe token 不是规范编码（字段顺序、默认值或 URL 形式不一致）');
  }
  return recipe;
}

export class TargetTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetTokenError';
  }
}

export function encodeTargetToken(target: string): string {
  if (!isWellFormed(target)) throw new TargetTokenError('target contains lone surrogates');
  return base64urlEncode(utf8Encode(target));
}

/** Reversible target token used in provider URLs; validated like a rule target. */
export function decodeTargetToken(token: string): string {
  if (token.length === 0 || token.length > 1024) throw new TargetTokenError('目标编码长度无效');
  let target: string;
  try {
    target = utf8DecodeStrict(base64urlDecode(token));
  } catch {
    throw new TargetTokenError('目标编码不是规范的 Base64url(UTF-8)');
  }
  const invalid = validateTargetName(target, DEFAULT_LIMITS);
  if (invalid) throw new TargetTokenError(invalid.message);
  return target;
}
