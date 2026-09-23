# 兼容性与已验证范围

## 兼容基准

| 项 | 值 |
|---|---|
| Mihomo 版本 | **v1.19.31** |
| tag commit | `ab405bad5beeeac8b003bb01f60f134f6df54471` |
| 测试内核 | GitHub release 资产 `mihomo-linux-amd64-compatible-v1.19.31.gz`，SHA-256 `04cf9f09671704f839ddbee2e93069dc831a4123a75281e725d1d96ab9ac1afc`（与 release 元数据中的 digest 一致，由 `scripts/fetch-mihomo.mjs` 校验） |
| 实测内核输出 | `Mihomo Meta v1.19.31 linux amd64 with go1.26.8` |
| 编译器版本 | `ruhomo-compiler/1`（缓存 key 的一部分） |

实施时阅读的源码（均为 v1.19.31）：`rules/common/base.go`（字段切分）、`rules/parser.go`（类型表与参数）、`rules/logic/logic.go`（括号配对与子规则）、`rules/common/*.go`（各类型载荷校验）、`common/utils/range.go`/`ranges.go`（端口/UID/DSCP 范围）、`constant/metadata.go`（`IN-TYPE` 取值）、`rules/provider/classical_strategy.go` 与 `provider.go`（classical/text 读取：跳过空行、`#` 与 `//` 注释行，坏行只警告并跳过）、`component/resource/vehicle.go`（HTTP provider：非 2xx 视为失败并保留旧内容）。

解析器是根据上述行为**独立实现**的，没有复制或逐行翻译上游代码。

## 字段切分

- 规则按每个逗号切分，每段只去掉首尾 ASCII 空格（与内核 `strings.Trim(e, " ")` 一致），类型转大写。
- 普通规则：`TYPE,payload,target[,params...]`，target 是第三段；输出去掉 target，保留其余参数与顺序。
- `AND`/`OR`/`NOT`/`DOMAIN-REGEX`/`PROCESS-NAME-REGEX`/`PROCESS-PATH-REGEX`：target 是**最后一段**，其间全部是 payload（因此正则量词里的逗号保真）。
- 逻辑子规则没有 target：`TYPE,payload[,params]`。嵌套 IP 规则的 `no-resolve`/`src` 原样保留。

## 本项目比内核更严格的地方（均有真实内核探针记录）

`tests/integration/mihomo.test.ts` 中的探针把每行作为独立 classical provider 交给 v1.19.31 加载，结果写入 `.cache/compat-probe.json`。当前实测：

| provider 行 | ruhomo | 内核 ruleCount | 说明 |
|---|---|---|---|
| `IP-CIDR,1.2.3.4/024` | 拒绝 | 0 | 一致：前缀长度前导零被内核拒绝 |
| `IP-CIDR,01.2.3.4/24` | 拒绝 | 0 | 一致：IPv4 前导零被内核拒绝 |
| `DST-PORT,70000` | 拒绝 | 1 | 内核按 uint16 截断后静默接受 |
| `DSCP,256` | 拒绝 | 1 | 内核按 uint8 截断后静默接受 |
| `DOMAIN,a.com,extra` | 拒绝 | 1 | 内核静默忽略多余字段 |
| `IP-CIDR,1.1.1.0/24,No-Resolve` | 拒绝 | 1 | 内核参数区分大小写，拼错会被静默忽略 |
| `AND,(DOMAIN,a.com),(DST-PORT,443)` | 拒绝 | 1 | 内核接受缺外层括号的写法；本项目要求整体一对括号 |
| `AND,((DOMAIN,a.com)junk(DST-PORT,443))` | 拒绝 | 1 | 内核忽略子规则之间的多余文本 |
| `AND,((DOMAIN,a.com,DIRECT))` | 拒绝 | 1 | 子规则中的“目标”会被内核当作被忽略的参数 |
| `AND,()` | 拒绝 | 1 | 空逻辑规则在内核中恒为真 |

以下由本项目接受且实测内核也接受（断言）：regexp2 语法的正则（原子组、命名组）、`IP-CIDR` 主机位非零、IPv4 映射 IPv6、`SRC-IP-CIDR`、`DST-PORT,[1000-2000]`、`DSCP,*`、小写 `IN-TYPE`、`NETWORK,UDP`、`DOMAIN-WILDCARD`、`PROCESS-NAME-WILDCARD`、`IN-USER` 列表、`NOT`、嵌套 `AND/OR/NOT`、逻辑中嵌套含括号的正则。

## 只做结构校验、无法保证的部分

| provider 行 | ruhomo | 内核 ruleCount |
|---|---|---|
| `DOMAIN-REGEX,[` | 接受（warning `REGEX_SEMANTICS_NOT_VALIDATED`） | **0** |
| `DOMAIN-REGEX,(?<=a)b` | 接受（warning） | 1 |

- 本项目不把 JavaScript `RegExp` 当作 Mihomo（regexp2）正则验证器，也不在服务端执行用户正则。非法正则会通过转换，但会被内核丢弃——所有正则规则都会带 `REGEX_SEMANTICS_NOT_VALIDATED` 警告，请据此自行确认。
- 逻辑规则内的正则：内核按括号配对切分子规则，正则中的括号（含字符类 `[(]` 与转义 `\(`）也参与配对。本项目使用相同算法切分并给出 `LOGIC_NESTED_REGEX` 警告；括号不配对时直接报错。
- `GEOSITE`/`GEOIP`/`SRC-GEOIP`/`IP-ASN`/`SRC-IP-ASN` 依赖消费者本地数据（`GEOIP,lan` 除外），带 `GEODATA_DEPENDENCY` 警告；集成测试不覆盖它们，以免测试内核下载 geodata。
- `UID` 仅 Linux/Android 内核可加载（其它平台内核会报错），带 `PLATFORM_DEPENDENT` 警告。

“转换结构校验通过”只表示满足上述结构规则，**不等于**“已由真实 Mihomo 完整验证”。inspect.json 中以 `"validation": "structural"` 表示。

## 支持的规则类型

`DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `DOMAIN-WILDCARD`, `DOMAIN-REGEX`, `GEOSITE`, `GEOIP`, `SRC-GEOIP`, `IP-CIDR`, `IP-CIDR6`, `SRC-IP-CIDR`, `IP-SUFFIX`, `SRC-IP-SUFFIX`, `IP-ASN`, `SRC-IP-ASN`, `SRC-PORT`, `DST-PORT`, `IN-PORT`, `PROCESS-NAME`, `PROCESS-PATH`, `PROCESS-NAME-REGEX`, `PROCESS-PATH-REGEX`, `PROCESS-NAME-WILDCARD`, `PROCESS-PATH-WILDCARD`, `NETWORK`, `UID`, `DSCP`, `IN-TYPE`, `IN-USER`, `IN-NAME`, `REMATCH-NAME`, `AND`, `OR`, `NOT`。

未知类型直接报错，不透传。

参数：仅 `GEOIP`、`IP-ASN`、`IP-CIDR`、`IP-CIDR6`、`IP-SUFFIX` 接受 `no-resolve`/`src`（与内核 `ParseParams` 一致）；`SRC-*` 变体上的这两个参数被内核忽略，本项目给出 `REDUNDANT_PARAM` 警告；其它类型带额外字段即报错。

禁止：顶层 `MATCH`、`RULE-SET`、`SUB-RULE`（整个输入失败，不生成 residual）；逻辑子表达式中的 `MATCH`/`SUB-RULE`（内核同样禁止）以及 `RULE-SET`（**本项目自己的约束**，内核允许在逻辑中引用 RULE-SET）。

## 出站目标

保留大小写与 Unicode，不做 normalization；按内核规则去掉首尾空格；拒绝空名、控制字符（含 U+2028/2029）、超过 128 个字符的名称，以及看起来是参数的 `no-resolve`/`src`。仅大小写不同于内置策略（如 `direct`）时给出警告，因为内核区分大小写。不会从原配置补齐或把未知目标映射到 DIRECT。

## 覆写宿主

以用户已确认的兼容性为前提：Sub-Store 支持本文采用的 YAML 覆写与 `function main(config)` JS 覆写。实现时核对了 Sub-Store `processors/index.js`：YAML 补丁中普通映射键递归合并、`+key` 前插列表、`key+` 追加列表；脚本内容会被当作 YAML 尝试解析，是对象则按补丁处理，否则作为 JS 执行——生成的 JS 首行是 `//` 注释且不构成 YAML 映射（有单元测试）。测试中的宿主模型是按文档自行编写的，不是 Sub-Store 代码的拷贝，也**没有**在真实 Sub-Store 上运行过。

## 公开文档与固定版本的差异

实施时未发现 wiki 与 v1.19.31 源码在上述行为上的冲突；如有差异，以固定版本源码与真实内核测试为准。
