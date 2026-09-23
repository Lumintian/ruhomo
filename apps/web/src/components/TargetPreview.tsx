import type { ProviderView } from '../lib/convert.ts';

interface Props {
  providers: ProviderView[];
  mode: 'paste' | 'url';
  onMove: (index: number, delta: -1 | 1) => void;
  busy: boolean;
}

export function TargetPreview({ providers, mode, onMove, busy }: Props) {
  return (
    <section className="card" aria-labelledby="targets-title">
      <h2 id="targets-title">出站目标与 provider</h2>
      <p className="hint">
        “出站目标”可以是代理、代理组或内置策略（如 DIRECT）。下表顺序就是 RULE-SET 在覆写中的优先级；
        按目标分组会改变跨目标的原始先后顺序，规则重叠时匹配结果可能不同。
        {mode === 'url' && ' 调整顺序会生成新的 recipe 链接，需要替换旧覆写。'}
      </p>
      {providers.length === 0 ? (
        <p className="muted" data-testid="no-targets">源为显式空集合，没有生成任何 provider。</p>
      ) : (
        <div className="table-wrap">
          <table className="targets" data-testid="targets-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">出站目标</th>
                <th scope="col">provider 名称</th>
                <th scope="col">规则数</th>
                <th scope="col">顺序</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p, i) => (
                <tr key={p.name} data-testid="target-row">
                  <td>{i + 1}</td>
                  <td className="target-name" data-testid="target-name">{p.target}</td>
                  <td>
                    <code className="provider-name">{p.name}</code>
                  </td>
                  <td>{p.ruleCount}</td>
                  <td className="order-buttons">
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`上移 ${p.target}`} disabled={busy || i === 0} onClick={() => onMove(i, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`下移 ${p.target}`}
                      disabled={busy || i === providers.length - 1}
                      onClick={() => onMove(i, 1)}
                    >
                      ↓
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
