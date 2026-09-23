import { LineCounter, isAlias, isMap, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';
import type { Node as YamlNode, YAMLError } from 'yaml';
import { DiagnosticBag, excerpt } from './diagnostics.ts';
import { utf8ByteLength } from './encoding.ts';
import type { Limits } from './limits.ts';
import { resolveLimits } from './limits.ts';

export type InputFormat = 'auto' | 'yaml' | 'text';
export type DocumentFormat = 'yaml' | 'text';

export const INPUT_FORMATS: readonly InputFormat[] = ['auto', 'yaml', 'text'];

/** The only accepted way to publish an intentionally empty text document. */
export const EMPTY_MARKER = '# mrp:empty';

export interface RuleLine {
  /** Rule string exactly as it appears in the document (text: trimmed line). */
  raw: string;
  line: number;
  column: number;
  sourceIndex: number;
}

export interface ParsedDocument {
  format: DocumentFormat;
  rules: RuleLine[];
  /** True for `rules: []` or a text document holding only `# mrp:empty`. */
  explicitEmpty: boolean;
}

export interface DocumentParseResult {
  document?: ParsedDocument;
  diagnostics: DiagnosticBag;
}

/**
 * Top-level keys that indicate a complete Mihomo/Clash config (or a fragment
 * of one). The service intentionally never accepts those.
 */
const FULL_CONFIG_KEYS = new Set([
  'proxies',
  'proxy-providers',
  'proxy-groups',
  'rule-providers',
  'sub-rules',
  'dns',
  'hosts',
  'tun',
  'sniffer',
  'listeners',
  'tunnels',
  'ntp',
  'mode',
  'port',
  'socks-port',
  'mixed-port',
  'redir-port',
  'tproxy-port',
  'allow-lan',
  'bind-address',
  'log-level',
  'ipv6',
  'external-controller',
  'external-ui',
  'secret',
  'profile',
  'experimental',
  'geodata-mode',
  'geox-url',
  'find-process-mode',
  'global-client-fingerprint',
]);

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitLines(text: string): string[] {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isCommentOrBlank(trimmed: string): boolean {
  return trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//');
}

interface FirstLine {
  text: string;
  line: number;
}

function firstSignificantLine(lines: string[]): FirstLine | undefined {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (!isCommentOrBlank(t)) return { text: t, line: i + 1 };
  }
  return undefined;
}

const YAML_KEY_LINE = /^[A-Za-z0-9_.-]+[ \t]*:([ \t]|$)/;

/**
 * Deterministic format detection used by `auto`:
 *  - `---`, `%` directives, `- item` and `key:` lines select YAML;
 *  - everything else is text.
 * HTML and JSON-looking inputs are rejected separately, before detection.
 */
export function detectFormat(text: string): DocumentFormat {
  const first = firstSignificantLine(splitLines(stripBom(text)));
  if (!first) return 'text';
  const t = first.text;
  if (t.startsWith('---') || t.startsWith('%')) return 'yaml';
  if (t === '-' || t.startsWith('- ') || t.startsWith('-\t')) return 'yaml';
  if (YAML_KEY_LINE.test(t)) return 'yaml';
  return 'text';
}

function codePointColumn(line: string, utf16Index: number): number {
  return Array.from(line.slice(0, utf16Index)).length + 1;
}

export function parseDocument(
  input: string,
  format: InputFormat = 'auto',
  limitsInput?: Partial<Limits>,
): DocumentParseResult {
  const limits = resolveLimits(limitsInput);
  const diagnostics = new DiagnosticBag();

  if (utf8ByteLength(input) > limits.maxSourceBytes) {
    diagnostics.error('INPUT_TOO_LARGE', `输入超过 ${limits.maxSourceBytes} 字节上限`);
    return { diagnostics };
  }

  const text = stripBom(input);
  const lines = splitLines(text);
  const first = firstSignificantLine(lines);

  if (first) {
    if (first.text.startsWith('<')) {
      diagnostics.error('SOURCE_LOOKS_LIKE_HTML', '内容看起来是 HTML 页面（可能是错误页或登录页），不是规则文件', {
        line: first.line,
      });
      return { diagnostics };
    }
    if (first.text.startsWith('{') || first.text.startsWith('[')) {
      diagnostics.error(
        'SOURCE_LOOKS_LIKE_JSON',
        '内容看起来是 JSON（可能是接口错误对象）。仅支持 YAML 块格式或一行一条的纯文本规则',
        { line: first.line },
      );
      return { diagnostics };
    }
  }

  const resolved: DocumentFormat = format === 'auto' ? detectFormat(text) : format;

  if (!first) {
    const hasMarker = resolved === 'text' && lines.some((l) => l.trim() === EMPTY_MARKER);
    if (hasMarker) {
      return { document: { format: 'text', rules: [], explicitEmpty: true }, diagnostics };
    }
    diagnostics.error(
      'EMPTY_DOCUMENT',
      resolved === 'yaml'
        ? '文档为空或只有注释。若确实要清空所有规则，请写 `rules: []`'
        : `文档为空或只有注释。为防止空下载误清空规则，这被视为错误；若确实要清空，请单独写一行 \`${EMPTY_MARKER}\``,
    );
    return { diagnostics };
  }

  const document = resolved === 'yaml' ? parseYaml(text, diagnostics) : parseText(lines, diagnostics);
  if (!document || diagnostics.hasErrors) return { diagnostics };

  if (document.rules.length > limits.maxRules) {
    diagnostics.error('TOO_MANY_RULES', `规则数量 ${document.rules.length} 超过上限 ${limits.maxRules}`);
    return { diagnostics };
  }
  return { document, diagnostics };
}

function parseText(lines: string[], diagnostics: DiagnosticBag): ParsedDocument {
  const rules: RuleLine[] = [];
  let markerLine: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === EMPTY_MARKER) {
      markerLine = i + 1;
      continue;
    }
    if (isCommentOrBlank(trimmed)) continue;
    const start = line.indexOf(trimmed);
    rules.push({ raw: trimmed, line: i + 1, column: codePointColumn(line, start), sourceIndex: rules.length });
  }
  if (markerLine !== undefined && rules.length > 0) {
    diagnostics.error('EMPTY_MARKER_WITH_RULES', `\`${EMPTY_MARKER}\` 表示显式清空，不能与有效规则同时出现`, {
      line: markerLine,
    });
  }
  return { format: 'text', rules, explicitEmpty: false };
}

function yamlErrorLocation(e: YAMLError): { line?: number; column?: number } {
  const pos = e.linePos?.[0];
  return pos ? { line: pos.line, column: pos.col } : {};
}

function parseYaml(text: string, diagnostics: DiagnosticBag): ParsedDocument | undefined {
  const lineCounter = new LineCounter();
  const docs = parseAllDocuments(text, {
    lineCounter,
    uniqueKeys: true,
    strict: true,
    merge: false,
    prettyErrors: true,
    schema: 'core',
  });
  const list = Array.isArray(docs) ? docs : [];
  if (list.length === 0) {
    diagnostics.error('EMPTY_DOCUMENT', '文档为空或只有注释。若确实要清空所有规则，请写 `rules: []`');
    return undefined;
  }
  if (list.length > 1) {
    diagnostics.error('YAML_MULTI_DOCUMENT', `检测到 ${list.length} 个 YAML 文档，只接受单个文档`);
    return undefined;
  }
  const doc = list[0]!;
  for (const e of doc.errors) {
    const message =
      e.code === 'DUPLICATE_KEY' ? '存在重复的键' : `YAML 语法错误：${excerpt(e.message.split('\n')[0] ?? '', 160)}`;
    diagnostics.error('YAML_SYNTAX', message, yamlErrorLocation(e));
  }
  if (diagnostics.hasErrors) return undefined;

  const loc = (node: { range?: [number, number, number] | null } | null | undefined) => {
    const offset = node?.range?.[0];
    if (offset === undefined) return {};
    const p = lineCounter.linePos(offset);
    return { line: p.line, column: p.col };
  };

  visit(doc, {
    Alias(_key, node) {
      diagnostics.error('YAML_ALIAS_UNSUPPORTED', '不支持 YAML 别名（*alias）', loc(node));
    },
    Node(_key, node) {
      const n = node as YamlNode & { anchor?: string; tag?: string };
      if (n.anchor) diagnostics.error('YAML_ANCHOR_UNSUPPORTED', '不支持 YAML 锚点（&anchor）', loc(n));
      if (n.tag) diagnostics.error('YAML_TAG_UNSUPPORTED', `不支持 YAML 标签 ${excerpt(n.tag, 40)}`, loc(n));
    },
    Pair(_key, pair) {
      if (isScalar(pair.key) && pair.key.value === '<<') {
        diagnostics.error('YAML_MERGE_KEY_UNSUPPORTED', '不支持 YAML 合并键（<<）', loc(pair.key));
      }
    },
  });
  for (const w of doc.warnings) {
    diagnostics.error('YAML_TAG_UNSUPPORTED', `YAML 警告视为错误：${excerpt(w.message.split('\n')[0] ?? '', 120)}`, yamlErrorLocation(w));
  }
  if (diagnostics.hasErrors) return undefined;

  const root = doc.contents;
  let seqNode: unknown;
  if (isMap(root)) {
    let rulesSeen = false;
    for (const pair of root.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
        diagnostics.error('YAML_ROOT_INVALID', '顶层键必须是字符串', loc(pair.key as YamlNode));
        continue;
      }
      const key = pair.key.value;
      if (key === 'rules') {
        rulesSeen = true;
        seqNode = pair.value;
        if (pair.value === null || (isScalar(pair.value) && pair.value.value === null)) {
          diagnostics.error('RULES_NULL', '`rules` 为空值（null）。null 不等于空列表；若要清空请写 `rules: []`', loc(pair.key));
        } else if (!isSeq(pair.value)) {
          diagnostics.error('RULES_NOT_SEQUENCE', '`rules` 必须是字符串列表', loc(pair.value as YamlNode));
        }
      } else if (FULL_CONFIG_KEYS.has(key)) {
        diagnostics.error(
          'FULL_CONFIG_NOT_ACCEPTED',
          `检测到完整配置字段 \`${key}\`。这里只接受额外规则文件（顶层仅 rules），不需要也不应提交完整配置`,
          loc(pair.key),
        );
      } else if (key === 'payload') {
        diagnostics.error(
          'PROVIDER_PAYLOAD_NOT_ACCEPTED',
          '检测到 rule-provider 的 `payload` 格式。这里接受的是带出站目标的 `rules` 列表',
          loc(pair.key),
        );
      } else {
        diagnostics.error('UNSUPPORTED_TOP_LEVEL_KEY', `不支持的顶层字段 \`${excerpt(key, 40)}\`，顶层只允许 rules`, loc(pair.key));
      }
    }
    if (!rulesSeen && !diagnostics.hasErrors) {
      diagnostics.error('YAML_ROOT_INVALID', 'YAML 映射缺少 `rules` 字段');
    }
  } else if (isSeq(root)) {
    seqNode = root;
  } else {
    diagnostics.error('YAML_ROOT_INVALID', 'YAML 顶层必须是 `rules:` 映射或字符串列表', loc(root as YamlNode));
  }
  if (diagnostics.hasErrors || !isSeq(seqNode)) return undefined;

  const rules: RuleLine[] = [];
  seqNode.items.forEach((item, index) => {
    const where = { ...loc(item as YamlNode), sourceIndex: index };
    if (!isScalar(item) || typeof item.value !== 'string') {
      diagnostics.error('RULE_NOT_STRING', `第 ${index + 1} 项不是字符串`, where);
      return;
    }
    if (/[\r\n]/.test(item.value)) {
      diagnostics.error('RULE_CONTAINS_NEWLINE', '规则字符串包含换行，一条输入不能变成多条输出', where);
      return;
    }
    rules.push({ raw: item.value, line: where.line ?? 0, column: where.column ?? 0, sourceIndex: index });
  });
  if (diagnostics.hasErrors) return undefined;
  return { format: 'yaml', rules, explicitEmpty: rules.length === 0 };
}
