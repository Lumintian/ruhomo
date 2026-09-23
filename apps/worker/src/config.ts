import type { Limits } from '@ruhomo/core';
import { DEFAULT_LIMITS, DEFAULT_SOURCE_ALLOWLIST, normalizeBaseUrl, parseAllowlist } from '@ruhomo/core';

/** Minimal shape of the Workers Rate Limiting binding (optional). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Minimal shape of the static assets binding. */
export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  ASSETS?: AssetsFetcher;
  RATE_LIMITER?: RateLimiter;
  PUBLIC_BASE_URL?: string;
  SOURCE_ALLOWLIST?: string;
  CACHE_FRESH_SECONDS?: string;
  CACHE_STALE_SECONDS?: string;
  FETCH_TIMEOUT_MS?: string;
  MAX_REDIRECTS?: string;
  MAX_SOURCE_BYTES?: string;
  MAX_RULES?: string;
  MAX_TARGETS?: string;
  MAX_RULE_BYTES?: string;
}

export interface Config {
  /** Normalized PUBLIC_BASE_URL, or undefined to use the request origin. */
  publicBaseUrl: string | undefined;
  allowlist: string[];
  freshSeconds: number;
  staleSeconds: number;
  fetchTimeoutMs: number;
  maxRedirects: number;
  limits: Limits;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function intVar(env: Env, name: keyof Env, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) throw new ConfigError(`${String(name)} must be an integer`);
  const n = Number(raw.trim());
  if (n < min || n > max) throw new ConfigError(`${String(name)} must be between ${min} and ${max}`);
  return n;
}

/**
 * Reads deployment configuration. All limits are bounded so a
 * misconfiguration cannot turn the service into an amplifier; values come
 * only from the deployment, never from request parameters.
 */
export function readConfig(env: Env): Config {
  let allowlist: string[];
  try {
    allowlist = parseAllowlist(env.SOURCE_ALLOWLIST ?? DEFAULT_SOURCE_ALLOWLIST);
  } catch (e) {
    throw new ConfigError(`SOURCE_ALLOWLIST: ${(e as Error).message}`);
  }
  let publicBaseUrl: string | undefined;
  if (env.PUBLIC_BASE_URL) {
    try {
      publicBaseUrl = normalizeBaseUrl(env.PUBLIC_BASE_URL);
    } catch (e) {
      throw new ConfigError((e as Error).message);
    }
  }
  return {
    publicBaseUrl,
    allowlist,
    freshSeconds: intVar(env, 'CACHE_FRESH_SECONDS', 60, 0, 3600),
    staleSeconds: intVar(env, 'CACHE_STALE_SECONDS', 86400, 0, 7 * 86400),
    fetchTimeoutMs: intVar(env, 'FETCH_TIMEOUT_MS', 10_000, 1000, 30_000),
    maxRedirects: intVar(env, 'MAX_REDIRECTS', 3, 0, 5),
    limits: {
      ...DEFAULT_LIMITS,
      maxSourceBytes: intVar(env, 'MAX_SOURCE_BYTES', DEFAULT_LIMITS.maxSourceBytes, 1024, 1024 * 1024),
      maxRules: intVar(env, 'MAX_RULES', DEFAULT_LIMITS.maxRules, 1, 20_000),
      maxTargets: intVar(env, 'MAX_TARGETS', DEFAULT_LIMITS.maxTargets, 1, 512),
      maxRuleBytes: intVar(env, 'MAX_RULE_BYTES', DEFAULT_LIMITS.maxRuleBytes, 256, 64 * 1024),
    },
  };
}

/** Stable fingerprint of everything that influences a compiled snapshot. */
export function limitsFingerprint(limits: Limits): string {
  return [limits.maxSourceBytes, limits.maxRules, limits.maxTargets, limits.maxRuleBytes, limits.maxTargetChars, limits.maxLogicDepth].join(
    ':',
  );
}
