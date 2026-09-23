# 架构

## 总览

```
            ┌───────────────────────── packages/core（纯 TS，无 Node/Workers API）──────────────────────────┐
 源文本 ──► │ document-parser ─► rule-parser ─► compiler ─► Snapshot ─► orderTargets ─► Integration IR ─► YAML/JS │
            │                         recipe（token）  naming（稳定名称）  url-policy（源地址策略）                │
            └────────────────────────────────────────────────────────────────────────────────────────────────────┘
                 ▲ 浏览器（粘贴模式，本地）                                   ▲ Worker（URL 模式）
                 │                                                            │
           apps/web (React)                          apps/worker (Hono) ── source-fetcher ── snapshot-cache
```

core 只依赖 `yaml` 与 `zod`，以及所有运行时都有的 `TextEncoder`/`TextDecoder`/`URL`。SHA-256 在 core 中以纯 TS 同步实现，因此命名在非安全上下文的浏览器中也可用。core 在浏览器、Node 测试和 Workers 中运行同一份代码。

## 数据流

1. **document-parser**：去 BOM、处理 CRLF，按确定规则识别格式（`auto`），得到 `RuleLine[]`（原文、行、列、序号）。YAML 解析失败就是失败，绝不回退为 text。
2. **rule-parser**：独立实现 Mihomo 字段切分语义，校验类型/参数/载荷，产出 `ParsedRule`（含去掉目标后的 `providerRule` 与结构化 warning）。
3. **compiler**：全部行解析完成且无 error 才分组；任何 error 使整次编译失败，没有半成品。结果是不可变的 `Snapshot`：`sourceDigest`、`compilerVersion`、`mihomoBaseline`、首次出现顺序的目标组、每组 provider 正文、warning。
4. **orderTargets**：应用 recipe 的 `targetOrder`（不存在的项只告警、不创建 provider），并在分组改变了规则相对位置时告警。
5. **Integration IR**：provider 定义 + 有序 `RULE-SET` 条目 + 命名空间 + 传输方式（`http` / `inline`）。YAML 与 JS 生成器都只消费 IR。
6. **Worker**：`/r/v1/{R}/...` 所有端点共用同一个 snapshot 加载器，按源描述符（URL + 格式 + 编译器版本 + 限制）获取和编译一次，再派生各个视图。

## 标识

- recipe token `R` = 无填充 Base64url(UTF-8(按 key 排序的规范 JSON))。解码只接受规范编码，因此一个 recipe 只有一个 token。
- 目标 token `T` = Base64url(UTF-8(原始目标名))，可逆，所以目标从源中消失后服务仍知道请求的是谁，并返回合法空集合。
- provider 名称 `mrp-{recipeId}-{targetId}`：两段各取域分离 SHA-256 的前 128 bit，只依赖 recipe 与原始目标名；检测碰撞而非假设不会碰撞。
- 源 URL 用 WHATWG URL 解析一次，其 `href` 同时用于安全校验、实际获取和标识，不排序查询参数、不改写路径编码。

## 缓存与失败语义

`SnapshotLoader`（apps/worker/src/snapshot-cache.ts）：

| 状态 | 行为 |
|---|---|
| 无快照 | 获取 + 编译；失败 → 非 2xx |
| `now - validatedAt < fresh` | 直接使用 |
| 超过 fresh | 带 `If-None-Match`/`If-Modified-Since` 有超时的重新验证；304 仅在持有对应快照时接受 |
| 重新验证失败且在容错窗口内 | 返回旧快照，`X-Result-Stale: true` + `X-Last-Error` |
| 超过容错窗口或已被驱逐 | 非 2xx |

- `validatedAt` 只在成功时更新，失败不会延长容错期限，也不会覆盖成功快照。
- 只缓存完整成功快照；错误不作为结果缓存（仅有 5 秒的单源失败退避，退避期间仍返回旧快照或错误）。
- 层次：isolate 内有界 LRU + 同源并发合并；可选 Cache API（按数据中心，尽力而为）。都不是跨 isolate/跨机房锁，也不提供跨 provider 的原子切换。
- 只有在源已成功验证后，缺失的目标才返回 `200 # empty`；源 404、超时、空响应永远不会变成空集合。

## 路由边界

`wrangler.jsonc` 的 `assets.run_worker_first: ["/api/*", "/r/*"]` 保证这两类路径总是进入 Worker；Worker 内对未知的 `/api/*`、`/r/*` 返回 JSON 404，绝不落到 SPA fallback。其它路径由静态资源（SPA 模式）处理。

## 为什么是这些选择

- **无数据库 recipe**：第一版不需要账号或存储，链接自描述；代价是链接较长且可解码源 URL（已在 UI 与文档中提示）。
- **严格于内核的解析**：真实内核会静默接受很多错误输入（见 [compatibility.md](compatibility.md) 的探针结果），而 provider 中的坏行只会被内核警告并跳过，用户难以察觉；因此在转换阶段就整体失败。
- **远程覆写不含规则内容**：保证只改组内规则时覆写正文不变，Sub-Store 侧无需任何动作。
- **ES5 JS 覆写**：`function main(config)` 形式，数据以转义后的 JSON 嵌入，不依赖任何运行库或网络。

## 未来可能的扩展（第一版未实现，也没有空实现）

持久化 Last Known Good（KV/D1/Durable Objects）、短链接、目标别名、需凭据的私有源、MRS/domain/ipcidr 拆分、其它云平台适配器。
