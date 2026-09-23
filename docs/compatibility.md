# 兼容性与验证范围

本文说明 ruhomo 的规则解析以哪个 Mihomo 版本为基准、与内核行为有哪些差异，以及哪些部分只做结构校验、无法保证。

## 兼容基准

| 项目 | 值 |
|---|---|
| Mihomo 版本 | **v1.19.31** |
| 标签对应的提交 | `ab405bad5beeeac8b003bb01f60f134f6df54471` |
| 测试内核 | GitHub release 资产 `mihomo-linux-amd64-compatible-v1.19.31.gz`<br>SHA-256 `04cf9f09671704f839ddbee2e93069dc831a4123a75281e725d1d96ab9ac1afc`（与 release 元数据中的 digest 一致，由 `scripts/fetch-mihomo.mjs` 校验） |
| 实测内核输出 | `Mihomo Meta v1.19.31 linux amd64 with go1.26.8` |
| 编译器版本 | `ruhomo-compiler/1`（缓存 key 的一部分） |

实现时参考了以下 v1.19.31 源码中的行为：

| 源文件 | 相关行为 |
|---|---|
| `rules/common/base.go` | 字段切分 |
| `rules/parser.go` | 规则类型表与参数 |
| `rules/logic/logic.go` | 括号配对与子规则 |
| `rules/common/*.go` | 各类型的载荷校验 |
| `common/utils/range.go`、`ranges.go` | 端口、UID、DSCP 范围 |
| `constant/metadata.go` | `IN-TYPE` 取值 |
| `rules/provider/classical_strategy.go`、`provider.go` | classical/text 读取：跳过空行及 `#`、`//` 注释行；错误行只警告并跳过 |
| `component/resource/vehicle.go` | HTTP provider：非 2xx 视为失败并保留旧内容 |

解析器依据上述行为**独立实现**，没有复制或逐行翻译上游代码。

## 字段切分

- 规则按每个逗号切分，每段只去除首尾的 ASCII 空格（与内核的 `strings.Trim(e, " ")` 一致），规则类型转为大写。
- **普通规则**：格式为 `TYPE,payload,target[,params...]`，target 是第三段。输出时去掉 target，其余参数及顺序保持不变。
- **target 位于末尾的规则**：`AND`、`OR`、`NOT`、`DOMAIN-REGEX`、`PROCESS-NAME-REGEX` 和 `PROCESS-PATH-REGEX` 的 target 是**最后一段**，中间所有字段都属于 payload，因此正则量词中的逗号能够原样保留。
- **逻辑子规则**：没有 target，格式为 `TYPE,payload[,params]`。嵌套 IP 规则中的 `no-resolve` / `src` 原样保留。

## 比内核更严格的地方

以下差异均有真实内核探针记录。`tests/integration/mihomo.test.ts` 中的探针将每一行作为独立的 classical provider 交给 v1.19.31 加载，结果写入 `.cache/compat-probe.json`。当前实测结果：

| provider 行 | ruhomo | 内核 ruleCount | 说明 |
|---|---|---|---|
| `IP-CIDR,1.2.3.4/024` | 拒绝 | 0 | 与内核一致：前缀长度含前导零时被拒绝 |
| `IP-CIDR,01.2.3.4/24` | 拒绝 | 0 | 与内核一致：IPv4 地址含前导零时被拒绝 |
| `DST-PORT,70000` | 拒绝 | 1 | 内核按 uint16 截断后静默接受 |
| `DSCP,256` | 拒绝 | 1 | 内核按 uint8 截断后静默接受 |
| `DOMAIN,a.com,extra` | 拒绝 | 1 | 内核静默忽略多余字段 |
| `IP-CIDR,1.1.1.0/24,No-Resolve` | 拒绝 | 1 | 内核参数区分大小写，拼写错误会被静默忽略 |
| `AND,(DOMAIN,a.com),(DST-PORT,443)` | 拒绝 | 1 | 内核接受缺少外层括号的写法；本项目要求整体包裹在一对括号中 |
| `AND,((DOMAIN,a.com)junk(DST-PORT,443))` | 拒绝 | 1 | 内核忽略子规则之间的多余文本 |
| `AND,((DOMAIN,a.com,DIRECT))` | 拒绝 | 1 | 子规则中的「目标」会被内核当作参数并忽略 |
| `AND,()` | 拒绝 | 1 | 空逻辑规则在内核中恒为真 |

以下写法本项目接受，且测试中断言了实测内核同样接受：

- regexp2 语法的正则（原子组、命名组）
- 主机位非零的 `IP-CIDR`、IPv4 映射的 IPv6 地址、`SRC-IP-CIDR`
- `DST-PORT,[1000-2000]`、`DSCP,*`
- 小写的 `IN-TYPE`、`NETWORK,UDP`、`IN-USER` 列表
- `DOMAIN-WILDCARD`、`PROCESS-NAME-WILDCARD`
- `NOT`、嵌套的 `AND` / `OR` / `NOT`，以及逻辑规则中嵌套的含括号正则

## 仅做结构校验的部分

以下行为无法由 ruhomo 保证：

| provider 行 | ruhomo | 内核 ruleCount |
|---|---|---|
| `DOMAIN-REGEX,[` | 接受（warning `REGEX_SEMANTICS_NOT_VALIDATED`） | **0** |
| `DOMAIN-REGEX,(?<=a)b` | 接受（warning） | 1 |

- **正则语义**：本项目不将 JavaScript `RegExp` 用作 Mihomo（regexp2）正则的验证器，也不在服务端执行用户提供的正则。非法正则能够通过转换，但会被内核丢弃。因此所有正则规则都带有 `REGEX_SEMANTICS_NOT_VALIDATED` 警告，请自行确认其正确性。
- **逻辑规则中的正则**：内核按括号配对切分子规则，正则中的括号（包括字符类 `[(]` 和转义的 `\(`）同样参与配对。本项目采用相同的算法切分，并给出 `LOGIC_NESTED_REGEX` 警告；括号不配对时直接报错。
- **GEO 数据**：`GEOSITE`、`GEOIP`、`SRC-GEOIP`、`IP-ASN`、`SRC-IP-ASN` 依赖客户端本地的数据文件（`GEOIP,lan` 除外），带有 `GEODATA_DEPENDENCY` 警告。为避免测试内核下载 geodata，集成测试不覆盖这些类型。
- **平台相关**：`UID` 只能在 Linux / Android 内核上加载（其他平台会报错），带有 `PLATFORM_DEPENDENT` 警告。

> [!IMPORTANT]
> 「转换时结构校验通过」仅表示满足上述结构规则，**不等于**「已由真实 Mihomo 完整验证」。`inspect.json` 中以 `"validation": "structural"` 标明这一点。

## 支持的规则类型

| 类别 | 规则类型 |
|---|---|
| 域名 | `DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`、`DOMAIN-WILDCARD`、`DOMAIN-REGEX`、`GEOSITE` |
| IP | `GEOIP`、`SRC-GEOIP`、`IP-CIDR`、`IP-CIDR6`、`SRC-IP-CIDR`、`IP-SUFFIX`、`SRC-IP-SUFFIX`、`IP-ASN`、`SRC-IP-ASN` |
| 端口 | `SRC-PORT`、`DST-PORT`、`IN-PORT` |
| 进程 | `PROCESS-NAME`、`PROCESS-PATH`、`PROCESS-NAME-REGEX`、`PROCESS-PATH-REGEX`、`PROCESS-NAME-WILDCARD`、`PROCESS-PATH-WILDCARD` |
| 其他 | `NETWORK`、`UID`、`DSCP`、`IN-TYPE`、`IN-USER`、`IN-NAME`、`REMATCH-NAME` |
| 逻辑 | `AND`、`OR`、`NOT` |

未知类型直接报错，不会透传。

**参数**：只有 `GEOIP`、`IP-ASN`、`IP-CIDR`、`IP-CIDR6`、`IP-SUFFIX` 接受 `no-resolve` / `src`（与内核的 `ParseParams` 一致）。`SRC-*` 变体上的这两个参数会被内核忽略，本项目对此给出 `REDUNDANT_PARAM` 警告。其他类型带有额外字段时直接报错。

**禁止使用**：

- 顶层的 `MATCH`、`RULE-SET`、`SUB-RULE`：整个输入转换失败，不会只转换其余规则。
- 逻辑子表达式中的 `MATCH`、`SUB-RULE`：内核同样禁止。
- 逻辑子表达式中的 `RULE-SET`：这是**本项目自身的约束**，内核允许在逻辑规则中引用 `RULE-SET`。

## 出站目标

- 保留原有的大小写与 Unicode 字符，不做规范化；按内核规则去除首尾空格。
- 拒绝以下名称：空名称、包含控制字符（含 U+2028 / U+2029）、超过 128 个字符，以及看起来像参数的 `no-resolve` / `src`。
- 名称仅在大小写上与内置策略不同（如 `direct`）时给出警告，因为内核区分大小写。
- 不会从原配置中补全目标，也不会将未知目标映射为 `DIRECT`。

## 覆写宿主

本项目以用户已确认的兼容性为前提：Sub-Store 支持本文所用的 YAML 覆写和 `function main(config)` 形式的 JS 覆写。

实现时核对了 Sub-Store 的 `processors/index.js`：

- YAML 补丁中，普通映射键递归合并，`+key` 在列表前插入，`key+` 在列表后追加。
- 脚本内容会先尝试按 YAML 解析：如果解析结果是对象，则作为补丁处理；否则作为 JS 执行。生成的 JS 首行是 `//` 注释，不会构成 YAML 映射（有单元测试覆盖）。

> [!NOTE]
> 测试中的宿主模型是依据文档自行编写的，并非 Sub-Store 代码的拷贝，也**没有**在真实的 Sub-Store 上运行过。

## 公开文档与固定版本的差异

实现过程中未发现 Mihomo wiki 与 v1.19.31 源码在上述行为上存在冲突。如有差异，以固定版本的源码和真实内核测试结果为准。
