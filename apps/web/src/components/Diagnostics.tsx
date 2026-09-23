import type { Diagnostic } from '@ruhomo/core';

interface Props {
  diagnostics: Diagnostic[];
  truncated?: boolean;
  title?: string;
}

function location(d: Diagnostic): string {
  if (!d.line) return '';
  return d.column ? `第 ${d.line} 行，第 ${d.column} 列` : `第 ${d.line} 行`;
}

export function Diagnostics({ diagnostics, truncated, title = '诊断' }: Props) {
  if (diagnostics.length === 0) return null;
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  return (
    <section className="card" aria-labelledby="diag-title" data-testid="diagnostics">
      <h2 id="diag-title">
        {title}
        <span className="counts">
          {errors > 0 && <span className="badge badge-error">{errors} 个错误</span>}
          {warnings > 0 && <span className="badge badge-warning">{warnings} 个警告</span>}
        </span>
      </h2>
      <ul className="diag-list">
        {diagnostics.map((d, i) => (
          <li key={i} className={`diag diag-${d.severity}`} data-testid={`diag-${d.severity}`}>
            <div className="diag-head">
              <span className={`badge badge-${d.severity}`}>{d.severity === 'error' ? '错误' : '警告'}</span>
              {location(d) && <span className="diag-loc">{location(d)}</span>}
              <code className="diag-code">{d.code}</code>
            </div>
            <p className="diag-msg">{d.message}</p>
            {d.target !== undefined && <p className="diag-target">出站目标：{d.target}</p>}
          </li>
        ))}
      </ul>
      {truncated && <p className="muted">诊断过多，仅显示前 {diagnostics.length} 条。</p>}
    </section>
  );
}
