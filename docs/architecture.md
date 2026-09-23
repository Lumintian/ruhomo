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

浏览器、Node 测试和 Workers 运行的是同一份 core 代码。core 仅依赖 `yaml` 与 `zod`，以及所有运行时均提供的 `TextEncoder`、`TextDecoder` 和 `URL`。SHA-256 在 core 中以纯 TypeScript 同步实现，因此即使在非安全上下文的浏览器中也能生成名称。

## 数据流

1. **document-parser**：去除 BOM、统一 CRLF 换行，按确定的规则识别格式（`auto`），输出 `RuleLine[]`（包含原文、行号、列号和序号）。YAML 解析失败即视为失败，绝不回退为纯文本解析。
2. **rule-parser**：独立实现 Mihomo 的字段切分语义，校验规则类型、参数和载荷，输出 `ParsedRule`（包括去掉目标后的 `providerRule` 以及结构化的 warning）。
3. **compiler**：所有行解析完成且没有 error 时才进行分组；只要存在 error，整次编译即失败，不会产出不完整的结果。编译结果是不可变的 `Snapshot`，包含 `sourceDigest`、`compilerVersion`、`mihomoBaseline`、按首次出现顺序排列的目标分组、各组的 provider 正文以及 warning。
4. **orderTargets**：应用 recipe 中的 `targetOrder`（对不存在的目标只发出警告，不会为其创建 provider）；如果分组改变了规则间的相对顺序，也会发出警告。
5. **Integration IR**：由 provider 定义、有序的 `RULE-SET` 条目、命名空间和传输方式（`http` / `inline`）组成。YAML 与 JS 生成器都只消费 IR。
6. **Worker**：`/r/v1/{R}/...` 下的所有端点共用同一个 snapshot 加载器。它以源描述符（URL + 格式 + 编译器版本 + 限制）为键，只获取和编译一次，再从结果派生出各个视图。

## 标识

- **recipe token `R`**：无填充 Base64url(UTF-8(按 key 排序的规范 JSON))。解码时只接受规范编码，因此每个 recipe 只对应唯一的 token。
- **目标 token `T`**：Base64url(UTF-8(原始目标名))。由于可逆，即使目标已从源中消失，服务仍能识别所请求的目标，并返回合法的空集合。
- **provider 名称**：格式为 `mrp-{recipeId}-{targetId}`，两段分别取域分离 SHA-256 的前 128 bit，只依赖 recipe 和原始目标名。实现中会主动检测碰撞，而非假设不会碰撞。
- **源 URL**：使用 WHATWG URL 解析一次，所得的 `href` 同时用于安全校验、实际获取和标识计算。不对查询参数排序，也不改写路径编码。

## 缓存与失败语义

`SnapshotLoader`（`apps/worker/src/snapshot-cache.ts`）按以下状态处理请求：

| 状态 | 行为 |
|---|---|
| 无快照 | 获取并编译；失败则返回非 2xx |
| `now - validatedAt < fresh` | 直接使用现有快照 |
| 超过 fresh 期 | 携带 `If-None-Match` / `If-Modified-Since` 发起有超时的重新验证；仅在持有对应快照时才接受 304 |
| 重新验证失败，但仍在容错窗口内 | 返回旧快照，并附带 `X-Result-Stale: true` 和 `X-Last-Error` |
| 超出容错窗口，或快照已被驱逐 | 返回非 2xx |

补充说明：

- `validatedAt` 只在成功时更新。失败既不会延长容错期限，也不会覆盖成功的快照。
- 只缓存完整的成功快照，错误结果不会被缓存。唯一的例外是针对单个源的 5 秒失败退避，退避期间仍会返回旧快照或错误。
- 缓存分两层：isolate 内的有界 LRU（同时合并对同一源的并发请求），以及可选的 Cache API（按数据中心划分，尽力而为）。两者都不是跨 isolate 或跨数据中心的锁，也不提供跨 provider 的原子切换。
- 只有在源已成功验证的前提下，缺失的目标才会返回 `200 # empty`。源返回 404、超时或空响应时，永远不会被当作空集合。

## 路由边界

`wrangler.jsonc` 中的 `assets.run_worker_first: ["/api/*", "/r/*"]` 确保这两类路径始终由 Worker 处理。对于未知的 `/api/*` 和 `/r/*` 路径，Worker 返回 JSON 格式的 404，绝不会落入 SPA fallback。其他路径均由静态资源（SPA 模式）处理。

## 设计取舍

- **recipe 无需数据库**：第一版不需要账号或存储，链接本身即包含全部描述信息。代价是链接较长，且可从中解码出源 URL（UI 与文档中均已提示）。
- **解析比内核更严格**：真实内核会静默接受许多错误输入（见[兼容性文档](compatibility.md)中的探针结果），而 provider 中的错误行只会被内核警告并跳过，用户很难察觉。因此 ruhomo 选择在转换阶段就让整次转换失败。
- **远程覆写不含规则内容**：这样可以保证只修改组内规则时，覆写正文保持不变，Sub-Store 侧无需任何操作。
- **ES5 JS 覆写**：采用 `function main(config)` 形式，数据以转义后的 JSON 嵌入，不依赖任何运行库或网络。

## 后续可能的扩展

以下功能第一版尚未实现，代码中也没有预留空实现：

- 持久化的 Last Known Good（KV、D1 或 Durable Objects）
- 短链接
- 目标别名
- 需要凭据的私有源
- MRS 格式以及 domain / ipcidr 拆分
- 其他云平台适配器
