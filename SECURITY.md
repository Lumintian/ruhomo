# 安全策略

## 报告漏洞

请勿在公开 issue 中披露漏洞细节。请通过 GitHub 的「Report a vulnerability」（私密安全通告）联系维护者，并说明影响范围与复现条件。

## 信任边界

- **不是通用 URL 代理**：服务只获取使用 HTTPS 且主机位于部署者 allowlist 中的源，每次重定向都会重新校验协议、主机和各项限制。以下情况一律拒绝：URL 中包含 userinfo、非默认端口或 fragment；主机为 IP 字面量（包括私有、回环、链路本地和元数据地址）、`localhost`、内部域名或本服务自身。服务不会透传浏览器 Cookie、`Authorization` 或任何自定义请求头。第一版不支持需要凭据的私有源。
- **DNS rebinding**：校验基于主机名，仅靠 URL 规则无法完全防御 DNS rebinding，因此安全性依赖于 allowlist 中的主机本身可信。在 Cloudflare Workers 上，出站 `fetch` 由平台发往公网，无法访问部署者的内网；如果移植到其他运行时，请在网络层额外限制出站地址。
- **资源限制**：总超时、重定向次数、解压后字节数（流式计数）、规则数、目标数、单条规则长度、逻辑嵌套深度，以及 recipe 与 URL 的长度均设有上限，并在解析前检查。这些上限用于防止滥用，而非性能保证。
- **限流**：isolate 内的计数不构成全局限流。请使用 Cloudflare WAF 规则或 Workers Rate Limiting binding，详见[部署指南](docs/deployment.md#6-限流与隐私)。

## 隐私

- **日志**：Worker 不记录源正文、完整源 URL、recipe token、规则或认证数据，错误日志只包含错误码和截断后的摘要。响应中不含栈信息、环境变量或密钥。
- **前端**：默认不加载任何第三方分析、字体、脚本或埋点。所有用户内容均以纯文本渲染，不使用 `innerHTML`，并通过 CSP、`nosniff` 和 `Referrer-Policy: no-referrer` 加固。
- **Base64url 可逆**：recipe token 既不是加密，也不是认证。任何持有 provider 或覆写链接的人都能从中解码出源 URL，因此请勿将包含机密信息的地址用作源。
- **部署者可见性**：本工具不需要完整配置，但服务部署者仍能看到提交转换的额外规则。粘贴模式仅在浏览器本地处理，不会上传规则。
- **中间层**：本项目无法保证 Cloudflare、反向代理或其他中间层不记录访问 URL，请据此配置日志与访问策略。
