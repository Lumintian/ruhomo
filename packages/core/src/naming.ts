/**
 * Deterministic provider names: `mrp-{recipeId}-{targetId}`.
 *
 * Both ids are the first 128 bits (32 hex chars) of domain-separated
 * SHA-256 digests. They depend only on the canonical recipe and the raw
 * target name — never on rule content, rule counts, source hashes,
 * timestamps or array positions — so editing the rules of an existing
 * target keeps its provider name and URL. Truncated hashes can collide in
 * theory; collisions are detected and reported rather than assumed away.
 */
import { sha256Hex } from './encoding.ts';
import type { Recipe } from './recipe.ts';
import { canonicalJson } from './recipe.ts';

export const PROVIDER_NAME_PREFIX = 'mrp-';
const ID_HEX_CHARS = 32;

export function recipeId(recipe: Recipe): string {
  return sha256Hex(`ruhomo/recipe/v1\n${canonicalJson(recipe)}`).slice(0, ID_HEX_CHARS);
}

/** Shared namespace for static (inline) exports made from pasted content. */
export const INLINE_NAMESPACE_ID = sha256Hex('ruhomo/inline/v1').slice(0, ID_HEX_CHARS);

export function targetId(target: string): string {
  return sha256Hex(`ruhomo/target/v1\n${target}`).slice(0, ID_HEX_CHARS);
}

export function namespacePrefix(namespaceId: string): string {
  return `${PROVIDER_NAME_PREFIX}${namespaceId}-`;
}

export function providerName(namespaceId: string, target: string): string {
  return `${namespacePrefix(namespaceId)}${targetId(target)}`;
}

export class NameCollisionError extends Error {
  readonly targets: [string, string];
  constructor(targets: [string, string]) {
    super('provider name collision');
    this.targets = targets;
    this.name = 'NameCollisionError';
  }
}

/** Assigns names for a set of targets, failing loudly on a digest collision. */
export function assignProviderNames(
  namespaceId: string,
  targets: readonly string[],
  nameOf: (namespaceId: string, target: string) => string = providerName,
): Map<string, string> {
  const byName = new Map<string, string>();
  const out = new Map<string, string>();
  for (const target of targets) {
    const name = nameOf(namespaceId, target);
    const other = byName.get(name);
    if (other !== undefined && other !== target) throw new NameCollisionError([other, target]);
    byName.set(name, target);
    out.set(target, name);
  }
  return out;
}
