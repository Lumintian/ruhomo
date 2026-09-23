/**
 * Integration IR shared by the YAML and JavaScript generators. It holds only
 * what an override needs: provider definitions, the ordered RULE-SET
 * entries, the namespace and the transport. Remote IR deliberately contains
 * no rule payloads, counts, hashes or timestamps, so its rendering only
 * changes when the recipe, the base URL or the ordered target set changes.
 */
import { utf8ByteLength } from './encoding.ts';
import { MAX_GENERATED_URL_BYTES } from './limits.ts';
import { INLINE_NAMESPACE_ID, assignProviderNames, namespacePrefix, recipeId } from './naming.ts';
import type { Recipe } from './recipe.ts';
import { encodeRecipe, encodeTargetToken } from './recipe.ts';

export type Transport = 'http' | 'inline';

export interface HttpProviderDefinition {
  type: 'http';
  behavior: 'classical';
  format: 'text';
  url: string;
  path: string;
  interval: number;
}

export interface InlineProviderDefinition {
  type: 'inline';
  behavior: 'classical';
  payload: string[];
}

export interface IntegrationProvider {
  name: string;
  target: string;
  definition: HttpProviderDefinition | InlineProviderDefinition;
}

export interface IntegrationIR {
  transport: Transport;
  namespaceId: string;
  namespacePrefix: string;
  /** For http: a path fragment present in every provider URL of this recipe. */
  ownerMarker: string | null;
  providers: IntegrationProvider[];
  /** `RULE-SET,<name>,<target>` in priority order. */
  rules: string[];
}

export class IntegrationError extends Error {
  readonly code: 'BASE_URL_INVALID' | 'URL_TOO_LONG';
  constructor(code: 'BASE_URL_INVALID' | 'URL_TOO_LONG', message: string) {
    super(message);
    this.code = code;
    this.name = 'IntegrationError';
  }
}

/**
 * Normalizes PUBLIC_BASE_URL: http(s) only, no credentials, query or
 * fragment, and no trailing slash, so `${base}/r/v1/...` is always well
 * formed whether or not the deployer configured a trailing slash.
 */
export function normalizeBaseUrl(base: string): string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new IntegrationError('BASE_URL_INVALID', 'PUBLIC_BASE_URL 无法解析');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new IntegrationError('BASE_URL_INVALID', 'PUBLIC_BASE_URL 必须是 http(s)');
  if (u.username || u.password || u.search || u.hash) {
    throw new IntegrationError('BASE_URL_INVALID', 'PUBLIC_BASE_URL 不能包含凭据、查询参数或 fragment');
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export interface RecipeLinks {
  recipeToken: string;
  recipeBase: string;
  overrideYaml: string;
  overrideJs: string;
  inspect: string;
}

function checkLength(url: string): string {
  if (utf8ByteLength(url) > MAX_GENERATED_URL_BYTES) {
    throw new IntegrationError('URL_TOO_LONG', `生成的链接超过 ${MAX_GENERATED_URL_BYTES} 字节，请缩短源 URL 或 targetOrder`);
  }
  return url;
}

export function recipeLinks(baseUrl: string, recipeToken: string): RecipeLinks {
  const recipeBase = `${normalizeBaseUrl(baseUrl)}/r/v1/${recipeToken}`;
  return {
    recipeToken,
    recipeBase,
    overrideYaml: checkLength(`${recipeBase}/override.yaml`),
    overrideJs: checkLength(`${recipeBase}/override.js`),
    inspect: checkLength(`${recipeBase}/inspect.json`),
  };
}

export function providerUrl(baseUrl: string, recipeToken: string, target: string): string {
  return checkLength(`${normalizeBaseUrl(baseUrl)}/r/v1/${recipeToken}/providers/${encodeTargetToken(target)}.list`);
}

export function buildRemoteIntegration(opts: { recipe: Recipe; baseUrl: string; targets: readonly string[] }): IntegrationIR {
  const token = encodeRecipe(opts.recipe);
  const nsId = recipeId(opts.recipe);
  const names = assignProviderNames(nsId, opts.targets);
  const providers: IntegrationProvider[] = opts.targets.map((target) => {
    const name = names.get(target)!;
    return {
      name,
      target,
      definition: {
        type: 'http',
        behavior: 'classical',
        format: 'text',
        url: providerUrl(opts.baseUrl, token, target),
        path: `./rule-providers/${name}.list`,
        interval: opts.recipe.interval,
      },
    };
  });
  return {
    transport: 'http',
    namespaceId: nsId,
    namespacePrefix: namespacePrefix(nsId),
    ownerMarker: `/r/v1/${token}/providers/`,
    providers,
    rules: providers.map((p) => `RULE-SET,${p.name},${p.target}`),
  };
}

/** Static export for pasted content: inline providers, no remote URLs. */
export function buildInlineIntegration(groups: readonly { target: string; providerRules: readonly string[] }[]): IntegrationIR {
  const names = assignProviderNames(
    INLINE_NAMESPACE_ID,
    groups.map((g) => g.target),
  );
  const providers: IntegrationProvider[] = groups.map((g) => ({
    name: names.get(g.target)!,
    target: g.target,
    definition: { type: 'inline', behavior: 'classical', payload: [...g.providerRules] },
  }));
  return {
    transport: 'inline',
    namespaceId: INLINE_NAMESPACE_ID,
    namespacePrefix: namespacePrefix(INLINE_NAMESPACE_ID),
    ownerMarker: null,
    providers,
    rules: providers.map((p) => `RULE-SET,${p.name},${p.target}`),
  };
}
