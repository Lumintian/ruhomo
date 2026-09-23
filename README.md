# ruhomo

ruhomo 将单独维护的 **Mihomo 额外规则**按出站目标分组，生成 HTTP `rule-provider` 以及可在 Sub-Store 中使用的 YAML / JS 覆写。整个过程无需提供节点、订阅或完整配置。

> **English:** Convert extra Mihomo rules into per-target rule-providers and Sub-Store overrides, without uploading your full config.

## 快速开始

1. **准备规则文件**：文件中只包含额外规则（参见[示例](examples/extra-rules.yaml)），并发布为公开的 HTTPS raw URL。默认支持 GitHub 与 Gist 的 raw 地址。
2. **转换并预览**：打开已部署的 ruhomo 页面，选择「Raw URL」，粘贴地址后点击「转换 / 预览」，核对出站目标、规则数量和诊断信息。
3. **应用覆写**：复制生成的 **YAML 或 JS 远程覆写链接**，在 Sub-Store 中将其应用到原配置。所引用的出站目标必须已存在于原配置中。

没有可用的 raw URL 时，可以选择「直接粘贴」。此模式下规则仅在浏览器本地转换，但导出的是**静态覆写**，规则变化后需要重新导出并应用。两种模式的配置与更新方法详见 [Sub-Store 集成说明](docs/integration.md)。

## 作用范围

覆写只做两件事：添加 `rule-providers`，并将对应的 `RULE-SET` 插入到原 `rules` 之前。原有规则的内容和相对顺序保持不变。

ruhomo 不读取完整配置，不管理节点、代理组、DNS 或 Mihomo Controller，也不会刷新正在运行的客户端。

使用前请注意：

- **目标变更需重新加载**：新增或重命名出站目标后，需要重新应用覆写并让 Mihomo 重新加载配置；已有目标下的规则变化则由 Mihomo 定期下载对应的 provider 完成更新。
- **匹配结果可能变化**：按目标分组可能改变相互重叠的规则的匹配结果。转换仅检查规则结构，不保证正则语义正确，也不保证本地 GEO 数据有效。请核对预览和实际匹配结果。
- **链接可还原源地址**：从生成的链接可以解码出源 URL。请勿在源地址中包含凭据，也不要公开包含真实源地址的链接、截图或日志。仓库中的示例均为虚构规则，请勿提交个人规则。

## 自行部署

推荐**通过 GitHub Actions 按版本标签部署**：维护者推送版本标签后，由云端完成检查、构建和发布。Cloudflare 凭据与部署设置见[部署指南](docs/deployment.md)，版本与标签的创建方法见[开发指南](docs/development.md#发布新版本)。

也可以从本地手动部署，但这会绕过标签发布流程。需要准备 Cloudflare 账号、Node.js ≥ 22.12，以及 `package.json` 所指定版本的 pnpm，然后在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @ruhomo/worker exec wrangler login
pnpm run deploy
```

> [!WARNING]
> `pnpm run deploy` 会**实际部署**网页与 API。如果只想在本地检查构建，请运行 `pnpm build`。

自定义域名、路径前缀及免费版限制见[部署指南](docs/deployment.md)。

## 文档

| 类别 | 文档 |
|---|---|
| 使用 | [Sub-Store 集成说明](docs/integration.md) · [兼容性与验证范围](docs/compatibility.md) |
| 运维 | [部署指南](docs/deployment.md) · [安全策略](SECURITY.md) |
| 开发 | [开发指南](docs/development.md) · [架构](docs/architecture.md) · [贡献指南](CONTRIBUTING.md) |

## 许可证

[MIT](LICENSE)
