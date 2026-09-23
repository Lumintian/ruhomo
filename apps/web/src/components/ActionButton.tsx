import { useEffect, useRef, useState } from 'react';

type State = 'idle' | 'busy' | 'done' | 'failed';

interface Props {
  label: string;
  doneLabel?: string;
  failedLabel?: string;
  action: () => void | Promise<void>;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost';
  testId?: string;
}

/** Button with a real async status: busy while running, then done or failed. */
export function ActionButton({ label, doneLabel = '完成', failedLabel = '失败', action, disabled, variant = 'secondary', testId }: Props) {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const run = async () => {
    window.clearTimeout(timer.current);
    setState('busy');
    try {
      await action();
      setState('done');
    } catch {
      setState('failed');
    }
    timer.current = window.setTimeout(() => setState('idle'), 1800);
  };

  const text = state === 'done' ? doneLabel : state === 'failed' ? failedLabel : label;
  return (
    <button
      type="button"
      className={`btn btn-${variant} is-${state}`}
      onClick={run}
      disabled={disabled || state === 'busy'}
      data-testid={testId}
      aria-live="polite"
    >
      {text}
    </button>
  );
}
