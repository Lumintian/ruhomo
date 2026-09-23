/**
 * Structured diagnostics shared by the parser, compiler, worker and web UI.
 *
 * Any `error` makes the whole candidate conversion fail; `warning` results
 * may be published but must be surfaced in the preview and inspect output.
 */

export type Severity = 'error' | 'warning';

export type DiagnosticCode =
  // document level
  | 'INPUT_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'EMPTY_DOCUMENT'
  | 'EMPTY_MARKER_WITH_RULES'
  | 'SOURCE_LOOKS_LIKE_HTML'
  | 'SOURCE_LOOKS_LIKE_JSON'
  | 'YAML_SYNTAX'
  | 'YAML_MULTI_DOCUMENT'
  | 'YAML_ANCHOR_UNSUPPORTED'
  | 'YAML_ALIAS_UNSUPPORTED'
  | 'YAML_MERGE_KEY_UNSUPPORTED'
  | 'YAML_TAG_UNSUPPORTED'
  | 'YAML_ROOT_INVALID'
  | 'FULL_CONFIG_NOT_ACCEPTED'
  | 'PROVIDER_PAYLOAD_NOT_ACCEPTED'
  | 'UNSUPPORTED_TOP_LEVEL_KEY'
  | 'RULES_NULL'
  | 'RULES_NOT_SEQUENCE'
  | 'RULE_NOT_STRING'
  | 'RULE_CONTAINS_NEWLINE'
  | 'TOO_MANY_RULES'
  | 'TOO_MANY_TARGETS'
  // rule level
  | 'RULE_TOO_LONG'
  | 'EMPTY_RULE'
  | 'CONTROL_CHARACTER'
  | 'UNKNOWN_RULE_TYPE'
  | 'FORBIDDEN_RULE_TYPE'
  | 'MISSING_PAYLOAD'
  | 'MISSING_TARGET'
  | 'INVALID_TARGET'
  | 'EMPTY_FIELD'
  | 'UNEXPECTED_FIELD'
  | 'UNKNOWN_PARAM'
  | 'INVALID_PAYLOAD'
  | 'LOGIC_SYNTAX'
  | 'LOGIC_UNBALANCED_PARENS'
  | 'LOGIC_NOT_ARITY'
  | 'LOGIC_EMPTY'
  | 'LOGIC_TOO_DEEP'
  | 'LOGIC_FORBIDDEN_SUBRULE'
  | 'NAME_COLLISION'
  // warnings
  | 'REGEX_SEMANTICS_NOT_VALIDATED'
  | 'LOGIC_NESTED_REGEX'
  | 'PAYLOAD_WHITESPACE_TRIMMED'
  | 'GEODATA_DEPENDENCY'
  | 'PLATFORM_DEPENDENT'
  | 'REDUNDANT_PARAM'
  | 'DUPLICATE_PARAM'
  | 'SUSPICIOUS_PAYLOAD'
  | 'TARGET_CASE_BUILTIN'
  | 'DUPLICATE_RULE'
  | 'DUPLICATE_CONDITION_DIFFERENT_TARGET'
  | 'ORDER_CHANGED_BY_GROUPING'
  | 'TARGET_ORDER_UNUSED';

export interface Diagnostic {
  severity: Severity;
  code: DiagnosticCode;
  /** Human readable message (Chinese). Never contains a full config body. */
  message: string;
  /** 1-based line in the source document, when known. */
  line?: number;
  /** 1-based column in the source document, when known. */
  column?: number;
  /** 0-based index of the rule among the rules of the document. */
  sourceIndex?: number;
  target?: string;
}

export const MAX_REPORTED_DIAGNOSTICS = 200;

export class DiagnosticBag {
  readonly items: Diagnostic[] = [];
  errorCount = 0;
  warningCount = 0;
  truncated = false;

  add(d: Diagnostic): void {
    if (d.severity === 'error') this.errorCount++;
    else this.warningCount++;
    if (this.items.length >= MAX_REPORTED_DIAGNOSTICS) {
      this.truncated = true;
      return;
    }
    this.items.push(d);
  }

  error(code: DiagnosticCode, message: string, loc: Partial<Diagnostic> = {}): void {
    this.add({ ...loc, severity: 'error', code, message });
  }

  warn(code: DiagnosticCode, message: string, loc: Partial<Diagnostic> = {}): void {
    this.add({ ...loc, severity: 'warning', code, message });
  }

  get hasErrors(): boolean {
    return this.errorCount > 0;
  }
}

/** Shorten user text embedded in messages so diagnostics stay bounded. */
export function excerpt(text: string, max = 80): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}
