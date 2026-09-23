# ruhomo

把你**单独维护的一组额外 Mihomo rules**，按每条规则的出站目标分组，生成若干 HTTP `rule-provider`，并生成 Sub-Store 可用的 YAML / JavaScript **addon 覆写**。

> **English summary.** ruhomo converts a separately maintained list of extra Mihomo rules into one HTTP classical rule-provider per outbound target, plus YAML/JS "addon" overrides for Sub-Store. The override merges the generated `rule-providers` and prepends `RULE-SET` entries to the original `rules`; everything else in your config stays untouched. The service never needs your nodes, subscriptions, proxy groups, DNS or full config. Runs on Cloudflare Workers (static assets + API in one deployment); the core is pure TypeScript and also runs in the browser, where pasted rules are converted locally.

```
你维护的额外 rules（raw URL）
        │
        ▼
     ruhomo 转换 ──► 每个出站目标一个 HTTP rule-provider
        │        └─► override.yaml / override.js（addon）
        ▼
Sub-Store 在你自己的环境合并原配置
        │
        ▼
     Mihomo 使用生成后的配置
```

## 它做什么，不做什么

只有 addon 语义：

- 合并新增的 `rule-providers`；
- 把生成的 `RULE-SET,<provider>,<出站目标>` **前插**到原 `rules`；
- 原有 rules 的内容和相对顺序保持不变。

明确不做：访问你的 Mihomo Controller、刷新或重启 Mihomo、修改 OpenClash/网络/防火墙/订阅、管理节点/代理组/DNS、全量配置转换、删除或“智能推断”原配置中的规则、MRS 与规则优化、账号/数据库/短链、后台定时抓取。

## 快速上手

1. 在 GitHub 等处维护一个额外规则文件（见 [`examples/`](examples/)），取得它的 raw URL。
2. 打开部署好的 ruhomo 页面，选择“Raw URL”，粘贴链接并点击“转换 / 预览”。
3. 检查出站目标、规则数量和诊断；需要时用 ↑/↓ 调整 RULE-SET 顺序。
4. 复制 **远程覆写链接**（YAML 或 JS），在 Sub-Store 中作为覆写/脚本添加到你的配置文件上。

之后只修改规则文件中**已有目标**的规则时，Mihomo 会按 provider 的 `interval` 自行重新下载，不需要改覆写。详见 [集成说明](docs/integration.md)。

没有 raw URL？选择“直接粘贴”：规则只在浏览器本地转换，导出的是**静态**覆写（inline provider），不支持独立规则热更新，修改规则后需要重新应用覆写。

支持的输入：顶层只有 `rules` 的 YAML 映射、YAML 字符串列表、一行一条的纯文本。显式清空请写 `rules: []`（YAML）或单独一行 `# mrp:empty`（文本）；空文件或只有注释会被当作错误，避免误清空。

## 必读的语义说明

1. **为什么只要额外 rules**：生成的覆写只新增 provider 和 RULE-SET 条目，引用的出站目标必须已存在于你的原配置中；因此服务不需要也不接受完整配置（误传会被拒绝，且不会回显内容）。
2. **`rule-providers` 合并与 `+rules` 前插**：YAML 覆写中 `rule-providers` 是映射合并，`+rules` 是把列表插到原 `rules` 前面；不是 `+rule-providers`，也不是 `rules+`。
3. **`rule-providers.proxy` 不是出站目标**：该字段控制“规则文件通过哪个代理下载”，与 `RULE-SET` 最后的出站目标无关；ruhomo 默认不生成它。
4. **两条更新路径**：已有目标的规则变化 → Mihomo 自己重新下载 provider；**新增目标**（或目标改名，本质是旧目标变空+新目标新增）→ 需要重新获取并应用覆写、重新生成并加载主配置。只重新生成 Sub-Store 文件不等于正在运行的 Mihomo 已应用。
5. **粘贴静态导出 vs URL 热更新**：见上文。
6. **Base64url 不隐藏源 URL**：recipe 链接只是编码，不是加密或认证；任何持有 provider/覆写链接的人都能解码出源 URL。
7. **分组顺序的语义限制**：按目标分组不是跨目标顺序严格等价的转换；规则重叠时，匹配结果可能因 RULE-SET 顺序而改变。工具会在检测到顺序变化时给出警告，但不能检测所有语义重叠。
8. **缓存不是数据库**：服务按需获取，带有尽力而为的缓存与有限的旧结果回退；不保证多个 provider 同时切换，跨组移动规则可能短暂不一致。
9. **结构校验 ≠ 内核完整验证**：ruhomo 严格校验结构、字段、参数、IP/端口等，但不执行也不验证正则语义，GEO 类规则依赖消费者本地数据。
10. **JS 幂等，YAML 单次前插**：JS 覆写会替换本 recipe 之前生成的条目，可重复应用；YAML 的 `+rules` 不天然幂等，请每次在原始配置上应用一次。两者在“干净原配置上应用一次”时追加意图相同，但不宣称所有情形完全等价。

## 工程结构

```
packages/core/   纯 TypeScript：文档解析、规则解析、分组编译、recipe、命名、YAML/JS 生成器
apps/worker/     Hono + Cloudflare Workers：路由、受限源获取、snapshot 缓存、安全头
apps/web/        React + Vite 前端（中文界面）
tests/integration/  真实 Mihomo v1.19.31 内核集成测试
fixtures/  examples/  docs/  scripts/
```

前端与 Worker 共用同一个 core，不维护两套转换逻辑。

## 开发命令

需要 Node.js ≥ 22.12 与 pnpm（版本见 `package.json` 的 `packageManager`）。

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖（CI 使用 `--frozen-lockfile`） |
| `pnpm dev` | 同时启动 `wrangler dev`（:8787）与 Vite（:5173，代理 `/api`、`/r`）；打开 http://localhost:5173 |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | 全部 TypeScript 项目类型检查 |
| `pnpm test` | core 与 Worker 的单元/HTTP 测试（Node） |
| `pnpm test:workerd` | 在 workerd（Miniflare）中运行的 Worker 冒烟测试 |
| `pnpm test:e2e` | Playwright 前端关键流程（需要本地 Chromium：`pnpm --filter @ruhomo/web exec playwright install chromium`） |
| `pnpm test:e2e:prefix` | Playwright 路径前缀部署流程（`/tools/ruhomo/`） |
| `pnpm test:integration` | 下载并校验固定版本 Mihomo 测试内核，运行真实内核集成测试 |
| `pnpm bench` | 本地基准（Node wall time，不代表 Workers CPU 时间） |
| `pnpm build` | 构建前端并以 `wrangler deploy --dry-run` 打包 Worker |
| `pnpm run deploy` | 构建并部署到你自己的 Cloudflare 账号（需先 `wrangler login`）。注意必须带 `run`：裸 `pnpm deploy` 是 pnpm 的内置命令（部署工作区包），不会执行本脚本 |

## 文档

- [架构](docs/architecture.md)
- [兼容性与已验证范围](docs/compatibility.md)
- [部署](docs/deployment.md)
- [Sub-Store 集成说明](docs/integration.md)
- [安全策略](SECURITY.md) · [贡献指南](CONTRIBUTING.md)

## 许可证

[MIT](LICENSE)。规则解析器是依据 Mihomo 公开文档与行为独立实现的，未复制 Mihomo 源码；Mihomo 本身以其自己的许可证发布。
