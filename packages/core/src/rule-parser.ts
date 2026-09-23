/**
 * Independent, strict parser for Mihomo rule strings.
 *
 * Field splitting follows the documented Mihomo v1.19.31 behaviour
 * (rules/common/base.go ParseRulePayload): the rule is split on every comma
 * and each field is trimmed of ASCII spaces only. For ordinary rules the
 * target is the third field and the remaining fields are params; for
 * AND/OR/NOT/DOMAIN-REGEX/PROCESS-NAME-REGEX/PROCESS-PATH-REGEX the target is
 * the last field and everything between the type and the target is payload.
 *
 * Validation is deliberately stricter than the kernel in places where the
 * kernel silently ignores input (unknown params, stray text in logic
 * expressions); see docs/compatibility.md.
 */
import type { Diagnostic, DiagnosticCode, Severity } from './diagnostics.ts';
import { excerpt } from './diagnostics.ts';
import type { RuleLine } from './document-parser.ts';
import { utf8ByteLength } from './encoding.ts';
import { checkPrefix } from './ip.ts';
import type { Limits } from './limits.ts';
import { resolveLimits } from './limits.ts';

export const SUPPORTED_RULE_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-WILDCARD',
  'DOMAIN-REGEX',
  'GEOSITE',
  'GEOIP',
  'SRC-GEOIP',
  'IP-CIDR',
  'IP-CIDR6',
  'SRC-IP-CIDR',
  'IP-SUFFIX',
  'SRC-IP-SUFFIX',
  'IP-ASN',
  'SRC-IP-ASN',
  'SRC-PORT',
  'DST-PORT',
  'IN-PORT',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME-WILDCARD',
  'PROCESS-PATH-WILDCARD',
  'NETWORK',
  'UID',
  'DSCP',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'REMATCH-NAME',
  'AND',
  'OR',
  'NOT',
] as const;

export type RuleType = (typeof SUPPORTED_RULE_TYPES)[number];

/** Rejected by this project at the top level (MATCH/RULE-SET/SUB-RULE). */
export const FORBIDDEN_RULE_TYPES = ['MATCH', 'RULE-SET', 'SUB-RULE'] as const;

const SUPPORTED = new Set<string>(SUPPORTED_RULE_TYPES);
const FORBIDDEN = new Set<string>(FORBIDDEN_RULE_TYPES);
const COMMA_PAYLOAD = new Set<string>(['AND', 'OR', 'NOT', 'DOMAIN-REGEX', 'PROCESS-NAME-REGEX', 'PROCESS-PATH-REGEX']);
const REGEX = new Set<string>(['DOMAIN-REGEX', 'PROCESS-NAME-REGEX', 'PROCESS-PATH-REGEX']);

/** Types that honour `no-resolve` / `src` (rules/parser.go uses ParseParams). */
const IP_PARAM_TYPES = new Set<string>(['GEOIP', 'IP-ASN', 'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX']);
/** Source-IP variants: the kernel ignores params, they are redundant at best. */
const SRC_IP_TYPES = new Set<string>(['SRC-GEOIP', 'SRC-IP-ASN', 'SRC-IP-CIDR', 'SRC-IP-SUFFIX']);
const KNOWN_PARAMS = new Set(['no-resolve', 'src']);

/** Built-in outbound names in Mihomo (case-sensitive in the proxies map). */
const BUILTIN_TARGETS = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL'];

/** Inbound types accepted by constant.ParseType in v1.19.31, plus SOCKS. */
const IN_TYPES = new Set([
  'SOCKS',
  'HTTP',
  'HTTPS',
  'SOCKS4',
  'SOCKS5',
  'SHADOWSOCKS',
  'SNELL',
  'VMESS',
  'VLESS',
  'REDIR',
  'TPROXY',
  'TROJAN',
  'TUNNEL',
  'TUN',
  'TUIC',
  'HYSTERIA2',
  'ANYTLS',
  'MIERU',
  'SUDOKU',
  'TRUSTTUNNEL',
  'SHADOWQUIC',
  'INNER',
]);

// C0 controls, DEL, NEL and the Unicode line/paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

export interface SubRule {
  type: RuleType;
  payload: string;
  params: string[];
  children?: SubRule[];
}

export interface ParsedRule {
  raw: string;
  type: RuleType;
  payload: string;
  target: string;
  params: string[];
  sourceIndex: number;
  line: number;
  column?: number;
  /** The rule as written into a classical text provider: target removed. */
  providerRule: string;
  validationWarnings: Diagnostic[];
  /** Parsed sub-rules for AND/OR/NOT. */
  children?: SubRule[];
}

export interface RuleParseResult {
  rule?: ParsedRule;
  diagnostics: Diagnostic[];
}

/** Mirrors Go's strings.Trim(s, " "): only U+0020 is removed. */
function trimSpaces(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 32) start++;
  while (end > start && s.charCodeAt(end - 1) === 32) end--;
  return s.slice(start, end);
}

class RuleContext {
  readonly diagnostics: Diagnostic[] = [];
  readonly location: Pick<Diagnostic, 'line' | 'column' | 'sourceIndex'>;
  readonly limits: Limits;
  constructor(location: Pick<Diagnostic, 'line' | 'column' | 'sourceIndex'>, limits: Limits) {
    this.location = location;
    this.limits = limits;
  }

  report(severity: Severity, code: DiagnosticCode, message: string, extra: Partial<Diagnostic> = {}): void {
    this.diagnostics.push({ ...this.location, ...extra, severity, code, message });
  }
  error(code: DiagnosticCode, message: string): void {
    this.report('error', code, message);
  }
  warn(code: DiagnosticCode, message: string): void {
    this.report('warning', code, message);
  }
  get failed(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }
}

export function validateTargetName(target: string, limits: Limits): { code: DiagnosticCode; message: string } | undefined {
  if (target === '') return { code: 'MISSING_TARGET', message: '缺少出站目标' };
  if (CONTROL_CHARS.test(target)) return { code: 'INVALID_TARGET', message: '出站目标包含控制字符' };
  if (target.includes(',')) return { code: 'INVALID_TARGET', message: '出站目标不能包含逗号' };
  if (trimSpaces(target) !== target) return { code: 'INVALID_TARGET', message: '出站目标首尾不能有空格' };
  if (Array.from(target).length > limits.maxTargetChars) {
    return { code: 'INVALID_TARGET', message: `出站目标超过 ${limits.maxTargetChars} 个字符` };
  }
  return undefined;
}

function checkTarget(target: string, ctx: RuleContext): void {
  const invalid = validateTargetName(target, ctx.limits);
  if (invalid) {
    ctx.error(invalid.code, invalid.message);
    return;
  }
  if (KNOWN_PARAMS.has(target)) {
    ctx.error('INVALID_TARGET', `出站目标 "${target}" 看起来是规则参数，可能遗漏了出站目标字段`);
    return;
  }
  const upper = target.toUpperCase();
  if (target !== upper && BUILTIN_TARGETS.includes(upper)) {
    ctx.warn('TARGET_CASE_BUILTIN', `出站目标 "${target}" 与内置策略 ${upper} 仅大小写不同；Mihomo 区分大小写，不会自动匹配`);
  }
}

/**
 * Port / UID / DSCP ranges, following common/utils/ranges.go: `/`-separated
 * segments, each a number or `a-b`, surrounding `[ ]` stripped, at most 28
 * segments. Values above the type's maximum are rejected here even though
 * the kernel would silently wrap them.
 */
function checkRanges(payload: string, max: number, allowStar: boolean): string | undefined {
  const s = payload.trim();
  if (s === '*') return allowStar ? undefined : '不支持 "*"';
  if (s === '') return '范围为空';
  const list = s.split('/');
  if (list.length > 28) return '最多支持 28 个范围段';
  let count = 0;
  for (const seg of list) {
    if (seg === '') continue;
    const t = seg.trim();
    if (t === '') return '范围段为空';
    const parts = t.split('-');
    if (parts.length > 2) return `范围 "${t}" 无效`;
    for (const p of parts) {
      const v = p.replace(/^[[\] ]+|[[\] ]+$/g, '');
      if (!/^\d+$/.test(v)) return `数值 "${p}" 无效`;
      if (Number(v) > max) return `数值 ${v} 超过上限 ${max}`;
    }
    count++;
  }
  if (count === 0) return '范围为空';
  return undefined;
}

function checkSlashList(payload: string, what: string): string | undefined {
  for (const item of payload.split('/')) {
    if (item.trim() === '') return `${what}不能为空`;
  }
  return undefined;
}

function checkParams(type: string, params: string[], ctx: RuleContext, inLogic: boolean): void {
  if (params.length === 0) return;
  if (params.some((p) => p === '')) {
    ctx.error('EMPTY_FIELD', '存在空字段（多余的逗号）');
    return;
  }
  if (!IP_PARAM_TYPES.has(type) && !SRC_IP_TYPES.has(type)) {
    ctx.error(
      'UNEXPECTED_FIELD',
      inLogic
        ? `逻辑子规则 ${type} 不接受额外字段 "${excerpt(params.join(','), 40)}"（子规则没有出站目标）`
        : `${type} 不接受额外参数 "${excerpt(params.join(','), 40)}"，字段数量错误`,
    );
    return;
  }
  const seen = new Set<string>();
  for (const p of params) {
    if (!KNOWN_PARAMS.has(p)) {
      const hint = KNOWN_PARAMS.has(p.toLowerCase()) ? '（参数区分大小写，应为小写）' : '（仅支持 no-resolve、src）';
      ctx.error('UNKNOWN_PARAM', `未知参数 "${excerpt(p, 40)}"${hint}`);
      continue;
    }
    if (seen.has(p)) ctx.warn('DUPLICATE_PARAM', `参数 "${p}" 重复`);
    seen.add(p);
    if (SRC_IP_TYPES.has(type)) {
      ctx.warn('REDUNDANT_PARAM', `${type} 本身按源 IP 匹配，参数 "${p}" 会被 Mihomo 忽略`);
    }
  }
}

function checkPayload(type: RuleType, payload: string, ctx: RuleContext, depth: number, trimmed: boolean): SubRule[] | undefined {
  const fail = (msg: string) => ctx.error('INVALID_PAYLOAD', `${type} 的内容无效：${msg}`);
  switch (type) {
    case 'DOMAIN':
    case 'DOMAIN-SUFFIX':
    case 'DOMAIN-KEYWORD':
    case 'DOMAIN-WILDCARD':
      if (/\s/.test(payload)) ctx.warn('SUSPICIOUS_PAYLOAD', `${type} 的内容包含空白字符，通常不会匹配任何域名`);
      return undefined;
    case 'DOMAIN-REGEX':
    case 'PROCESS-NAME-REGEX':
    case 'PROCESS-PATH-REGEX':
      ctx.warn(
        'REGEX_SEMANTICS_NOT_VALIDATED',
        `${type} 的正则按原样保留；Mihomo 使用 regexp2（忽略大小写），本工具未验证其语义`,
      );
      if (trimmed) {
        ctx.warn('PAYLOAD_WHITESPACE_TRIMMED', '正则中紧邻逗号的空格会被 Mihomo 按字段裁剪掉，输出与内核实际使用的正则一致');
      }
      return undefined;
    case 'GEOSITE':
      ctx.warn('GEODATA_DEPENDENCY', 'GEOSITE 依赖消费者本地的 geosite 数据，本工具不下载或管理 geodata');
      return undefined;
    case 'GEOIP':
    case 'SRC-GEOIP':
      if (payload.toLowerCase() !== 'lan') {
        ctx.warn('GEODATA_DEPENDENCY', `${type} 依赖消费者本地的 GeoIP 数据，本工具不下载或管理 geodata`);
      }
      return undefined;
    case 'IP-ASN':
    case 'SRC-IP-ASN':
      if (!/^\d+$/.test(payload)) {
        fail('ASN 必须是十进制数字，例如 13335');
        return undefined;
      }
      ctx.warn('GEODATA_DEPENDENCY', `${type} 依赖消费者本地的 ASN 数据库，本工具不下载或管理 geodata`);
      return undefined;
    case 'IP-CIDR':
    case 'IP-CIDR6':
    case 'SRC-IP-CIDR':
    case 'IP-SUFFIX':
    case 'SRC-IP-SUFFIX': {
      const err = checkPrefix(payload);
      if (err) fail(err);
      return undefined;
    }
    case 'SRC-PORT':
    case 'DST-PORT':
    case 'IN-PORT': {
      const err = checkRanges(payload, 65535, false);
      if (err) fail(err);
      return undefined;
    }
    case 'DSCP': {
      const err = checkRanges(payload, 63, true);
      if (err) fail(err);
      return undefined;
    }
    case 'UID': {
      const err = checkRanges(payload, 0xffffffff, false);
      if (err) fail(err);
      ctx.warn('PLATFORM_DEPENDENT', 'UID 规则仅在 Linux/Android 内核上可用，其他平台加载时会报错');
      return undefined;
    }
    case 'NETWORK':
      if (!['TCP', 'UDP'].includes(payload.toUpperCase())) fail('只支持 tcp 或 udp');
      return undefined;
    case 'IN-TYPE': {
      for (const t of payload.split('/')) {
        const u = t.trim().toUpperCase();
        if (u === '') {
          fail('入站类型不能为空');
          return undefined;
        }
        if (!IN_TYPES.has(u)) {
          fail(`未知入站类型 "${excerpt(t.trim(), 30)}"`);
          return undefined;
        }
      }
      return undefined;
    }
    case 'IN-USER':
    case 'IN-NAME':
    case 'REMATCH-NAME': {
      const err = checkSlashList(payload, '名称');
      if (err) fail(err);
      return undefined;
    }
    case 'PROCESS-NAME':
    case 'PROCESS-PATH':
    case 'PROCESS-NAME-WILDCARD':
    case 'PROCESS-PATH-WILDCARD':
      return undefined;
    case 'AND':
    case 'OR':
    case 'NOT':
      return parseLogic(type, payload, ctx, depth);
  }
}

interface Range {
  start: number;
  end: number;
}

/**
 * Logic payload structure. The kernel pairs parentheses without any escape
 * syntax (rules/logic/logic.go format/findSubRuleRange); the same pairing is
 * used here so that sub-rule boundaries are identical. In addition this
 * parser requires the whole payload to be wrapped in one pair and only
 * commas (and spaces) between sub-rules, instead of silently ignoring text.
 */
function parseLogic(type: 'AND' | 'OR' | 'NOT', payload: string, ctx: RuleContext, depth: number): SubRule[] | undefined {
  if (depth > ctx.limits.maxLogicDepth) {
    ctx.error('LOGIC_TOO_DEEP', `逻辑规则嵌套超过 ${ctx.limits.maxLogicDepth} 层`);
    return undefined;
  }
  const stack: number[] = [];
  const ranges: Range[] = [];
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (c === '(') stack.push(i);
    else if (c === ')') {
      const start = stack.pop();
      if (start === undefined) {
        ctx.error('LOGIC_UNBALANCED_PARENS', `${type} 的括号不匹配：缺少 "("`);
        return undefined;
      }
      ranges.push({ start, end: i });
    }
  }
  if (stack.length > 0) {
    ctx.error('LOGIC_UNBALANCED_PARENS', `${type} 的括号不匹配：缺少 ")"`);
    return undefined;
  }
  const last = payload.length - 1;
  if (!ranges.some((r) => r.start === 0 && r.end === last)) {
    ctx.error('LOGIC_SYNTAX', `${type} 的内容必须整体用一对括号包裹，例如 ((DOMAIN,example.com),(DST-PORT,443))`);
    return undefined;
  }
  ranges.sort((a, b) => a.start - b.start);
  const children: Range[] = [];
  for (const r of ranges) {
    if (r.start === 0 && r.end === last) continue;
    if (!children.some((c) => c.start < r.start && c.end > r.end)) children.push(r);
  }
  if (children.length === 0) {
    ctx.error('LOGIC_EMPTY', `${type} 至少需要一个子规则`);
    return undefined;
  }
  let cursor = 1;
  for (let i = 0; i < children.length; i++) {
    const gap = payload.slice(cursor, children[i]!.start);
    if (!(i === 0 ? /^ *$/ : /^ *, *$/).test(gap)) {
      ctx.error('LOGIC_SYNTAX', `${type} 的子规则之间只能用逗号分隔，发现多余内容 "${excerpt(gap, 30)}"`);
      return undefined;
    }
    cursor = children[i]!.end + 1;
  }
  if (!/^ *$/.test(payload.slice(cursor, last))) {
    ctx.error('LOGIC_SYNTAX', `${type} 的最后一个子规则之后有多余内容`);
    return undefined;
  }
  if (type === 'NOT' && children.length !== 1) {
    ctx.error('LOGIC_NOT_ARITY', `NOT 只能包含一个子规则，实际为 ${children.length} 个`);
    return undefined;
  }
  const subs: SubRule[] = [];
  for (const c of children) {
    const sub = parseSubRule(payload.slice(c.start + 1, c.end), ctx, depth + 1);
    if (!sub) return undefined;
    subs.push(sub);
  }
  return subs;
}

/** A sub-rule inside AND/OR/NOT: `TYPE,payload[,params]`, no target. */
function parseSubRule(text: string, ctx: RuleContext, depth: number): SubRule | undefined {
  const fields = text.split(',').map(trimSpaces);
  const type = fields[0]!.toUpperCase();
  if (type === '') {
    ctx.error('LOGIC_SYNTAX', '逻辑规则中存在空的子规则');
    return undefined;
  }
  if (FORBIDDEN.has(type)) {
    ctx.error(
      'LOGIC_FORBIDDEN_SUBRULE',
      type === 'RULE-SET'
        ? '本项目不允许在逻辑子规则中引用外部 RULE-SET（这是本工具的约束）'
        : `逻辑规则中不能使用 ${type}`,
    );
    return undefined;
  }
  if (!SUPPORTED.has(type)) {
    ctx.error('UNKNOWN_RULE_TYPE', `不支持的子规则类型 "${excerpt(fields[0]!, 30)}"`);
    return undefined;
  }
  const t = type as RuleType;
  let payload: string;
  let params: string[] = [];
  if (COMMA_PAYLOAD.has(t)) {
    payload = fields.slice(1).join(',');
  } else {
    payload = fields[1] ?? '';
    params = fields.slice(2);
  }
  if (payload === '') {
    ctx.error('MISSING_PAYLOAD', `子规则 ${t} 缺少内容`);
    return undefined;
  }
  if (REGEX.has(t)) {
    ctx.warn(
      'LOGIC_NESTED_REGEX',
      'Mihomo 按括号配对切分逻辑规则，嵌套正则中的括号（包括字符类和转义形式）也参与配对；本工具按相同算法切分，但此组合未经真实内核完整验证',
    );
  }
  const trimmed = COMMA_PAYLOAD.has(t) && text.split(',').slice(1).some((f) => f !== trimSpaces(f));
  checkParams(t, params, ctx, true);
  const children = checkPayload(t, payload, ctx, depth, trimmed);
  if (ctx.failed) return undefined;
  return children ? { type: t, payload, params, children } : { type: t, payload, params };
}

export function parseRule(line: RuleLine, limitsInput?: Partial<Limits>): RuleParseResult {
  const limits = resolveLimits(limitsInput);
  const ctx = new RuleContext({ line: line.line, column: line.column, sourceIndex: line.sourceIndex }, limits);
  const raw = line.raw;
  const done = (): RuleParseResult => ({ diagnostics: ctx.diagnostics });

  if (utf8ByteLength(raw) > limits.maxRuleBytes) {
    ctx.error('RULE_TOO_LONG', `单条规则超过 ${limits.maxRuleBytes} 字节上限`);
    return done();
  }
  if (CONTROL_CHARS.test(raw)) {
    ctx.error('CONTROL_CHARACTER', '规则包含控制字符（如制表符或换行）');
    return done();
  }
  if (raw.trim() === '') {
    ctx.error('EMPTY_RULE', '规则为空');
    return done();
  }
  const rawFields = raw.split(',');
  const fields = rawFields.map(trimSpaces);
  const typeText = fields[0]!;
  const type = typeText.toUpperCase();
  if (FORBIDDEN.has(type)) {
    ctx.error('FORBIDDEN_RULE_TYPE', `本工具不接受 ${type} 规则（MATCH、RULE-SET、SUB-RULE 必须留在原配置中）`);
    return done();
  }
  if (!SUPPORTED.has(type)) {
    ctx.error('UNKNOWN_RULE_TYPE', typeText === '' ? '规则类型为空' : `不支持的规则类型 "${excerpt(typeText, 30)}"`);
    return done();
  }
  const t = type as RuleType;

  let payload: string;
  let target: string;
  let params: string[] = [];
  let providerFields: string[];
  let trimmed = false;
  if (COMMA_PAYLOAD.has(t)) {
    if (fields.length === 2) {
      ctx.error('MISSING_TARGET', `${t} 缺少内容或出站目标（该类型的出站目标是最后一个字段）`);
      return done();
    }
    if (fields.length < 2 || fields.slice(1, -1).join(',') === '') {
      ctx.error('MISSING_PAYLOAD', `${t} 缺少内容`);
      return done();
    }
    target = fields[fields.length - 1]!;
    const payloadFields = fields.slice(1, -1);
    payload = payloadFields.join(',');
    trimmed = rawFields.slice(1, -1).some((f) => f !== trimSpaces(f));
    providerFields = [t, ...payloadFields];
  } else {
    if (fields.length < 2 || fields[1] === '') {
      ctx.error('MISSING_PAYLOAD', `${t} 缺少内容`);
      return done();
    }
    if (fields.length < 3) {
      ctx.error('MISSING_TARGET', `${t} 缺少出站目标（应为 ${t},内容,出站目标）`);
      return done();
    }
    payload = fields[1]!;
    target = fields[2]!;
    params = fields.slice(3);
    providerFields = [t, payload, ...params];
  }

  checkTarget(target, ctx);
  checkParams(t, params, ctx, false);
  const children = checkPayload(t, payload, ctx, 1, trimmed);
  if (ctx.failed) return done();

  const rule: ParsedRule = {
    raw,
    type: t,
    payload,
    target,
    params,
    sourceIndex: line.sourceIndex,
    line: line.line,
    column: line.column,
    providerRule: providerFields.join(','),
    validationWarnings: ctx.diagnostics.map((d) => ({ ...d, target })),
  };
  if (children) rule.children = children;
  return { rule, diagnostics: rule.validationWarnings };
}
