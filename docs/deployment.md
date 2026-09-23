# 部署（Cloudflare Workers + Static Assets）

一次部署同时提供前端静态资源与 API，不需要 KV、D1、Durable Objects 等任何 binding。

## 步骤

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login          # 在 apps/worker 目录或用 pnpm --filter 执行均可
# 按需编辑 apps/worker/wrangler.jsonc 的 name / vars
pnpm deploy                       # = 构建前端 + wrangler deploy
```

`pnpm build` 只做本地构建与 `wrangler deploy --dry-run` 打包检查，不会上传任何东西。本仓库**没有**替你执行过真实部署。

## 路由边界

| 路径 | 处理者 |
|---|---|
| `/api/*`、`/r/*` | 永远先进入 Worker（`assets.run_worker_first`）；未知路径返回 JSON 404，不会被 SPA fallback 变成 200 HTML |
| 其它路径 | 静态资源；找不到时返回 `index.html`（SPA） |

静态资源的 CSP、`nosniff`、`Referrer-Policy: no-referrer` 等由 `apps/web/public/_headers` 下发；Worker 的 JSON/文本响应自带 `default-src 'none'` 的 CSP 与 `nosniff`。

## 环境变量（`wrangler.jsonc` → `vars`）

| 变量 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `PUBLIC_BASE_URL` | 空 | http(s) URL | 生成绝对链接用的基址，可含路径前缀，末尾斜杠会被规范化。为空时使用请求本身的 origin。**不读取 `X-Forwarded-Host`**。使用自定义域名时务必设置 |
| `SOURCE_ALLOWLIST` | `raw.githubusercontent.com,gist.githubusercontent.com` | 逗号分隔 | 精确主机名或 `*.example.com`（只匹配严格子域名，不含 `example.com` 本身）。没有后缀/子串匹配 |
| `CACHE_FRESH_SECONDS` | 60 | 0–3600 | 成功快照免验证期 |
| `CACHE_STALE_SECONDS` | 86400 | 0–604800 | 源失败时可回退旧成功结果的最长时间（从最近一次成功验证起算） |
| `FETCH_TIMEOUT_MS` | 10000 | 1000–30000 | 整个获取（含重定向）的总超时 |
| `MAX_REDIRECTS` | 3 | 0–5 | 每跳重新校验协议、主机与限制 |
| `MAX_SOURCE_BYTES` | 262144 | 1 KiB–1 MiB | 解压后实际读取字节上限（流式计数，不只信 Content-Length） |
| `MAX_RULES` | 5000 | 1–20000 | |
| `MAX_TARGETS` | 128 | 1–512 | |
| `MAX_RULE_BYTES` | 16384 | 256–65536 | 单条规则 |

这些都是防滥用上限，不是性能保证；访问者无法通过 URL 修改它们。配置非法时服务返回 `500 CONFIG_ERROR`，不暴露细节。

不要把任何 secret 写进 `wrangler.jsonc`；本项目本身不需要 secret。本地开发可复制 `apps/worker/.dev.vars.example` 为 `.dev.vars`（已被 git 忽略）。

### 反向代理与路径前缀

生成的链接形如 `${PUBLIC_BASE_URL}/r/v1/...`。如果你用反向代理把服务挂在 `https://example.com/tools/ruhomo/` 下，请设置 `PUBLIC_BASE_URL=https://example.com/tools/ruhomo`，并由反向代理**去掉前缀**后再转发给 Worker（Worker 始终在根路径提供服务）。

## 缓存

- 按需获取，没有 scheduler；Mihomo 的 `interval` 是消费者的刷新周期，不是本服务的抓取周期。
- isolate 内有界内存缓存 + 同源并发合并；可用时再把完整成功快照写入 Cache API（`caches.default`，按数据中心）。Cache API 不可用或出错时功能仍然正确，只是命中率下降。在 `*.workers.dev` 上 Cache API 可能不生效，建议绑定自定义域名。
- 这是 best-effort 缓存，**不是**持久化的 Last Known Good：快照可能随时被驱逐，此时源失败就会返回非 2xx（provider 端 Mihomo 会保留上次成功下载的内容）。
- 更新延迟 = 上游 CDN 缓存（raw.githubusercontent.com 约数分钟）+ 本服务 fresh 期 + Mihomo `interval`。

## 限流

Workers 内存计数器不是全局限流，本项目不提供那种“限流”。可选：

1. 在 Cloudflare 面板为该域名配置 WAF Rate Limiting 规则（推荐，作用于全局）。
2. 启用 Workers Rate Limiting binding：取消 `wrangler.jsonc` 中 `ratelimits` 示例的注释，binding 名为 `RATE_LIMITER`。Worker 会以 `CF-Connecting-IP` 为 key 调用它，超限返回 429。该 binding 的计数是按 Cloudflare 位置近似的，请按其文档理解精度。

## 日志与隐私

- Worker 只输出事件名、错误码和截断摘要（如源描述符哈希前 12 位），不记录源正文、完整源 URL、recipe token、规则或请求头。
- `wrangler.jsonc` 默认 `observability.enabled: false`：Workers Logs 的调用日志会记录请求 URL，而 URL 中含有 recipe token（可解码出源 URL）。若启用，请知悉这一点并控制日志访问权限。
- 即使本项目不记录，Cloudflare 或你前面的反向代理仍可能记录访问 URL；请按你的平台设置日志保留与访问策略。
- 服务部署者可以看到被提交转换的额外规则（这正是 URL 模式的工作方式）；粘贴模式在浏览器本地完成，不经过服务端。

## 资源与性能

本地基准（`pnpm bench`）——**Node wall time，不是 Workers CPU 时间**：

环境：本地 Node.js 环境测得；设备信息不公开，数据仅供粗略参考。

| 规则数 | 源大小 KiB | 冷编译中位数 ms | p95 ms | 热缓存 provider 中位数 ms | 热缓存 override.js 中位数 ms |
|---:|---:|---:|---:|---:|---:|
| 100 | 4.7 | 1.24 | 2.47 | 0.140 | 0.245 |
| 1000 | 48.3 | 7.51 | 11.20 | 0.145 | 0.239 |
| 5000 | 245.3 | 34.31 | 44.03 | 0.404 | 0.281 |

解读与限制：

- 冷缓存请求的主要成本是解析 + 编译；热缓存请求只做视图派生与 ETag 计算。
- Workers Free 计划的 CPU 限制远低于上表中大源的冷编译耗时量级；**上千条规则的源在 Free 计划上冷缓存时可能超出 CPU 限制**。本项目**尚未在 Cloudflare 上实测** CPU 时间。部署后可在 Cloudflare 面板的 Workers 指标中查看实际 CPU time；需要时改用付费计划或减小规则文件。
- Worker 打包体积（`pnpm build` 输出）约 1.1 MiB，gzip 约 205 KiB。

## 未执行 / 受限的验证

- 没有云部署凭据：未执行真实 `wrangler deploy`，未在 Cloudflare 边缘上测量 CPU、Cache API 命中或限流 binding。
- Cache API 行为只在本地 workerd（Miniflare）中验证（`pnpm test:workerd`）。
