# 开发指南

本文介绍本地开发、测试、版本发布和代码约定。部署服务的步骤见[部署指南](deployment.md)。

## 项目概览

### 目录结构

| 目录 | 职责 |
|---|---|
| `packages/core/` | 纯 TypeScript 转换核心，由浏览器与 Worker 共用 |
| `apps/worker/` | 受限的源获取、HTTP 路由与缓存 |
| `apps/web/` | React 前端页面 |
| `tests/integration/` | 使用固定版本的真实 Mihomo 内核验证输出 |

### 相关文档

- [架构](architecture.md)：core、Worker 与前端的职责划分，以及缓存和路由设计。
- [兼容性](compatibility.md)：规则解析所依据的 Mihomo 版本、已验证范围，以及明确不作保证的行为。
- [安全策略](../SECURITY.md)：源 URL、资源上限、日志和隐私方面的边界。
- 产品范围见 [README 的「作用范围」](../README.md#作用范围)。新增功能不应擅自访问用户的完整配置或 Mihomo Controller。

## 本地环境

需要 Node.js ≥ 22.12 以及 `package.json` 所指定版本的 pnpm。请只使用 pnpm，并保留 `pnpm-lock.yaml`。

```sh
pnpm install --frozen-lockfile
pnpm dev                 # 同时启动 Wrangler（:8787）和 Vite（:5173），访问 http://localhost:5173
```

如需自定义本地变量，可将 `apps/worker/.dev.vars.example` 复制为 `apps/worker/.dev.vars`（该文件已被 git 忽略，请勿提交）。

`pnpm dev` 不需要任何云端部署凭据。

> [!WARNING]
> `pnpm run deploy` 会**实际部署**到 Cloudflare，请勿将其当作本地构建命令。部署步骤见[部署指南](deployment.md)。

## 检查与测试

| 命令 | 用途 |
|---|---|
| `pnpm lint` | ESLint 检查 |
| `pnpm typecheck` | 根目录及各工作区的 TypeScript 类型检查 |
| `pnpm test` | core 与 Worker 的单元测试和 HTTP 测试（Node） |
| `pnpm test:workerd` | 在 workerd（Miniflare）中运行 Worker 冒烟测试 |
| `pnpm test:e2e` | Playwright 前端流程测试，需要本地 Chromium |
| `pnpm test:e2e:prefix` | Playwright 路径前缀（`/tools/ruhomo/`）流程测试 |
| `pnpm test:integration` | 下载并校验固定版本的 Mihomo 测试内核，然后运行集成测试 |
| `pnpm bench` | 本地 Node.js 墙钟时间基准，**不代表** Workers CPU 时间 |
| `pnpm build` | 构建前端并执行 Worker 的 `wrangler deploy --dry-run`，不会上传 |

首次运行浏览器测试前，请执行 `pnpm --filter @ruhomo/web exec playwright install chromium` 安装 Chromium。

提交前至少运行以下检查：

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm test:workerd && pnpm build
```

此外，根据改动范围补充运行：

- 涉及前端或路径前缀：运行对应的 e2e 测试。
- 涉及内核兼容性：运行集成测试。

如有无法运行的检查，请在 PR 中说明，不要声称已通过。

## 发布新版本

### 版本号约定

- 根目录 `package.json` 是**唯一的发布版本来源**。`core`、`web`、`worker` 是私有工作区，其 `0.0.0` 仅为占位，不随发布升级。
- `COMPILER_VERSION`、`RECIPE_VERSION` 和 Mihomo 测试基准各自标记独立的兼容性边界，不随产品版本号递增。

### 发布步骤

先提交所有普通改动，确认当前位于干净的 `main` 分支，且与远端 `main` 保持同步，然后在仓库根目录运行：

```sh
pnpm version patch -m 'chore(release): v%s'
# 也可以将 patch 换成 minor、major 或具体的版本号
```

该命令会依次完成：

1. `preversion` 钩子校验当前位于 `main`、工作区干净，且本地已包含远端 `main`；
2. pnpm 更新根目录的版本号，创建版本提交和附注标签；
3. `postversion` 钩子再次校验，并**原子推送**版本提交和 `vX.Y.Z` 标签（要么同时成功，要么都不推送）。

`-m` 参数使自动生成的提交信息符合约定式提交规范；不带 `-m` 时同样会推送。标签推送后将触发 GitHub Actions 发布流程，Cloudflare 凭据配置与部署后检查见[部署指南](deployment.md)。

### 注意事项

- 该命令需要直接推送到 `main` 的权限。如果分支保护规则禁止直推，需要改用基于 PR 的发布流程。
- 不要使用 `--no-git-checks`、`--no-git-tag-version` 或 `-r` 绕过钩子。
- 如果推送失败，**本地可能已经生成了版本提交和标签**。请先解决推送被拒绝的原因，再手动重试原子推送，不要重复运行 `pnpm version`。
- 已发布的标签应保持不变，不要移动或删除。

## 代码与提交约定

- **提交信息**：遵循 [Conventional Commits](https://www.conventionalcommits.org/)，并保持提交原子化，例如 `feat(core): ...`、`fix(worker): ...`、`docs: ...`。
- **core 的可移植性**：core 必须保持纯 TypeScript，不引入 Node 或 Cloudflare 专有 API。浏览器和 Worker 共用同一份实现，不维护两套解析器。
- **行为变更**：规则解析或 provider 输出的行为发生变化时，需要递增 `COMPILER_VERSION`（它是缓存 key 的一部分）、补充单元测试，并尽可能补充真实内核探针。
- **独立实现**：不复制或逐行翻译 Mihomo 源码，而是依据公开文档与真实内核行为独立实现。
- **测试数据**：示例、测试和文档只使用虚构规则。域名优先使用保留的 `.example` 或 `example.com`，IP 使用文档专用地址段。不要提交真实的订阅、节点、凭据、个人域名规则或可还原源地址的 recipe 链接。
- **产品范围**：扩大产品范围前，请先开 issue 讨论。
