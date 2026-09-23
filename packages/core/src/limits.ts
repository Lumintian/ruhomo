/**
 * Anti-abuse limits. These bound resource usage per conversion; they are not
 * a performance guarantee for any hosting plan.
 */
export interface Limits {
  /** Maximum decoded source size in bytes (UTF-8). */
  maxSourceBytes: number;
  maxRules: number;
  maxTargets: number;
  /** Maximum length of one rule, in UTF-8 bytes. */
  maxRuleBytes: number;
  /** Maximum length of one target name, in Unicode code points. */
  maxTargetChars: number;
  /** Maximum nesting depth of AND/OR/NOT expressions (top level = 1). */
  maxLogicDepth: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxSourceBytes: 256 * 1024,
  maxRules: 5000,
  maxTargets: 128,
  maxRuleBytes: 16 * 1024,
  maxTargetChars: 128,
  maxLogicDepth: 8,
});

/** Recipe / URL limits used by the recipe codec and the HTTP layer. */
export const MAX_SOURCE_URL_BYTES = 2048;
export const MAX_RECIPE_TOKEN_CHARS = 6144;
export const MAX_GENERATED_URL_BYTES = 8192;
export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 7 * 24 * 3600;
export const DEFAULT_INTERVAL_SECONDS = 3600;

export function resolveLimits(partial?: Partial<Limits>): Limits {
  return { ...DEFAULT_LIMITS, ...(partial ?? {}) };
}
