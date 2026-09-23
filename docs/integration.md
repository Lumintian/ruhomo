# Sub-Store 集成说明

ruhomo 只处理**额外规则**：为每个出站目标生成一个 provider，并将对应的 `RULE-SET` 插入到原配置规则列表的最前面。原配置中的节点、代理组和已有规则都不会被替换。

根据输入方式不同，生成的覆写和后续更新方式也不同：

| 输入方式 | 生成的覆写 | 规则变化后 |
|---|---|---|
| 公开 HTTPS raw URL | 远程覆写 + HTTP provider | 已有目标的规则由 Mihomo 按 `interval` 自动更新 |
| 直接粘贴 | 浏览器本地生成的静态覆写 | 需要重新导出、应用并加载配置 |

## 1. 准备规则

规则文件只包含额外规则，不要放入完整的 Mihomo 配置、节点或代理组。示例（域名和目标均为虚构）：

```yaml
rules:
  - DOMAIN-SUFFIX,direct.example,DIRECT
  - DOMAIN-SUFFIX,proxy-one.example,示例代理
  - DOMAIN-KEYWORD,demo-keyword,默认代理
```

支持的格式还包括 YAML 字符串列表和每行一条规则的纯文本（参见 [`examples/`](../examples/)）。不支持顶层的 `MATCH`、`RULE-SET` 或 `SUB-RULE`。

如需**明确清空**规则，请在 YAML 中写 `rules: []`，或在纯文本中只保留一行 `# mrp:empty`。空文件和只含注释的文件会被视为错误，以免意外清空规则。

使用 URL 模式时，需要将文件发布为公开的 HTTPS raw URL，默认允许 GitHub 与 Gist 的 raw 地址。

> [!WARNING]
> **请勿在 URL 中包含凭据**：从生成的覆写链接可以解码出源地址。

## 2. 生成并应用覆写

在 ruhomo 页面选择「Raw URL」或「直接粘贴」，完成转换后检查目标、规则数量和诊断信息，然后将 **YAML 或 JS 覆写**添加到 Sub-Store 中的 Mihomo 配置。

原配置中必须已有覆写所引用的出站目标（可参考 [`examples/base-config.yaml`](../examples/base-config.yaml)），ruhomo 不会创建代理组。

两种覆写格式的区别：

- **JS（推荐）**：可以重复应用。再次应用同一份规则时，会替换该 recipe 上次生成的 provider 和 `RULE-SET`，不影响原始规则或其他 recipe。
- **YAML**：合并 `rule-providers`，并通过 `+rules` 将生成的 `RULE-SET` 插入到原 `rules` 之前。每次都应基于**原始配置**应用一次；对已覆写过的结果重复应用可能产生重复规则。

每个目标对应一个 HTTP classical provider，provider 链接已包含在覆写中，无需手动填写。注意：provider 的 `proxy` 字段（如果存在）表示下载 provider 时使用的代理，**而不是**规则匹配后的出站目标；本项目不会设置该字段。URL 模式还提供 `inspect.json`，可用于查看诊断信息。

## 3. 更新规则

| 变更 | 操作 |
|---|---|
| URL 模式：修改已有目标下的规则 | 无需修改覆写。Mihomo 会按 provider 的 `interval` 自动更新，也可在客户端手动更新 |
| URL 模式：删除某目标下的全部规则 | 无需操作。provider 返回空集合，该目标的规则数归零 |
| URL 模式：新增目标、重命名目标，或修改格式、更新间隔、目标顺序 | 重新获取覆写。如果 recipe 发生变化，用新链接替换旧链接，然后重新生成配置并让 Mihomo 加载 |
| 粘贴模式：任何规则变化 | 重新导出并应用覆写，然后让 Mihomo 加载新配置 |

更新时请注意：

- **重新生成不等于已加载**：Sub-Store 重新生成配置文件后，正在运行的 Mihomo 并不会自动加载它。
- **短暂不同步**：各个 provider 独立下载。规则从一个目标移到另一个目标时，两者可能短暂不同步。
- **失败不会变成空规则**：源获取失败或内容非法时，服务会返回错误（或在容错窗口内返回旧结果），不会把失败当作空规则集。
- **粘贴模式不热更新**：粘贴模式的覆写使用 `type: inline` provider。所有静态导出共用同一个命名空间，后应用的静态 JS 覆写会替换之前的静态条目。
