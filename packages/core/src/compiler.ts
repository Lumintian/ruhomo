import type { Diagnostic } from './diagnostics.ts';
import { DiagnosticBag, excerpt } from './diagnostics.ts';
import type { DocumentFormat, InputFormat } from './document-parser.ts';
import { parseDocument } from './document-parser.ts';
import { sha256Hex } from './encoding.ts';
import type { Limits } from './limits.ts';
import { resolveLimits } from './limits.ts';
import type { ParsedRule } from './rule-parser.ts';
import { parseRule } from './rule-parser.ts';

/** Bumped whenever parsing or provider output may change for the same input. */
export const COMPILER_VERSION = 'ruhomo-compiler/1';
/** The Mihomo release whose rule semantics this compiler follows. */
export const MIHOMO_BASELINE = 'v1.19.31';

/** Body served for a target that has no rules in a successfully validated source. */
export const EMPTY_PROVIDER_BODY = '# empty\n';

export interface TargetGroup {
  target: string;
  /** Index of the first rule of this target in the source. */
  firstIndex: number;
  ruleCount: number;
  /** Source rule indexes in source order. */
  sourceIndexes: number[];
  /** Classical text provider body: one rule per line, LF, trailing newline. */
  body: string;
}

/**
 * Immutable result of one successful compilation. Targets are listed in
 * first-occurrence order; apply {@link orderTargets} for a recipe's order.
 */
export interface Snapshot {
  compilerVersion: string;
  mihomoBaseline: string;
  sourceDigest: string;
  documentFormat: DocumentFormat;
  explicitEmpty: boolean;
  ruleCount: number;
  targets: TargetGroup[];
  /** Warnings only; a snapshot never contains errors. */
  diagnostics: Diagnostic[];
  diagnosticsTruncated: boolean;
}

export type CompileResult =
  | { ok: true; snapshot: Snapshot; rules: ParsedRule[] }
  | { ok: false; diagnostics: Diagnostic[]; diagnosticsTruncated: boolean };

export function renderProviderBody(providerRules: readonly string[]): string {
  return providerRules.length === 0 ? EMPTY_PROVIDER_BODY : `${providerRules.join('\n')}\n`;
}

/**
 * Parses and groups a complete document. Any error fails the whole
 * compilation; there is no partial result.
 */
export function compile(text: string, format: InputFormat = 'auto', limitsInput?: Partial<Limits>): CompileResult {
  const limits = resolveLimits(limitsInput);
  const parsed = parseDocument(text, format, limits);
  const bag = parsed.diagnostics;
  const fail = (): CompileResult => ({ ok: false, diagnostics: bag.items, diagnosticsTruncated: bag.truncated });
  if (!parsed.document || bag.hasErrors) return fail();

  const rules: ParsedRule[] = [];
  for (const line of parsed.document.rules) {
    const r = parseRule(line, limits);
    for (const d of r.diagnostics) bag.add(d);
    if (r.rule) rules.push(r.rule);
  }
  if (bag.hasErrors) return fail();

  const groups = new Map<string, { firstIndex: number; rules: ParsedRule[] }>();
  for (const rule of rules) {
    let g = groups.get(rule.target);
    if (!g) {
      g = { firstIndex: rule.sourceIndex, rules: [] };
      groups.set(rule.target, g);
    }
    g.rules.push(rule);
  }
  if (groups.size > limits.maxTargets) {
    bag.error('TOO_MANY_TARGETS', `出站目标数量 ${groups.size} 超过上限 ${limits.maxTargets}`);
    return fail();
  }

  reportDuplicates(rules, bag);

  const targets: TargetGroup[] = [...groups.entries()].map(([target, g]) => ({
    target,
    firstIndex: g.firstIndex,
    ruleCount: g.rules.length,
    sourceIndexes: g.rules.map((r) => r.sourceIndex),
    body: renderProviderBody(g.rules.map((r) => r.providerRule)),
  }));

  return {
    ok: true,
    rules,
    snapshot: {
      compilerVersion: COMPILER_VERSION,
      mihomoBaseline: MIHOMO_BASELINE,
      sourceDigest: sha256Hex(text),
      documentFormat: parsed.document.format,
      explicitEmpty: parsed.document.explicitEmpty,
      ruleCount: rules.length,
      targets,
      diagnostics: bag.items,
      diagnosticsTruncated: bag.truncated,
    },
  };
}

function reportDuplicates(rules: ParsedRule[], bag: DiagnosticBag): void {
  const seen = new Map<string, ParsedRule>();
  for (const rule of rules) {
    const prev = seen.get(rule.providerRule);
    if (!prev) {
      seen.set(rule.providerRule, rule);
      continue;
    }
    const where = { line: rule.line, column: rule.column, sourceIndex: rule.sourceIndex, target: rule.target };
    if (prev.target === rule.target) {
      bag.warn('DUPLICATE_RULE', `与第 ${prev.line} 行完全相同的规则（未自动去重）`, where);
    } else {
      bag.warn(
        'DUPLICATE_CONDITION_DIFFERENT_TARGET',
        `匹配条件 "${excerpt(rule.providerRule, 60)}" 与第 ${prev.line} 行相同，但出站目标不同（"${excerpt(prev.target, 30)}" / "${excerpt(rule.target, 30)}"）；分组后哪一个生效取决于 RULE-SET 顺序`,
        where,
      );
    }
  }
}

export interface OrderedTargets {
  targets: TargetGroup[];
  diagnostics: Diagnostic[];
}

/**
 * Orders provider groups: targets listed in `targetOrder` first (in that
 * order), then the remaining targets by first occurrence. Entries that do
 * not match an actual target are reported and ignored; they never create a
 * provider.
 */
export function orderTargets(snapshot: Pick<Snapshot, 'targets' | 'ruleCount'>, targetOrder: readonly string[] = []): OrderedTargets {
  const byName = new Map(snapshot.targets.map((t) => [t.target, t]));
  const ordered: TargetGroup[] = [];
  const used = new Set<string>();
  const bag = new DiagnosticBag();
  for (const name of targetOrder) {
    const g = byName.get(name);
    if (!g) {
      bag.warn('TARGET_ORDER_UNUSED', `targetOrder 中的 "${excerpt(name, 40)}" 不是当前源中的出站目标，已忽略`, { target: name });
      continue;
    }
    if (used.has(name)) continue;
    used.add(name);
    ordered.push(g);
  }
  const rest = snapshot.targets.filter((t) => !used.has(t.target)).sort((a, b) => a.firstIndex - b.firstIndex);
  ordered.push(...rest);

  const sequence = ordered.flatMap((t) => t.sourceIndexes);
  let moved = 0;
  sequence.forEach((sourceIndex, position) => {
    if (sourceIndex !== position) moved++;
  });
  if (moved > 0) {
    bag.warn(
      'ORDER_CHANGED_BY_GROUPING',
      `按出站目标分组后，有 ${moved} 条规则的相对位置发生变化。分组不是跨目标顺序严格等价的转换，规则重叠时匹配结果可能因 RULE-SET 顺序而改变`,
    );
  }
  return { targets: ordered, diagnostics: bag.items };
}

/** Provider rules (target removed) of a group, recovered from its body. */
export function providerRulesOf(group: Pick<TargetGroup, 'body' | 'ruleCount'>): string[] {
  return group.ruleCount === 0 ? [] : group.body.slice(0, -1).split('\n');
}
