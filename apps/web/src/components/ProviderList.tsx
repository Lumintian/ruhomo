import { useState } from 'react';
import { fetchText } from '../lib/api.ts';
import { copyText, downloadText } from '../lib/clipboard.ts';
import type { ProviderView } from '../lib/convert.ts';
import { ActionButton } from './ActionButton.tsx';

type Load = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; body: string } | { state: 'failed'; message: string };

function ProviderItem({ provider }: { provider: ProviderView }) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>(provider.body !== undefined ? { state: 'ready', body: provider.body } : { state: 'idle' });

  const ensureBody = async (): Promise<string> => {
    if (provider.body !== undefined) return provider.body;
    if (load.state === 'ready') return load.body;
    setLoad({ state: 'loading' });
    try {
      const body = await fetchText(provider.url!);
      setLoad({ state: 'ready', body });
      return body;
    } catch (e) {
      setLoad({ state: 'failed', message: (e as Error).message });
      throw e;
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && load.state !== 'ready') void ensureBody().catch(() => undefined);
  };

  const body = provider.body ?? (load.state === 'ready' ? load.body : undefined);
  return (
    <li className="provider" data-testid="provider-item">
      <div className="provider-head">
        <div className="provider-title">
          <strong className="target-name">{provider.target}</strong>
          <span className="muted">{provider.ruleCount} 条</span>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-secondary" onClick={toggle} aria-expanded={open}>
            {open ? '收起' : '预览'}
          </button>
          <ActionButton label="复制内容" doneLabel="已复制" failedLabel="复制失败" action={async () => copyText(await ensureBody())} />
          <ActionButton label="下载" doneLabel="已下载" action={async () => downloadText(`${provider.name}.list`, await ensureBody())} />
          {provider.url && <ActionButton label="复制链接" doneLabel="已复制" failedLabel="复制失败" action={() => copyText(provider.url!)} />}
        </div>
      </div>
      {open && (
        <div className="provider-body">
          {load.state === 'loading' && <p className="muted">加载中…</p>}
          {load.state === 'failed' && (
            <p className="error-text">
              加载失败：{load.message}{' '}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void ensureBody().catch(() => undefined)}>
                重试
              </button>
            </p>
          )}
          {body !== undefined && <pre className="code" data-testid="provider-text">{body}</pre>}
        </div>
      )}
    </li>
  );
}

export function ProviderList({ providers }: { providers: ProviderView[] }) {
  if (providers.length === 0) return null;
  return (
    <section className="card" aria-labelledby="providers-title">
      <h2 id="providers-title">provider 内容</h2>
      <p className="hint">classical / text 格式，一行一条、已去除出站目标。</p>
      <ul className="provider-list">
        {providers.map((p) => (
          <ProviderItem key={p.name} provider={p} />
        ))}
      </ul>
    </section>
  );
}
