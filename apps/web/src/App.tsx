import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfigResponse, Diagnostic, InputFormat } from '@ruhomo/core';
import {
  DEFAULT_INTERVAL_SECONDS,
  IntegrationError,
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  RecipeError,
  checkSourceUrl,
  encodeRecipe,
  normalizeRecipe,
  recipeLinks,
} from '@ruhomo/core';
import { ArtifactOutput } from './components/ArtifactOutput.tsx';
import { Diagnostics } from './components/Diagnostics.tsx';
import { ProviderList } from './components/ProviderList.tsx';
import { SourceInput } from './components/SourceInput.tsx';
import { TargetPreview } from './components/TargetPreview.tsx';
import { ApiError, fetchConfig, fetchInspect, fetchText } from './lib/api.ts';
import type { Conversion } from './lib/convert.ts';
import { conversionFromInspect, convertPasted, moveItem } from './lib/convert.ts';
import type { SourceMode } from './lib/storage.ts';
import { clearSavedForm, loadSavedForm, saveForm } from './lib/storage.ts';

interface Failure {
  message: string;
  code?: string;
  diagnostics: Diagnostic[];
}

type Phase = 'idle' | 'loading' | 'done' | 'error';

// Read once at startup; nothing is stored unless the user opts in.
const saved = loadSavedForm();

export function App() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState(false);
  const [remember, setRemember] = useState(saved !== null);
  const [mode, setMode] = useState<SourceMode>(saved?.mode ?? 'url');
  const [url, setUrl] = useState(saved?.url ?? '');
  const [pasteText, setPasteText] = useState(saved?.pasteText ?? '');
  const [format, setFormat] = useState<InputFormat>(saved?.format ?? 'auto');
  const [interval, setIntervalValue] = useState(String(saved?.interval ?? DEFAULT_INTERVAL_SECONDS));
  const [phase, setPhase] = useState<Phase>('idle');
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [overrideState, setOverrideState] = useState<{ loading: boolean; error?: string }>({ loading: false });
  const [storageNote, setStorageNote] = useState('');
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchConfig(ctrl.signal)
      .then(setConfig)
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setConfigError(true);
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    if (!remember) return;
    saveForm({ mode, url, pasteText, format, interval: Number(interval) || DEFAULT_INTERVAL_SECONDS });
  }, [remember, mode, url, pasteText, format, interval]);

  const onRemember = (v: boolean) => {
    setRemember(v);
    if (!v) {
      clearSavedForm();
      setStorageNote('');
      return;
    }
    const ok = saveForm({ mode, url, pasteText, format, interval: Number(interval) || DEFAULT_INTERVAL_SECONDS });
    setStorageNote(ok ? '' : '浏览器不允许本地存储，无法记住输入。');
  };

  const onClearLocal = () => {
    clearSavedForm();
    setRemember(false);
    setStorageNote('已清除本机保存的输入。');
  };

  const loadOverrides = useCallback(async (c: Conversion, signal: AbortSignal) => {
    if (!c.links) return;
    setOverrideState({ loading: true });
    try {
      const [yaml, js] = await Promise.all([fetchText(c.links.overrideYaml, signal), fetchText(c.links.overrideJs, signal)]);
      setConversion((prev) => (prev === c ? { ...c, yaml, js } : prev));
      setOverrideState({ loading: false });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setOverrideState({ loading: false, error: (e as Error).message });
    }
  }, []);

  const convert = useCallback(
    async (targetOrder: string[]) => {
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      setFailure(null);
      setOverrideState({ loading: false });

      if (mode === 'paste') {
        const r = convertPasted(pasteText, format, targetOrder);
        if (r.ok) {
          setConversion(r.conversion);
          setPhase('done');
        } else {
          setConversion(null);
          setFailure({ message: '转换失败：请根据下方诊断修正输入。没有生成任何结果。', diagnostics: r.diagnostics });
          setPhase('error');
        }
        return;
      }

      const intervalNum = Number(interval);
      if (!Number.isInteger(intervalNum) || intervalNum < MIN_INTERVAL_SECONDS || intervalNum > MAX_INTERVAL_SECONDS) {
        setFailure({ message: `刷新间隔必须是 ${MIN_INTERVAL_SECONDS}–${MAX_INTERVAL_SECONDS} 之间的整数秒`, diagnostics: [] });
        setPhase('error');
        return;
      }
      let token: string;
      let links;
      try {
        const recipe = normalizeRecipe({ source: { url, format }, interval: intervalNum, targetOrder });
        if (config) {
          const violation = checkSourceUrl(recipe.source.url, { allowlist: config.allowlist, denyHosts: [window.location.hostname] });
          if (violation) throw new RecipeError('SOURCE_URL_INVALID', violation.message);
        }
        token = encodeRecipe(recipe);
        links = recipeLinks(config?.publicBaseUrl ?? window.location.origin, token);
      } catch (e) {
        if (e instanceof RecipeError || e instanceof IntegrationError) {
          setFailure({ message: e.message, code: e.code, diagnostics: [] });
          setPhase('error');
          return;
        }
        throw e;
      }

      setPhase('loading');
      try {
        const inspect = await fetchInspect(links.inspect, ctrl.signal);
        const c = conversionFromInspect(inspect);
        setConversion(c);
        setPhase('done');
        void loadOverrides(c, ctrl.signal);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        const err = e as ApiError;
        setFailure({
          message: err instanceof ApiError ? `${err.message}（${err.code}）` : '转换失败',
          code: err.code,
          diagnostics: err instanceof ApiError ? err.diagnostics : [],
        });
        setPhase('error');
      }
    },
    [mode, pasteText, format, interval, url, config, loadOverrides],
  );

  const onMove = (index: number, delta: -1 | 1) => {
    if (!conversion) return;
    const order = moveItem(
      conversion.providers.map((p) => p.target),
      index,
      delta,
    );
    void convert(order);
  };

  const busy = phase === 'loading';
  return (
    <div className="page">
      <header className="header">
        <h1>ruhomo</h1>
        <p className="lead">
          把你单独维护的额外 Mihomo rules 按出站目标分组，生成 HTTP rule-provider 与 Sub-Store 可用的 YAML / JavaScript 覆写。
          完整配置、节点和代理组始终留在你自己的 Sub-Store 中。
        </p>
        <p className="muted small">English: converts an extra Mihomo rules list into per-target rule-providers plus addon overrides for Sub-Store.</p>
      </header>

      <main className="main">
        <SourceInput
          mode={mode}
          url={url}
          pasteText={pasteText}
          format={format}
          interval={interval}
          remember={remember}
          busy={busy}
          allowlist={config?.allowlist ?? null}
          onMode={setMode}
          onUrl={setUrl}
          onPasteText={setPasteText}
          onFormat={setFormat}
          onInterval={setIntervalValue}
          onRemember={onRemember}
          onClearLocal={onClearLocal}
          onSubmit={() => void convert([])}
        />
        {storageNote && (
          <p className="muted small" role="status">
            {storageNote}
          </p>
        )}
        {configError && mode === 'url' && (
          <p className="notice notice-warning">无法读取服务配置（/api/config）；URL 模式可能不可用，粘贴模式不受影响。</p>
        )}

        <div aria-live="polite">
          {busy && (
            <p className="notice" data-testid="loading">
              正在获取并转换源内容…
            </p>
          )}
          {failure && (
            <div className="notice notice-error" role="alert" data-testid="failure">
              <p>{failure.message}</p>
              {mode === 'url' && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void convert(conversion?.providers.map((p) => p.target) ?? [])}>
                  重试
                </button>
              )}
            </div>
          )}
        </div>
        {failure && <Diagnostics diagnostics={failure.diagnostics} title="转换失败的原因" />}

        {conversion && !failure && (
          <>
            <section className="card summary" data-testid="summary">
              <h2>结果概览</h2>
              <p>
                共 {conversion.ruleCount} 条规则，{conversion.providers.length} 个出站目标，识别格式：{conversion.detectedFormat}。
                {conversion.mode === 'url' && conversion.validatedAt && <> 最近成功校验：{new Date(conversion.validatedAt).toLocaleString()}。</>}
              </p>
              {conversion.stale && (
                <p className="notice notice-warning" data-testid="stale">
                  当前显示的是缓存中的旧结果（stale）：最近一次获取失败{conversion.lastError ? `（${conversion.lastError.code}）` : ''}。
                </p>
              )}
              <p className="muted small">结构校验通过不等于已由真实 Mihomo 完整验证；正则、GEO 数据等依赖消费者环境。</p>
              <ul className="notices">
                {conversion.notices.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
            <TargetPreview providers={conversion.providers} mode={conversion.mode} onMove={onMove} busy={busy} />
            <Diagnostics diagnostics={conversion.diagnostics} truncated={conversion.diagnosticsTruncated} />
            <ArtifactOutput
              mode={conversion.mode}
              yaml={conversion.yaml}
              js={conversion.js}
              links={conversion.links}
              loading={overrideState.loading}
              loadError={overrideState.error}
              onRetry={() => void loadOverrides(conversion, new AbortController().signal)}
            />
            <ProviderList key={conversion.providers.map((p) => p.name).join('|')} providers={conversion.providers} />
          </>
        )}
      </main>

      <footer className="footer muted small">
        <p>
          兼容基准 Mihomo {config?.mihomoBaseline ?? 'v1.19.31'} · 不访问你的 Mihomo Controller，不修改订阅或网络配置 · 无第三方统计或外部资源
        </p>
      </footer>
    </div>
  );
}
