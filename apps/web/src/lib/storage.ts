/**
 * Optional form persistence. Nothing is written unless the user enables
 * "记住输入"; rule text is only stored in that case. This is a local
 * convenience, not provider hosting.
 */
import type { InputFormat } from '@ruhomo/core';

export type SourceMode = 'url' | 'paste';

export interface SavedForm {
  mode: SourceMode;
  url: string;
  pasteText: string;
  format: InputFormat;
  interval: number;
}

const KEY = 'ruhomo:form:v1';

export function loadSavedForm(): SavedForm | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedForm>;
    if (v.mode !== 'url' && v.mode !== 'paste') return null;
    return {
      mode: v.mode,
      url: typeof v.url === 'string' ? v.url : '',
      pasteText: typeof v.pasteText === 'string' ? v.pasteText : '',
      format: v.format === 'yaml' || v.format === 'text' ? v.format : 'auto',
      interval: typeof v.interval === 'number' ? v.interval : 3600,
    };
  } catch {
    return null;
  }
}

export function saveForm(form: SavedForm): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(form));
    return true;
  } catch {
    return false;
  }
}

export function clearSavedForm(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: nothing to clear
  }
}
