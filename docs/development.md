# 开发指南

这里整理本地开发、测试和提交约定。部署服务的步骤见 [部署指南](deployment.md)。

## 项目结构与约定

- [架构](architecture.md)：core、Worker、前端的职责与缓存/路由设计。
- [兼容性](compatibility.md)：规则解析所依据的 Mihomo 版本、已验证范围和明确不保证的行为。
- [安全策略](../SECURITY.md)：源 URL、资源上限、日志和隐私边界。
- 产品范围见 [README 的“它会改什么”](../README.md#它会改什么)。新增功能不应擅自访问用户的完整配置或 Mihomo Controller。

目录分工：`packages/core/` 是浏览器与 Worker 共用的纯 TypeScript 转换核心；`apps/worker/` 提供受限抓取、HTTP 路由与缓存；`apps/web/` 提供 React 页面；`tests/integration/` 用固定版本的真实 Mihomo 内核验证输出。

## 本地环境

需要 Node.js ≥ 22.12 和 `package.json` 指定版本的 pnpm。只用 pnpm，保留 `pnpm-lock.yaml`。

```sh
pnpm install --frozen-lockfile
pnpm dev                 # Wrangler :8787 + Vite :5173，访问 http://localhost:5173
```

本地可将 `apps/worker/.dev.vars.example` 复制为 `.dev.vars`（文件已忽略，勿提交）。`pnpm dev` 无须云部署凭据；`pnpm run deploy` **会实际部署**，不要把它当作本地构建命令。部署步骤见 [部署指南](deployment.md)。

## 检查与测试

| 命令 | 用途 |
|---|---|
| `pnpm lint` | ESLint |
| `pnpm typecheck` | 根目录及各工作区的 TypeScript 检查 |
| `pnpm test` | core 与 Worker 的单元/HTTP 测试（Node） |
| `pnpm test:workerd` | workerd（Miniflare）中的 Worker 冒烟测试 |
| `pnpm test:e2e` | Playwright 前端流程，需要本地 Chromium |
| `pnpm test:e2e:prefix` | Playwright `/tools/ruhomo/` 路径前缀流程 |
| `pnpm test:integration` | 下载、校验固定 Mihomo 测试内核并运行集成测试 |
| `pnpm bench` | 本地 Node 墙钟时间基准，**不是** Workers CPU 时间 |
| `pnpm build` | 构建前端并执行 Worker `wrangler deploy --dry-run`，不会上传 |

运行浏览器测试前可执行 `pnpm --filter @ruhomo/web exec playwright install chromium`。提交前至少运行 `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workerd && pnpm build`；涉及前端或路径前缀时运行相应 e2e，涉及内核兼容性时运行集成测试。无法运行的检查应在 PR 中说明，不要声称已通过。

## 发布新版本

根目录 `package.json` 是**唯一的发布版本来源**；`core`、`web`、`worker` 是私有工作区，其 `0.0.0` 只是占位，不随发布升级。`COMPILER_VERSION`、`RECIPE_VERSION` 和 Mihomo 测试基准各自表示兼容性边界，不跟随产品版本号递增。

提交普通改动后，确认在干净的 `main` 分支、远端 `main` 没有未同步的提交，再于仓库根目录运行：

```sh
pnpm version patch -m 'chore(release): v%s'
# patch 也可换成 minor、major 或指定版本号
```

pnpm 会更新根版本、创建版本提交和附注标签；项目的 `preversion` / `postversion` 钩子校验分支与远端状态，并**原子推送**提交和 `vX.Y.Z` 标签。`-m` 让自动提交符合约定式提交；不带 `-m` 的 `pnpm version <版本>` 也会推送。标签触发 GitHub Actions 发布流程，Cloudflare 凭据与部署检查见 [部署指南](deployment.md)。

该命令需要能直接推送 `main`；若分支保护禁止直推，需改用 PR 发布流程。不要用 `--no-git-checks`、`--no-git-tag-version` 或 `-r` 绕开钩子。推送失败后**本地可能已有版本提交和标签**：先解决拒绝原因，再手动重试原子推送；不要再次运行 `pnpm version`。发布过的标签应保持不可变。

## 修改约定

- 使用 [Conventional Commits](https://www.conventionalcommits.org/)，保持提交原子化（例如 `feat(core): ...`、`fix(worker): ...`、`docs: ...`）。
- core 保持纯 TypeScript，不引入 Node 或 Cloudflare 专有 API；浏览器和 Worker 共用同一实现，不维护两套解析器。
- 规则解析或 provider 输出的行为变化需要更新 `COMPILER_VERSION`（缓存 key 的一部分）、补充单元测试，并在可行时补充真实内核探针。
- 不复制或逐行翻译 Mihomo 源码；依据公开文档与真实内核行为独立实现。
- 示例、测试和文档只使用虚构规则：域名优先用保留的 `.example` / `example.com`，IP 用文档专用地址段；不要提交真实订阅、节点、凭据、个人域名规则或可逆的 recipe 链接。
- 扩大产品范围前请先开 issue 讨论。
