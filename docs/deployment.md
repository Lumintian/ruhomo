# 部署指南

ruhomo 的网页与 API 部署在同一个 Cloudflare Worker 中，不依赖数据库或定时任务。规则文件的编写和 Sub-Store 的配置方法见[集成说明](integration.md)。

## 1. 部署方式

### 按版本标签发布（推荐）

项目通过 [GitHub Actions 发布流程](../.github/workflows/release.yml)在云端构建并部署到 Cloudflare。`main` 分支和 PR 上的 CI 只做验证，**只有推送 `vX.Y.Z` 标签才会触发部署**。

首次发布前，请完成以下准备：

1. **配置凭据**：在 Cloudflare 创建一个限定目标账号、具有 [Workers 编辑权限的 API Token](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/#api-token)，并获取 Account ID。然后在 GitHub 仓库的 Secrets（或 `production` Environment 的 Secrets）中分别设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。切勿将凭据提交到仓库。
2. **停用其他自动部署**：如果之前连接过 [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/) 来自动部署生产分支，请先停用该连接，否则推送 `main` 时仍会触发部署，绕过标签流程。如有需要，可在 GitHub 的 `production` Environment 上开启发布审批。
3. **检查部署配置**：确认 `apps/worker/wrangler.jsonc` 中的 Worker 名称和公网地址。如需部署在路径前缀下，请按[下文](#部署在路径前缀下)设置构建变量。

维护者按照[开发指南中的发布步骤](development.md#发布新版本)推送版本标签后，GitHub Actions 会先对该提交进行检查和测试，全部通过后再在云端构建网页与 Worker 并部署到 Cloudflare。发布进度可在仓库的 Actions 页面查看，实际部署地址以 Wrangler 的输出为准。

### 从本地手动部署

如需临时手动部署，请先 clone 仓库，安装 Node.js ≥ 22.12 和 `package.json` 所指定版本的 pnpm，然后在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @ruhomo/worker exec wrangler login
pnpm run deploy
```

各命令的区别：

- `pnpm run deploy`：在本地构建，并**实际上传**网页与 API。
- `pnpm build`：仅执行构建和部署预检，不会上传。
- 不要使用不带 `run` 的 `pnpm deploy`，它是 pnpm 的内置命令，与本项目的部署无关。

> [!WARNING]
> 手动部署会**绕过标签发布流程**。常规发布请使用上述 GitHub Actions 流程。

默认只能读取 GitHub 与 Gist 上公开的 HTTPS raw 规则文件。如需允许其他来源或使用自定义域名，请参阅[调整地址与来源](#3-调整地址与来源)。

## 2. 部署后检查

将 `BASE` 替换为你的部署地址。如果部署在路径前缀下，请填写包含前缀的完整地址（例如 `https://example.com/tools/ruhomo`）：

```sh
BASE=https://ruhomo.example.net
curl -fsS "$BASE/api/health"   # 应返回 ok: true 和 compilerVersion
curl -fsS "$BASE/api/config"   # 检查 publicBaseUrl、allowlist 和资源限制
```

然后打开网页，转换一个公开的示例规则文件，确认生成链接的域名和 provider 内容均符合预期。整个过程无需向 ruhomo 提供完整的 Mihomo 配置。

常见问题排查：

| 现象 | 优先检查 |
|---|---|
| 页面资源或 `/api/config` 返回 404 | 代理转发规则、路径前缀以及 `RUHOMO_BASE_PATH` |
| `403 SOURCE_URL_REJECTED` | 源地址及每次重定向的目标域名是否都在 allowlist 中 |
| `422 SOURCE_INVALID` | 文件内容是否为带出站目标的额外规则，而非完整配置或 provider 的 `payload`；查看转换诊断 |
| `502` / `504` | 上游响应、文件大小、重定向次数和超时设置 |
| `429` 或 CPU 超限 | 限流设置、请求量、规则规模，以及 Cloudflare 控制台中的 CPU 指标 |

## 3. 调整地址与来源

以下配置均位于 `apps/worker/wrangler.jsonc` 的 `vars` 中，修改后需要重新部署：

- **自定义域名**：将 `PUBLIC_BASE_URL` 设为例如 `https://ruhomo.example.net`，生成的覆写和 provider 链接将固定使用该域名。留空时使用请求的 origin。
- **其他规则来源**：在 `SOURCE_ALLOWLIST` 中添加域名，多个域名以逗号分隔。支持精确主机名，也支持 `*.example.com`（仅匹配子域名，不含 `example.com` 本身）。重定向的目标域名同样需要在列表中。请勿将凭据写入源 URL 或提交到配置文件。

### 部署在路径前缀下

如果通过反向代理以 `https://example.com/tools/ruhomo/` 对外提供服务，需要同时完成以下设置：

1. 将 `PUBLIC_BASE_URL` 设为 `https://example.com/tools/ruhomo`。
2. 设置构建变量 `RUHOMO_BASE_PATH=/tools/ruhomo/`：
   - 通过 GitHub Actions 发布时，在 GitHub `production` Environment 的 Variables 中添加；
   - 从本地手动部署时，运行 `RUHOMO_BASE_PATH=/tools/ruhomo/ pnpm run deploy`。

此外还需注意：

- 反向代理必须将该前缀下的**静态资源、`api/*` 和 `r/*` 请求**去掉前缀后转发给 Worker。
- 访问页面时，请使用以 `/` 结尾的地址。
- `RUHOMO_BASE_PATH` 默认为 `/`，必须以 `/` 开头和结尾。它是前端的构建时变量，**不属于** Worker 的 `vars`，修改后需要重新构建。
- 可以运行 `pnpm test:e2e:prefix` 验证路径前缀流程。

## 4. 免费版与运行限制

根据 [Cloudflare Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)和[静态资源计费说明](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)，Workers Free 套餐的主要限制为每次请求 **10 ms CPU** 和每天 **100,000 次 Worker 请求**。页面静态资源请求不计入该额度，`/api/*` 和 `/r/*` 请求计入。额度可能调整，请以官方文档和控制台为准。

**估算请求量**：每天的 provider 请求数约为：

```text
目标数 × Mihomo 客户端数 × 86,400 ÷ provider 更新间隔（秒）
```

再加上预览和覆写请求。例如，5 个目标、1 个客户端、每小时更新一次，每天约 120 次请求。

**CPU 时间**：缓存未命中时需要抓取、解析和编译规则，可能先触及 CPU 限制。`pnpm bench` 测量的是本机 Node.js 的墙钟时间，**不代表 Workers CPU 时间**。建议先用少量规则试运行，并在 Cloudflare 控制台观察冷请求的 CPU 用量、失败率和请求量。

**更新延迟与缓存**：Worker 仅在收到请求时抓取源文件，因此更新延迟还取决于上游 CDN、本服务的缓存和 Mihomo 的 provider 更新间隔。内存缓存和可选的 Cache API 都不保证跨实例或跨数据中心同步。源获取失败时，仅在容错窗口内返回旧快照，超出后返回错误；此时 Mihomo 会继续使用上一次成功下载的内容。

> [!NOTE]
> 本项目尚未在真实的 Cloudflare 边缘环境中实测 CPU 用量、缓存命中率或限流效果。

## 5. 配置参考

下列变量位于 `apps/worker/wrangler.jsonc` 的 `vars` 中。本地开发时，可将 `apps/worker/.dev.vars.example` 复制为 `.dev.vars`（已被 git 忽略）。数值上限用于防止滥用，**并非**当前套餐下的性能保证。

| 变量 | 默认值 | 用途与取值范围 |
|---|---|---|
| `PUBLIC_BASE_URL` | 空 | 生成链接所用的公网地址，可包含路径前缀；留空时使用请求的 origin |
| `SOURCE_ALLOWLIST` | `raw.githubusercontent.com,gist.githubusercontent.com` | 允许获取规则的域名，以逗号分隔 |
| `CACHE_FRESH_SECONDS` | `60` | 成功快照的免验证时长，0–3600 秒 |
| `CACHE_STALE_SECONDS` | `86400` | 获取失败后可回退到旧快照的最长时长，0–604800 秒 |
| `FETCH_TIMEOUT_MS` | `10000` | 上游请求的总超时（含重定向），1000–30000 毫秒 |
| `MAX_REDIRECTS` | `3` | 最大重定向次数，0–5 |
| `MAX_SOURCE_BYTES` | `262144` | 源文件大小上限（字节），1024–1048576 |
| `MAX_RULES` | `5000` | 规则条数上限，1–20000 |
| `MAX_TARGETS` | `128` | 出站目标数量上限，1–512 |
| `MAX_RULE_BYTES` | `16384` | 单条规则大小上限（字节），256–65536 |

配置无效时，相关接口返回 `500 CONFIG_ERROR`，且不会回显配置细节。

## 6. 限流与隐私

- **限流**：项目本身不提供全局限流。公开实例可根据 Cloudflare 套餐配置 WAF Rate Limiting，或启用 `wrangler.jsonc` 中注释掉的 `RATE_LIMITER` 示例；后者按 Cloudflare 数据中心位置近似计数。
- **日志**：Worker 自身不记录规则正文、完整源 URL 或 recipe token，并默认关闭 `observability`。但**访问 URL 中的 recipe token 是可逆的**：如果启用了 Workers Logs 或经过其他代理，URL 仍可能被记录。请勿公开真实的覆写链接、截图或测试日志。详见[安全策略](../SECURITY.md)。
