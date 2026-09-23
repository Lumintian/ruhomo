import { useState } from 'react';
import type { RecipeLinks } from '@ruhomo/core';
import { copyText, downloadText } from '../lib/clipboard.ts';
import { ActionButton } from './ActionButton.tsx';

interface Props {
  mode: 'paste' | 'url';
  yaml?: string | undefined;
  js?: string | undefined;
  links?: RecipeLinks | undefined;
  loading: boolean;
  loadError?: string | undefined;
  onRetry?: () => void;
}

type Tab = 'yaml' | 'js';

export function ArtifactOutput({ mode, yaml, js, links, loading, loadError, onRetry }: Props) {
  const [tab, setTab] = useState<Tab>('yaml');
  const text = tab === 'yaml' ? yaml : js;
  const link = tab === 'yaml' ? links?.overrideYaml : links?.overrideJs;
  const filename = tab === 'yaml' ? 'ruhomo-override.yaml' : 'ruhomo-override.js';
  return (
    <section className="card" aria-labelledby="override-title">
      <h2 id="override-title">Sub-Store 覆写</h2>
      {mode === 'paste' ? (
        <p className="notice notice-warning" data-testid="static-export-notice">
          静态导出：规则以 inline payload 写入，不支持独立规则热更新；修改规则后需要重新应用覆写。需要持续热更新请改用 raw URL。
        </p>
      ) : (
        <p className="hint">
          只做 addon：合并 rule-providers，并把 RULE-SET 前插到原 rules；原有规则内容和相对顺序不变。YAML 的 +rules
          不天然幂等，请每次在原始配置上应用一次；JS 覆写会替换本 recipe 之前生成的条目。
        </p>
      )}
      <div className="tabs" role="tablist" aria-label="覆写格式">
        <button type="button" role="tab" aria-selected={tab === 'yaml'} className={`tab ${tab === 'yaml' ? 'active' : ''}`} onClick={() => setTab('yaml')}>
          YAML
        </button>
        <button type="button" role="tab" aria-selected={tab === 'js'} className={`tab ${tab === 'js' ? 'active' : ''}`} onClick={() => setTab('js')}>
          JavaScript
        </button>
      </div>
      {mode === 'url' && link && (
        <div className="link-row" data-testid="remote-link-row">
          <label className="field-label" htmlFor="override-link">
            远程覆写链接
          </label>
          <div className="link-box">
            <input id="override-link" className="input mono" readOnly value={link} data-testid={`link-${tab}`} onFocus={(e) => e.currentTarget.select()} />
            <ActionButton label="复制链接" doneLabel="已复制" failedLabel="复制失败" action={() => copyText(link)} variant="primary" testId="copy-override-link" />
          </div>
        </div>
      )}
      {loading && <p className="muted">加载覆写中…</p>}
      {loadError && (
        <p className="error-text">
          加载覆写失败：{loadError}{' '}
          {onRetry && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
              重试
            </button>
          )}
        </p>
      )}
      {text !== undefined && (
        <>
          <div className="actions">
            <ActionButton label="复制内容" doneLabel="已复制" failedLabel="复制失败" action={() => copyText(text)} testId={`copy-${tab}`} />
            <ActionButton
              label="下载"
              doneLabel="已下载"
              action={() => downloadText(filename, text, tab === 'yaml' ? 'application/yaml;charset=utf-8' : 'text/javascript;charset=utf-8')}
            />
          </div>
          <pre className="code" data-testid={`override-${tab}`}>{text}</pre>
        </>
      )}
    </section>
  );
}
