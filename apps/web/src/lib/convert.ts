import type { Diagnostic, InputFormat, InspectResponse, RecipeLinks } from '@ruhomo/core';
import {
  buildInlineIntegration,
  compile,
  generateJsOverride,
  generateYamlOverride,
  orderTargets,
  providerRulesOf,
} from '@ruhomo/core';

export interface ProviderView {
  target: string;
  name: string;
  ruleCount: number;
  /** Provider text; loaded lazily in URL mode. */
  body?: string;
  url?: string;
}

export interface Conversion {
  mode: 'paste' | 'url';
  providers: ProviderView[];
  diagnostics: Diagnostic[];
  diagnosticsTruncated: boolean;
  ruleCount: number;
  detectedFormat: string;
  /** Override bodies; loaded after inspect in URL mode. */
  yaml?: string;
  js?: string;
  links?: RecipeLinks;
  stale?: boolean;
  lastError?: { code: string; message: string } | null;
  validatedAt?: string;
  notices: string[];
}

export const PASTE_NOTICES = [
  '静态导出：规则以 inline payload 写入覆写，不支持独立规则热更新；修改规则后需要重新生成并重新应用覆写。需要持续热更新请改用 raw URL。',
  '粘贴内容只在浏览器本地转换，不会上传到服务端。',
  '按出站目标分组不是跨目标顺序严格等价的转换：规则重叠时，匹配结果可能因 RULE-SET 顺序而改变。',
];

export type PasteResult = { ok: true; conversion: Conversion } | { ok: false; diagnostics: Diagnostic[] };

/** Converts pasted content entirely in the browser; nothing is uploaded. */
export function convertPasted(text: string, format: InputFormat, targetOrder: string[]): PasteResult {
  const result = compile(text, format);
  if (!result.ok) return { ok: false, diagnostics: result.diagnostics };
  const ordered = orderTargets(result.snapshot, targetOrder);
  const ir = buildInlineIntegration(ordered.targets.map((t) => ({ target: t.target, providerRules: providerRulesOf(t) })));
  const names = new Map(ir.providers.map((p) => [p.target, p.name]));
  return {
    ok: true,
    conversion: {
      mode: 'paste',
      providers: ordered.targets.map((t) => ({ target: t.target, name: names.get(t.target)!, ruleCount: t.ruleCount, body: t.body })),
      diagnostics: [...result.snapshot.diagnostics, ...ordered.diagnostics],
      diagnosticsTruncated: result.snapshot.diagnosticsTruncated,
      ruleCount: result.snapshot.ruleCount,
      detectedFormat: result.snapshot.documentFormat,
      yaml: generateYamlOverride(ir),
      js: generateJsOverride(ir),
      notices: PASTE_NOTICES,
    },
  };
}

export function conversionFromInspect(inspect: InspectResponse): Conversion {
  return {
    mode: 'url',
    providers: inspect.targets.map((t) => ({ target: t.target, name: t.providerName, ruleCount: t.ruleCount, url: t.providerUrl })),
    diagnostics: inspect.diagnostics,
    diagnosticsTruncated: inspect.diagnosticsTruncated,
    ruleCount: inspect.source.ruleCount,
    detectedFormat: inspect.source.detectedFormat,
    links: inspect.links,
    stale: inspect.status.stale,
    lastError: inspect.status.lastError,
    validatedAt: inspect.status.validatedAt,
    notices: inspect.notices,
  };
}

export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const next = [...list];
  const to = index + delta;
  if (to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
