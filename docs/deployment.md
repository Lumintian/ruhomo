# 部署指南

ruhomo 将网页与 API 部署在同一个 Cloudflare Worker，不需要数据库或定时任务。规则文件和 Sub-Store 的使用方法见 [集成说明](integration.md)。

## 1. 按版本标签发布（推荐）

项目由 [GitHub Actions 的发布流程](../.github/workflows/release.yml)在云端构建并部署到 Cloudflare。`main` / PR 上的 CI 只做验证，**只有推送 `vX.Y.Z` 标签才会部署**。开始前：

1. 在 Cloudflare 创建限定目标账号的 [Workers 编辑权限 API Token](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/#api-token)，并取得 Account ID。在 GitHub 仓库的 Secrets（或 `production` Environment Secrets）中分别配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`；不要提交凭据。
2. 若曾连接 [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/) 自动部署生产分支，先停用该连接；否则推送 `main` 时仍会部署，绕过标签流程。可在 GitHub 的 `production` Environment 上按需开启发布审批。
3. 检查 `apps/worker/wrangler.jsonc` 的 Worker 名称及公网地址；如需路径前缀，按下文设置构建变量。

维护者按 [开发指南的发布步骤](development.md#发布新版本) 推送版本标签后，GitHub Actions 会检查并测试该提交，通过后在云端构建网页与 Worker、部署到 Cloudflare。发布状态在仓库的 Actions 页面查看，部署地址以 Wrangler 输出为准。

### 手动从本地部署（不经过标签审批）

如需临时手动部署，在本地 clone 仓库，安装 Node.js ≥ 22.12 和 `package.json` 指定版本的 pnpm，然后在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @ruhomo/worker exec wrangler login
pnpm run deploy
```

`pnpm run deploy` 会在本地构建并实际上传网页与 API；`pnpm build` 仅做构建和部署预检查，不上传。不要用裸 `pnpm deploy`（pnpm 内置命令）。**手动部署会绕过标签发布流程**，正常发布请使用上面的 GitHub Actions。

默认仅能读取 GitHub / Gist 上公开的 HTTPS raw 规则文件。其他来源及自定义域名的设置见下文。

## 2. 部署后检查

把 `BASE` 改为自己的部署地址；若部署在路径前缀下，填入完整前缀（例如 `https://example.com/tools/ruhomo`）：

```sh
BASE=https://ruhomo.example.net
curl -fsS "$BASE/api/health"   # 应返回 ok: true 和 compilerVersion
curl -fsS "$BASE/api/config"   # 检查 publicBaseUrl、allowlist 和资源限制
```

然后打开网页，转换一个公开的示例规则文件，确认生成链接的域名和 provider 内容。无需向 ruhomo 提供完整 Mihomo 配置。

| 现象 | 优先检查 |
|---|---|
| 页面资源或 `/api/config` 404 | 代理转发、路径前缀及 `RUHOMO_BASE_PATH` |
| `403 SOURCE_URL_REJECTED` | 源地址和每次重定向的域名是否在白名单中 |
| `422 SOURCE_INVALID` | 文件是否为带出站目标的额外规则，而非完整配置或 provider `payload`；查看转换诊断 |
| `502` / `504` | 上游响应、文件大小、重定向及超时 |
| `429` 或 CPU 超限 | 限流设置、请求量、规则规模及 Cloudflare 面板的 CPU 指标 |

## 按需调整地址与来源

配置都写在 `apps/worker/wrangler.jsonc` 的 `vars` 中，修改后需重新部署：

- **自定义域名**：设置 `PUBLIC_BASE_URL`，例如 `https://ruhomo.example.net`，使生成的覆写和 provider 链接固定指向该域名。留空则使用请求的 origin。
- **其他规则来源**：在 `SOURCE_ALLOWLIST` 中添加域名（逗号分隔）。支持精确主机名或 `*.example.com`（仅匹配子域名）；重定向到的域名也必须允许。不要把凭据写进源 URL 或提交到配置文件。

### 部署在路径前缀下

若反向代理对外提供 `https://example.com/tools/ruhomo/`，同时设置：

1. `PUBLIC_BASE_URL` 为 `https://example.com/tools/ruhomo`；
2. GitHub Actions 发布时，在 GitHub `production` Environment 的 Variables 中设置 `RUHOMO_BASE_PATH=/tools/ruhomo/`；手动本地部署则运行 `RUHOMO_BASE_PATH=/tools/ruhomo/ pnpm run deploy`。

代理须将该前缀下的**静态资源、`api/*` 和 `r/*` 请求**去掉前缀后交给 Worker。访问页面用末尾带 `/` 的地址。`RUHOMO_BASE_PATH` 默认 `/`，必须以 `/` 开头和结尾；它是构建时的前端变量，**不是** Worker 的 `vars`，修改后需重新构建。可用 `pnpm test:e2e:prefix` 检查这一流程。

## 免费版与运行限制

根据 [Cloudflare Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)和[静态资源计费说明](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)，Workers Free 的主要限制包括每次请求 **10 ms CPU**、每天 **100,000 次 Worker 请求**；页面静态资源请求不计入该额度，`/api/*` 和 `/r/*` 请求会计入。额度会变化，部署时以官方文档和控制台为准。

每天的 provider 请求可粗估为「目标数 × Mihomo 客户端数 × 86,400 ÷ provider 更新间隔（秒）」，另加预览和覆写请求。例如 5 个目标、1 个客户端、每小时更新约 120 次/日。冷缓存还要抓取、解析和编译规则，可能先触及 CPU 限制。`pnpm bench` 测的是本机 Node.js 墙钟时间，**不是 Workers CPU 时间**。建议先以少量规则试运行，在 Cloudflare 面板观察冷请求 CPU、失败率和请求量。

Worker 仅在收到请求时抓取源文件。更新延迟还取决于上游 CDN、本服务缓存和 Mihomo 的 provider 更新间隔。内存缓存和可选的 Cache API 都不保证跨实例、跨机房同步；失败时只有在容错窗口内才会返回旧快照，否则返回错误，Mihomo 会保留上次成功下载的内容。本项目尚未在真实 Cloudflare 边缘实测 CPU、缓存命中或限流效果。

## 配置参考

下列变量位于 `apps/worker/wrangler.jsonc` 的 `vars` 中；本地开发可复制 `apps/worker/.dev.vars.example` 为已忽略的 `.dev.vars`。数值上限用于防滥用，**不是**当前套餐的性能保证。

| 变量 | 默认值 | 用途与范围 |
|---|---|---|
| `PUBLIC_BASE_URL` | 空 | 生成链接的公网地址；可含路径前缀，空值取请求 origin |
| `SOURCE_ALLOWLIST` | `raw.githubusercontent.com,gist.githubusercontent.com` | 允许获取规则的域名，逗号分隔 |
| `CACHE_FRESH_SECONDS` | `60` | 成功快照的免验证期，0–3600 秒 |
| `CACHE_STALE_SECONDS` | `86400` | 失败后可回退旧快照的最长时间，0–604800 秒 |
| `FETCH_TIMEOUT_MS` | `10000` | 含重定向的上游请求超时，1000–30000 毫秒 |
| `MAX_REDIRECTS` | `3` | 最多重定向次数，0–5 |
| `MAX_SOURCE_BYTES` | `262144` | 源文件字节上限，1024–1048576 |
| `MAX_RULES` | `5000` | 规则条数上限，1–20000 |
| `MAX_TARGETS` | `128` | 出站目标数量上限，1–512 |
| `MAX_RULE_BYTES` | `16384` | 单条规则字节上限，256–65536 |

配置无效时，相关接口返回 `500 CONFIG_ERROR`，不会回显配置细节。

## 限流与隐私

- 项目不提供全局限流。公开实例可按 Cloudflare 套餐配置 WAF Rate Limiting，或启用 `wrangler.jsonc` 中的 `RATE_LIMITER` 示例；后者按 Cloudflare 位置近似计数。
- Worker 自己不记录规则正文、完整源 URL 或 recipe token，且默认关闭 `observability`。**访问 URL 中的 recipe token 可逆**；若启用 Workers Logs，或经由其他代理，URL 仍可能被记录。不要公开真实覆写链接、截图或测试日志。详见 [安全策略](../SECURITY.md)。
