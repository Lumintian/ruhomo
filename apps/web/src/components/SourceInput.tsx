import type { InputFormat } from '@ruhomo/core';
import type { SourceMode } from '../lib/storage.ts';

interface Props {
  mode: SourceMode;
  url: string;
  pasteText: string;
  format: InputFormat;
  interval: string;
  remember: boolean;
  busy: boolean;
  allowlist: string[] | null;
  onMode: (m: SourceMode) => void;
  onUrl: (v: string) => void;
  onPasteText: (v: string) => void;
  onFormat: (v: InputFormat) => void;
  onInterval: (v: string) => void;
  onRemember: (v: boolean) => void;
  onClearLocal: () => void;
  onSubmit: () => void;
}

const PLACEHOLDER = `rules:
  - DOMAIN-SUFFIX,example.com,DIRECT
  - DOMAIN-SUFFIX,proxy-one.example,示例代理

# 或一行一条：
# DOMAIN-KEYWORD,demo-keyword,默认代理`;

export function SourceInput(p: Props) {
  return (
    <form
      className="card"
      aria-labelledby="source-title"
      onSubmit={(e) => {
        e.preventDefault();
        p.onSubmit();
      }}
    >
      <h2 id="source-title">额外规则来源</h2>
      <div className="tabs" role="tablist" aria-label="输入方式">
        <button type="button" role="tab" aria-selected={p.mode === 'url'} className={`tab ${p.mode === 'url' ? 'active' : ''}`} onClick={() => p.onMode('url')} data-testid="mode-url">
          Raw URL（可热更新）
        </button>
        <button type="button" role="tab" aria-selected={p.mode === 'paste'} className={`tab ${p.mode === 'paste' ? 'active' : ''}`} onClick={() => p.onMode('paste')} data-testid="mode-paste">
          直接粘贴（本地转换）
        </button>
      </div>

      {p.mode === 'url' ? (
        <div className="field">
          <label className="field-label" htmlFor="source-url">
            规则文件的 HTTPS raw URL
          </label>
          <input
            id="source-url"
            className="input mono"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://raw.githubusercontent.com/you/repo/main/extra-rules.yaml"
            value={p.url}
            onChange={(e) => p.onUrl(e.target.value)}
            data-testid="source-url"
          />
          <p className="hint">
            只需要你单独维护的额外 rules，不需要节点、订阅、proxy-groups 或完整配置。
            {p.allowlist && p.allowlist.length > 0 && <> 本部署允许的源域名：{p.allowlist.join('、')}。</>}
            注意：生成的链接用 Base64url 编码了源 URL，这不是加密，持有链接的人可以解码出源地址。
          </p>
        </div>
      ) : (
        <div className="field">
          <label className="field-label" htmlFor="source-text">
            粘贴额外规则
          </label>
          <textarea
            id="source-text"
            className="input mono textarea"
            spellCheck={false}
            placeholder={PLACEHOLDER}
            value={p.pasteText}
            onChange={(e) => p.onPasteText(e.target.value)}
            rows={12}
            data-testid="source-text"
          />
          <p className="hint">内容只在浏览器本地解析和转换，不会上传。粘贴模式只能导出静态覆写，不支持独立规则热更新。</p>
        </div>
      )}

      <div className="row">
        <div className="field">
          <label className="field-label" htmlFor="source-format">
            输入格式
          </label>
          <select id="source-format" className="input" value={p.format} onChange={(e) => p.onFormat(e.target.value as InputFormat)} data-testid="source-format">
            <option value="auto">自动识别</option>
            <option value="yaml">YAML（rules: 或字符串列表）</option>
            <option value="text">纯文本（一行一条）</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="source-interval">
            provider 刷新间隔（秒）
          </label>
          <input
            id="source-interval"
            className="input"
            type="number"
            min={60}
            max={604800}
            step={1}
            value={p.interval}
            disabled={p.mode === 'paste'}
            onChange={(e) => p.onInterval(e.target.value)}
            data-testid="source-interval"
          />
        </div>
      </div>
      {p.mode === 'url' && <p className="hint">interval 是 Mihomo 重新下载 provider 的周期，不是本服务的后台抓取周期。</p>}

      <div className="actions form-actions">
        <button type="submit" className="btn btn-primary" disabled={p.busy} data-testid="convert">
          {p.busy ? '转换中…' : '转换 / 预览'}
        </button>
        <label className="checkbox">
          <input type="checkbox" checked={p.remember} onChange={(e) => p.onRemember(e.target.checked)} data-testid="remember" />
          记住输入（保存在本机浏览器，包括粘贴的规则正文）
        </label>
        <button type="button" className="btn btn-ghost" onClick={p.onClearLocal} data-testid="clear-local">
          清除本地数据
        </button>
      </div>
    </form>
  );
}
