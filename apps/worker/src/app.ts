import type { Diagnostic, Recipe } from '@ruhomo/core';
import {
  COMPILER_VERSION,
  EMPTY_PROVIDER_BODY,
  IntegrationError,
  MAX_GENERATED_URL_BYTES,
  MIHOMO_BASELINE,
  NameCollisionError,
  RecipeError,
  TargetTokenError,
  buildRemoteIntegration,
  decodeRecipe,
  decodeTargetToken,
  encodeRecipe,
  generateJsOverride,
  generateYamlOverride,
  orderTargets,
  recipeId,
  recipeLinks,
  sha256Hex,
  checkSourceUrl,
  utf8Encode,
} from '@ruhomo/core';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Config, Env } from './config.ts';
import { ConfigError, limitsFingerprint, readConfig } from './config.ts';
import type { CacheLike, SnapshotResult } from './snapshot-cache.ts';
import { CacheApiStore, SnapshotLoader, SnapshotUnavailableError } from './snapshot-cache.ts';
import type { LogEvent } from './security.ts';
import { applySecurityHeaders, clientKey, createLogger } from './security.ts';
import { SourceError, fetchSource } from './source-fetcher.ts';

export interface AppDeps {
  /** Fetch used for upstream sources (never receives caller headers). */
  upstreamFetch: typeof fetch;
  /** Returns the Cache API cache, or null when unavailable. */
  cache?: () => CacheLike | null;
  now?: () => number;
  log?: (event: LogEvent) => void;
}

interface Runtime {
  config: Config;
  loader: SnapshotLoader;
  baseUrl: string;
  policy: { allowlist: string[]; denyHosts: string[] };
}

type AppEnv = { Bindings: Env };
type Ctx = Context<AppEnv>;

export const NOTICES = [
  '按出站目标分组不是跨目标顺序严格等价的转换：规则重叠时，匹配结果可能因 RULE-SET 顺序而改变。',
  '“转换结构校验通过”不等于“已由真实 Mihomo 完整验证”；正则与 GEO 数据等依赖消费者环境。',
  '现有目标的规则变化由 Mihomo 按 interval 自行重新下载；新增目标需要重新获取并应用覆写。',
  '缓存是尽力而为的，不是数据库，也不保证多个 provider 同时切换。',
];

const MAX_REQUEST_URL_BYTES = MAX_GENERATED_URL_BYTES + 256;

function errorResponse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  const res = new Response(JSON.stringify({ ok: false, error: { code, message }, ...extra }, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  applySecurityHeaders(res.headers);
  return res;
}

function etagOf(body: string): string {
  return `"${sha256Hex(utf8Encode(body)).slice(0, 32)}"`;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((s) => s.trim().replace(/^W\//, ''))
    .some((s) => s === '*' || s === etag);
}

interface ArtifactMeta {
  result: SnapshotResult;
  ruleCount?: number;
}

function artifactResponse(c: Ctx, body: string, contentType: string, meta: ArtifactMeta): Response {
  const etag = etagOf(body);
  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    ETag: etag,
    'X-Source-Version': meta.result.entry.snapshot.sourceDigest.slice(0, 16),
    'X-Result-Stale': meta.result.stale ? 'true' : 'false',
    'X-Validated-At': new Date(meta.result.entry.validatedAt).toISOString(),
    'X-Cache-Status': meta.result.cacheStatus,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, X-Rule-Count, X-Source-Version, X-Result-Stale, X-Last-Error, X-Validated-At, X-Cache-Status',
  });
  if (meta.ruleCount !== undefined) headers.set('X-Rule-Count', String(meta.ruleCount));
  if (meta.result.lastError) headers.set('X-Last-Error', meta.result.lastError.code);
  applySecurityHeaders(headers);
  if (etagMatches(c.req.header('if-none-match'), etag)) {
    headers.delete('Content-Type');
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status: 200, headers });
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const log = deps.log ?? createLogger();
  const runtimes = new Map<string, Runtime>();

  function runtime(c: Ctx): Runtime {
    const config = readConfig(c.env ?? {});
    const baseUrl = config.publicBaseUrl ?? new URL(c.req.url).origin;
    const memoKey = JSON.stringify([config, baseUrl]);
    const existing = runtimes.get(memoKey);
    if (existing) return existing;
    const selfHosts = [new URL(baseUrl).hostname, new URL(c.req.url).hostname];
    const policy = { allowlist: config.allowlist, denyHosts: [...new Set(selfHosts)] };
    let store: CacheApiStore | undefined;
    try {
      const cache = deps.cache?.() ?? null;
      if (cache) store = new CacheApiStore(cache, baseUrl);
    } catch {
      store = undefined; // Cache API unavailable: fall back to memory + direct fetch
    }
    const loader = new SnapshotLoader({
      limits: config.limits,
      limitsFingerprint: limitsFingerprint(config.limits),
      freshMs: config.freshSeconds * 1000,
      staleMs: config.staleSeconds * 1000,
      store,
      ...(deps.now ? { now: deps.now } : {}),
      log,
      fetchSource: (d, validators) =>
        fetchSource(d.url, {
          fetch: deps.upstreamFetch,
          policy,
          timeoutMs: config.fetchTimeoutMs,
          maxRedirects: config.maxRedirects,
          maxBytes: config.limits.maxSourceBytes,
          validators,
        }),
    });
    const rt = { config, loader, baseUrl, policy };
    if (runtimes.size >= 4) runtimes.clear();
    runtimes.set(memoKey, rt);
    return rt;
  }

  async function withSnapshot(
    c: Ctx,
    route: string,
    render: (rt: Runtime, recipe: Recipe, token: string, result: SnapshotResult) => Response,
  ): Promise<Response> {
    if (utf8Encode(c.req.url).length > MAX_REQUEST_URL_BYTES) {
      return errorResponse(414, 'URL_TOO_LONG', `请求 URL 超过 ${MAX_REQUEST_URL_BYTES} 字节`);
    }
    const rt = runtime(c);
    if (c.env?.RATE_LIMITER) {
      const { success } = await c.env.RATE_LIMITER.limit({ key: clientKey(c.req.raw) });
      if (!success) return errorResponse(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
    }
    const token = c.req.param('token') ?? '';
    let recipe: Recipe;
    try {
      recipe = decodeRecipe(token);
    } catch (e) {
      if (e instanceof RecipeError) return errorResponse(400, e.code, e.message);
      throw e;
    }
    const violation = checkSourceUrl(recipe.source.url, rt.policy);
    if (violation) return errorResponse(403, violation.code, violation.message);

    let result: SnapshotResult;
    try {
      result = await rt.loader.load({ url: recipe.source.url, format: recipe.source.format });
    } catch (e) {
      if (e instanceof SnapshotUnavailableError) {
        log({ evt: 'request', route, status: e.status, code: e.code });
        return errorResponse(e.status, e.code, e.message, e.diagnostics.length ? { diagnostics: e.diagnostics } : {});
      }
      if (e instanceof SourceError) {
        log({ evt: 'request', route, status: e.status, code: e.code, upstream: e.upstreamStatus });
        return errorResponse(e.status, e.code, e.message, e.upstreamStatus ? { upstreamStatus: e.upstreamStatus } : {});
      }
      throw e;
    }
    try {
      const res = render(rt, recipe, token, result);
      log({ evt: 'request', route, status: res.status, stale: result.stale, cache: result.cacheStatus });
      return res;
    } catch (e) {
      if (e instanceof IntegrationError) return errorResponse(400, e.code, e.message);
      if (e instanceof NameCollisionError) return errorResponse(500, 'NAME_COLLISION', 'provider 名称摘要冲突，请调整 recipe');
      throw e;
    }
  }

  function integration(rt: Runtime, recipe: Recipe, result: SnapshotResult) {
    const ordered = orderTargets(result.entry.snapshot, recipe.targetOrder);
    const ir = buildRemoteIntegration({ recipe, baseUrl: rt.baseUrl, targets: ordered.targets.map((t) => t.target) });
    return { ordered, ir };
  }

  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof ConfigError) {
      log({ evt: 'config_error' });
      return errorResponse(500, 'CONFIG_ERROR', '服务部署配置无效');
    }
    log({ evt: 'unhandled_error', path: new URL(c.req.url).pathname.split('/')[1] ?? '', name: err.name });
    return errorResponse(500, 'INTERNAL_ERROR', '内部错误');
  });

  app.get('/api/health', () => {
    const res = Response.json({ ok: true, compilerVersion: COMPILER_VERSION });
    res.headers.set('Cache-Control', 'no-store');
    applySecurityHeaders(res.headers);
    return res;
  });

  app.get('/api/config', (c) => {
    const rt = runtime(c);
    const res = Response.json({
      ok: true,
      publicBaseUrl: rt.baseUrl,
      allowlist: rt.config.allowlist,
      limits: rt.config.limits,
      cache: { freshSeconds: rt.config.freshSeconds, staleSeconds: rt.config.staleSeconds },
      compilerVersion: COMPILER_VERSION,
      mihomoBaseline: MIHOMO_BASELINE,
    });
    res.headers.set('Cache-Control', 'no-cache');
    applySecurityHeaders(res.headers);
    return res;
  });

  app.get('/r/v1/:token/providers/:file', (c) =>
    withSnapshot(c, 'provider', (_rt, _recipe, _token, result) => {
      const file = c.req.param('file');
      if (!file.endsWith('.list')) return errorResponse(404, 'NOT_FOUND', '未知资源');
      let target: string;
      try {
        target = decodeTargetToken(file.slice(0, -'.list'.length));
      } catch (e) {
        if (e instanceof TargetTokenError) return errorResponse(400, 'TARGET_TOKEN_INVALID', e.message);
        throw e;
      }
      // Only reached with a validated snapshot: a missing target is a legal empty set.
      const group = result.entry.snapshot.targets.find((t) => t.target === target);
      const body = group ? group.body : EMPTY_PROVIDER_BODY;
      return artifactResponse(c, body, 'text/plain; charset=utf-8', { result, ruleCount: group?.ruleCount ?? 0 });
    }),
  );

  app.get('/r/v1/:token/override.yaml', (c) =>
    withSnapshot(c, 'override_yaml', (rt, recipe, _token, result) => {
      const { ir } = integration(rt, recipe, result);
      return artifactResponse(c, generateYamlOverride(ir), 'application/yaml; charset=utf-8', { result });
    }),
  );

  app.get('/r/v1/:token/override.js', (c) =>
    withSnapshot(c, 'override_js', (rt, recipe, _token, result) => {
      const { ir } = integration(rt, recipe, result);
      return artifactResponse(c, generateJsOverride(ir), 'text/javascript; charset=utf-8', { result });
    }),
  );

  app.get('/r/v1/:token/inspect.json', (c) =>
    withSnapshot(c, 'inspect', (rt, recipe, token, result) => {
      const { ordered, ir } = integration(rt, recipe, result);
      const s = result.entry.snapshot;
      const diagnostics: Diagnostic[] = [...s.diagnostics, ...ordered.diagnostics];
      const body = {
        ok: true,
        recipe,
        recipeToken: encodeRecipe(recipe) === token ? token : encodeRecipe(recipe),
        recipeId: recipeId(recipe),
        compilerVersion: s.compilerVersion,
        mihomoBaseline: s.mihomoBaseline,
        validation: 'structural',
        status: {
          stale: result.stale,
          cache: result.cacheStatus,
          validatedAt: new Date(result.entry.validatedAt).toISOString(),
          lastError: result.lastError ?? null,
        },
        source: {
          url: recipe.source.url,
          format: recipe.source.format,
          detectedFormat: s.documentFormat,
          digest: s.sourceDigest,
          explicitEmpty: s.explicitEmpty,
          ruleCount: s.ruleCount,
        },
        links: recipeLinks(rt.baseUrl, token),
        targets: ir.providers.map((p) => ({
          target: p.target,
          providerName: p.name,
          ruleCount: ordered.targets.find((t) => t.target === p.target)!.ruleCount,
          providerUrl: (p.definition as { url: string }).url,
        })),
        diagnostics,
        diagnosticsTruncated: s.diagnosticsTruncated,
        notices: NOTICES,
      };
      return artifactResponse(c, `${JSON.stringify(body, null, 2)}\n`, 'application/json; charset=utf-8', { result });
    }),
  );

  // API and recipe routes must never fall through to the SPA.
  app.all('/api/*', () => errorResponse(404, 'NOT_FOUND', '未知接口'));
  app.all('/r/*', (c) =>
    c.req.method === 'GET' || c.req.method === 'HEAD'
      ? errorResponse(404, 'NOT_FOUND', '未知资源')
      : errorResponse(405, 'METHOD_NOT_ALLOWED', '只支持 GET'),
  );
  app.all('*', async (c) => {
    if (c.env?.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return errorResponse(404, 'NOT_FOUND', '未找到');
  });

  return app;
}
