import { Document } from 'yaml';
import type { IntegrationIR } from '../integration.ts';

const REMOTE_HEADER = [
  ' ruhomo addon override (YAML patch for Sub-Store style override hosts)',
  ' Merges rule-providers and prepends RULE-SET entries through +rules;',
  ' the original rules keep their content and relative order.',
  ' This is a patch for an override host, not a complete Mihomo config.',
  ' +rules is not idempotent: apply it once on the original config.',
  ' Every referenced outbound target must already exist in that config.',
];

const INLINE_HEADER = [
  ...REMOTE_HEADER,
  ' 静态导出：规则以内联 payload 写入，不支持独立规则热更新；',
  ' 修改规则后需要重新生成并重新应用覆写。需要热更新请改用 raw URL。',
];

/**
 * Renders the YAML override. Keys are `rule-providers` (merged by the host)
 * and `+rules` (prepended by the host). All strings go through the YAML
 * serializer, which quotes them as needed.
 */
export function generateYamlOverride(ir: IntegrationIR): string {
  const providers: Record<string, unknown> = {};
  for (const p of ir.providers) providers[p.name] = { ...p.definition };
  const doc = new Document({ 'rule-providers': providers, '+rules': [...ir.rules] });
  doc.commentBefore = (ir.transport === 'inline' ? INLINE_HEADER : REMOTE_HEADER).join('\n');
  return doc.toString({ lineWidth: 0, indent: 2, indentSeq: true });
}
