# Sub-Store 集成说明

ruhomo 只处理**额外规则**：按出站目标生成 provider，再把对应的 `RULE-SET` 加到原配置的规则列表前面。原配置中的节点、代理组和已有规则不会被替换。

| 输入方式 | 得到的覆写 | 规则变化后 |
|---|---|---|
| 公开 HTTPS raw URL | 远程覆写 + HTTP provider | 已有目标的规则由 Mihomo 按 `interval` 更新 |
| 直接粘贴 | 浏览器本地生成的静态覆写 | 重新导出、应用并加载配置 |

## 1. 准备规则

文件只放额外规则，不要放完整 Mihomo 配置、节点或代理组。例如（域名和目标均为虚构示例）：

```yaml
rules:
  - DOMAIN-SUFFIX,direct.example,DIRECT
  - DOMAIN-SUFFIX,proxy-one.example,示例代理
  - DOMAIN-KEYWORD,demo-keyword,默认代理
```

也支持 YAML 字符串列表、一行一条的纯文本（见 [`examples/`](../examples/)）。不支持顶层 `MATCH`、`RULE-SET` 或 `SUB-RULE`。要**明确清空**规则，请用 YAML 的 `rules: []` 或文本中的单独一行 `# mrp:empty`；空文件和只有注释的文件会报错，避免误清空。

使用 URL 模式时，将文件发布为公开的 HTTPS raw URL；默认允许 GitHub / Gist raw 地址。**不要把凭据放在 URL 中**：生成的覆写链接可以解码出源地址。

## 2. 生成并应用覆写

在 ruhomo 页面选「Raw URL」或「直接粘贴」，转换后检查目标、规则数量和诊断，再把 **YAML 或 JS 覆写**添加到 Sub-Store 中的 Mihomo 配置。原配置必须已有所引用的出站目标（可参考 [`examples/base-config.yaml`](../examples/base-config.yaml)）；ruhomo 不会创建代理组。

- **JS（推荐）**：可重复应用。同一份规则再次应用时，会替换该 recipe 上次生成的 provider 与 `RULE-SET`，不改动原始规则或其他 recipe。
- **YAML**：合并 `rule-providers`，用 `+rules` 在原 `rules` 前插入生成的 `RULE-SET`。请每次从**原始配置**应用一次；对已覆写的结果重复应用可能产生重复规则。

生成的每个目标对应一个 HTTP classical provider。provider 的 `proxy` 字段若存在，表示下载时使用的代理，**不是**规则匹配的出站目标；本项目不会设置它。URL 模式还提供 `inspect.json` 查看诊断，provider 链接已包含在覆写中，无需手动填写。

## 3. 更新规则

| 变更 | 操作 |
|---|---|
| URL 模式：修改已有目标的规则 | 无需改覆写；Mihomo 按 provider `interval` 更新，也可在客户端手动更新 |
| URL 模式：删光某目标下的规则 | provider 返回空集合，该目标的规则数归零 |
| URL 模式：新增目标、目标改名或修改格式、更新间隔、目标顺序 | 重新获取覆写；recipe 变化时替换旧链接，然后重新生成并让 Mihomo 加载主配置 |
| 粘贴模式：任何规则变化 | 重新导出、应用覆写，并让 Mihomo 加载新配置 |

Sub-Store 重新生成文件不等于正在运行的 Mihomo 已加载配置。多个 provider 分别下载，规则从一个目标移到另一个目标时可能短暂不同步；源获取失败或内容非法时，服务返回错误（或在容错窗口内使用旧结果），不会将失败当成空规则。

粘贴模式的覆写使用 `type: inline` provider，不会热更新。所有静态导出共用一个命名空间，后应用的静态 JS 覆写会替换之前的静态条目。
