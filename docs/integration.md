# Sub-Store 集成说明

## 1. 准备额外规则文件

在你能提供 HTTPS raw 链接的位置（默认允许 `raw.githubusercontent.com`、`gist.githubusercontent.com`）维护一个文件，例如 [`examples/extra-rules.yaml`](../examples/extra-rules.yaml)：

```yaml
rules:
  - DOMAIN-SUFFIX,direct.example,DIRECT
  - DOMAIN-SUFFIX,proxy-one.example,示例代理
  - DOMAIN-KEYWORD,demo-keyword,默认代理
```

也可以用一行一条的纯文本（[`examples/extra-rules.txt`](../examples/extra-rules.txt)）。文件里只放额外规则；不要放节点、`proxy-groups`、DNS 或 `MATCH`/`RULE-SET`/`SUB-RULE`。

## 2. 生成链接

在 ruhomo 页面选择 “Raw URL”，粘贴链接，转换后得到：

- `.../r/v1/{R}/override.yaml` —— YAML 覆写
- `.../r/v1/{R}/override.js` —— JavaScript 覆写（`function main(config)`）
- 每个出站目标一个 `.../r/v1/{R}/providers/{T}.list`（覆写里已经引用，一般不需要手动使用）
- `.../r/v1/{R}/inspect.json` —— 诊断信息

## 3. 在 Sub-Store 中使用

对你的 Mihomo 配置文件添加一个覆写/脚本操作，内容填远程链接（或粘贴下载下来的文件内容）。二选一：

- **JS（推荐）**：可重复应用；会替换本 recipe 之前生成的 provider 与 RULE-SET 条目，不碰其它 recipe、其它 provider、原始规则。
- **YAML**：`+rules` 不天然幂等，请确保每次都是在原始配置上应用一次。

以 [`examples/base-config.yaml`](../examples/base-config.yaml) 为原配置，应用后的结果示意：

```yaml
rule-providers:
  mrp-<recipeId>-<targetId>:        # 每个目标一个
    type: http
    behavior: classical
    format: text
    url: https://<你的部署>/r/v1/<R>/providers/<T>.list
    path: ./rule-providers/mrp-<recipeId>-<targetId>.list
    interval: 3600
rules:
  - RULE-SET,mrp-<recipeId>-<DIRECT 的 id>,DIRECT
  - RULE-SET,mrp-<recipeId>-<示例代理 的 id>,示例代理
  - RULE-SET,mrp-<recipeId>-<默认代理 的 id>,默认代理
  - GEOIP,CN,DIRECT          # 原有规则保持原样和相对顺序
  - MATCH,默认代理
```

生成的 provider 不带 `proxy` 字段：那个字段表示“通过哪个代理下载规则文件”，不是匹配后的出站目标。

## 4. 之后怎么更新

| 你做了什么 | 需要做什么 |
|---|---|
| 修改、增加、删除**已有目标**下的规则 | 什么都不用做：Mihomo 按 `interval` 重新下载对应 provider（也可在客户端手动更新 provider） |
| 某个目标的规则全部删掉 | 同上；该 provider 会返回合法空集合 `# empty`，Mihomo 中其规则数归零 |
| **新增目标**、目标改名 | 覆写内容会变化：需要让 Sub-Store 重新获取覆写、重新生成并让 Mihomo 重新加载主配置 |
| 修改 recipe（格式、interval、目标顺序） | 会得到新的 recipe 链接，需要替换旧覆写 |

注意：

- 只在 Sub-Store 中重新生成文件，不等于正在运行的 Mihomo 已经加载新配置。
- 多个 provider 各自下载，不保证同时切换；把规则从一个目标移到另一个目标时可能有短暂不一致。
- 源获取失败或源内容非法时，服务返回非 2xx（或在容错窗口内返回标记为 stale 的旧结果），Mihomo 会保留上次成功的内容，不会被清空。

## 5. 粘贴模式

没有 raw URL 时可用“直接粘贴”：规则在浏览器本地转换，导出的覆写使用 `type: inline` 的 classical provider，规则直接写在覆写里。这是**静态导出**：修改规则后需要重新生成并重新应用覆写；需要热更新请改用 raw URL。所有静态导出共用一个命名空间，后应用的静态 JS 覆写会替换之前的静态条目。
