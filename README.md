# ruhomo

把单独维护的 **Mihomo 额外规则**按出站目标分组，生成 HTTP `rule-provider` 和 Sub-Store 可用的 YAML / JS 覆写。无需提供节点、订阅或完整配置。

> **English:** Convert extra Mihomo rules into per-target rule-providers and Sub-Store overrides, without uploading your full config.

## 开始使用

1. 准备一个只包含额外规则的文件（[示例](examples/extra-rules.yaml)），发布为公开的 HTTPS raw URL。默认支持 GitHub / Gist 的 raw 地址。
2. 打开已部署的 ruhomo 页面，选择「Raw URL」，粘贴地址并点击「转换 / 预览」。确认出站目标、规则数量和诊断结果。
3. 复制生成的 **YAML 或 JS 远程覆写链接**，在 Sub-Store 中应用于原配置。原配置中必须已有这些出站目标。

没有 raw URL？选择「直接粘贴」。规则只在浏览器本地转换，但导出的是**静态覆写**；规则变化后需重新导出并应用。两种方式的配置与更新方法见 [Sub-Store 集成说明](docs/integration.md)。

## 它会改什么

覆写只添加 `rule-providers`，并把对应的 `RULE-SET` 放到原 `rules` 前面；原有规则的内容和相对顺序不变。ruhomo 不读取完整配置，也不管理节点、代理组、DNS 或 Mihomo Controller，更不会替你刷新正在运行的客户端。

使用前请注意：

- 新增或改名出站目标后，需要重新应用覆写，并让 Mihomo 重新加载配置。已有目标的规则更新则由 Mihomo 定期下载对应 provider。
- 按目标分组可能改变重叠规则的匹配结果；转换只检查规则结构，不保证正则语义或本地 GEO 数据有效。请检查预览和实际匹配结果。
- **生成的链接可解码出源 URL**。不要把凭据写进源地址，也不要公开包含真实源地址的链接、截图或日志。示例使用虚构规则，请勿将个人规则提交到仓库。

## 自行部署

可选择 **Cloudflare Workers Builds 云端构建**（连接 Git 仓库后自动部署），或在本地构建并部署。以下是本地方式：准备 Cloudflare 账号、Node.js ≥ 22.12 和 `package.json` 指定版本的 pnpm，然后在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm --filter @ruhomo/worker exec wrangler login
pnpm run deploy
```

`pnpm run deploy` **会实际部署**网页与 API；只想本地检查构建请运行 `pnpm build`。云端构建所需的 Build / Deploy 命令、自定义域名和免费版限制见 [部署指南](docs/deployment.md)。

## 文档

- 使用：[Sub-Store 集成说明](docs/integration.md) · [兼容性与已验证范围](docs/compatibility.md)
- 运行：[部署指南](docs/deployment.md) · [安全与隐私](SECURITY.md)
- 参与：[开发指南](docs/development.md) · [架构](docs/architecture.md) · [贡献指南](CONTRIBUTING.md)

[MIT 许可证](LICENSE)。
