/**
 * Minimal model of the documented YAML override semantics used by Sub-Store
 * and Clash Party: mapping keys are merged recursively, `+key` prepends a
 * list and `key+` appends one, any other key overwrites. Written from the
 * documentation for tests; it is not a copy of either implementation.
 */
export function applyYamlPatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const k = key.endsWith('!') ? key.slice(0, -1) : key;
      if (key.endsWith('!')) {
        target[k] = value;
        continue;
      }
      const current = target[k];
      const base = current !== null && typeof current === 'object' && !Array.isArray(current) ? current : {};
      target[k] = applyYamlPatch(base as Record<string, unknown>, value as Record<string, unknown>);
    } else if (Array.isArray(value) && key.startsWith('+')) {
      const k = key.slice(1);
      target[k] = [...value, ...((target[k] as unknown[]) ?? [])];
    } else if (Array.isArray(value) && key.endsWith('+')) {
      const k = key.slice(0, -1);
      target[k] = [...((target[k] as unknown[]) ?? []), ...value];
    } else {
      target[key] = value;
    }
  }
  return target;
}

/** Evaluates a generated `function main(config)` script without any globals. */
export function loadMain(script: string): (config: unknown) => unknown {
  return new Function(`"use strict";\n${script}\nreturn main;`)() as (config: unknown) => unknown;
}
