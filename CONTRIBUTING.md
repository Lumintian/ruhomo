# 贡献指南

感谢参与！提交前请阅读 [docs/architecture.md](docs/architecture.md) 与 [docs/compatibility.md](docs/compatibility.md)。

## 开发环境

- Node.js ≥ 22.12，pnpm（版本见 `package.json` 的 `packageManager`）。请只用 pnpm，保留 `pnpm-lock.yaml`。
- `pnpm install --frozen-lockfile`，然后 `pnpm dev`。

## 提交前检查

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm test:workerd && pnpm build
pnpm test:e2e          # 需要本地 Chromium
pnpm test:integration  # 下载并校验固定版本 Mihomo 测试内核
```

不要把没运行过的测试写成“已通过”；受环境限制跑不了的请在 PR 中说明。

## 约定

- 使用 [Conventional Commits](https://www.conventionalcommits.org/)，保持提交原子化（`feat(core): ...`、`fix(worker): ...`、`test(...)`、`docs: ...`）。
- core 保持纯 TypeScript，不引入 Node 或 Cloudflare 专有 API；前端与 Worker 必须共用 core。
- 规则解析行为变化必须：更新 `COMPILER_VERSION`（它是缓存 key 的一部分）、补充单元测试，并在可行时补充真实内核探针。
- 不要复制或逐行翻译 Mihomo 源码；依据文档与真实内核行为独立实现。
- 不在测试或 issue 中提交真实订阅、节点、凭据或个人规则。
- 产品边界见 README 的“不做什么”；扩大范围前请先开 issue 讨论。
