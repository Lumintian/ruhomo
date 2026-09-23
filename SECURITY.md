# 安全策略

## 报告漏洞

请不要在公开 issue 中披露漏洞细节。通过 GitHub 的 “Report a vulnerability”（私密安全通告）联系维护者，并附上影响范围与复现条件。

## 信任边界

- **不是通用 URL 代理**：只获取 HTTPS、主机在部署者 allowlist 中的源；每次重定向都重新校验协议、主机与限制；拒绝 URL userinfo、非默认端口、fragment、IP 字面量（含私有/回环/链路本地/元数据地址）、`localhost`、内部域名以及本服务自身主机。不透传浏览器 Cookie、Authorization 或任意请求头；第一版不支持需要凭据的私有源。
- **DNS rebinding**：校验基于主机名，不能仅靠 URL 规则完全防止 DNS rebinding。安全性依赖 allowlist 中的主机本身可信；在 Cloudflare Workers 上，出站 `fetch` 由平台发往公网，无法访问部署者的内网。若移植到其它运行时，请在网络层额外限制出站地址。
- **资源限制**：总超时、重定向次数、解压后字节数（流式计数）、规则数、目标数、单条规则长度、逻辑嵌套深度、recipe 与 URL 长度均有上限，且在解析前检查。它们是防滥用上限，不是性能保证。
- **限流**：isolate 内计数不是全局限流；请使用 Cloudflare WAF 规则或 Workers Rate Limiting binding（见 docs/deployment.md）。

## 隐私

- Worker 不记录源正文、完整源 URL、recipe token、规则或认证数据；错误日志只含错误码与截断摘要。响应不包含栈信息、环境变量或密钥。
- 默认无第三方分析、字体、脚本或埋点；前端以文本方式渲染所有用户内容，不使用 `innerHTML`，并通过 CSP、`nosniff`、`Referrer-Policy: no-referrer` 加固。
- **Base64url 可逆**：recipe token 不是加密也不是认证，任何持有 provider/覆写链接的人都能解码出源 URL。不要把含秘密的地址当作源。
- 本工具不需要完整配置，但服务部署者仍能接触到被提交转换的额外规则。粘贴模式只在浏览器本地处理。
- 本项目无法保证 Cloudflare、反向代理或其它中间层不记录访问 URL；请据此设置日志与访问策略。
