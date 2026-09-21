# MCP 官方 SDK 可行性探针

> 状态：施工准备证据（2026-09-21）。用于 Issue #36 选型，不代表 Forge MCP 功能已经实现或验收。

## 环境与依赖

- Linux `6.18.33.2-microsoft-standard-WSL2`、x86_64，Bun `1.3.12`。
- npm published artifacts：`@modelcontextprotocol/client`、`server`、`core` 均锁定 `2.0.0`；`zod` 锁定 `4.6.5`。实际代码来自 registry 安装产物，不以 GitHub `main` 文档代替版本证据。
- 所有依赖安装与执行均在独立临时目录，不修改项目依赖。目录内 `package.json` 与 `bun.lock` 只用于复现探针。

## 复现

从仓库根目录执行；需要 registry 网络访问：

```sh
probe_dir=$(mktemp -d /tmp/forge-mcp-probe.XXXXXX)
cp docs/research/mcp-client/{package.json,bun.lock,fixture.ts,probe.ts,contracts.ts} "$probe_dir/"
(cd "$probe_dir" && bun install --frozen-lockfile && bun probe.ts && bun contracts.ts)
rm -r "$probe_dir"
```

`fixture.ts` 是官方 `McpServer` fixture，`probe.ts` 使用真实本地子进程与 loopback HTTP，`contracts.ts` 使用官方 `InMemoryTransport` 检查库级合同。原始输出见 [传输结果](results.json) 与 [合同结果](contracts-results.json)。`childExited: null` 表示 HTTP 无子进程检查。

## 已验证

1. stdio 与 Streamable HTTP，各运行 `legacy`、`auto`、`{ pin: '2026-07-28' }`：六个组合全部通过工具发现与调用、`structuredContent`、Resources 列表与读取、Resource templates 列表/读取/参数补全、Prompts 列表与获取。
2. 六个组合中发送取消信号后，工具调用均在约 50 ms 量级拒绝。此处断言的是调用方 Promise 停止等待，不是远程业务操作一定停止。
3. 三个 stdio 组合调用 `close()` 后，直接子进程 PID 均不存在。没有验证后代进程树或拒绝响应信号的进程。
4. `listTools()` 无 cursor 时自动聚合两页；显式 cursor 返回一页；`listChanged.tools.onChanged` 获取重新聚合后的两项工具。
5. 故意返回不符合 `outputSchema` 的 `structuredContent`，官方 client 抛出 `ProtocolError`。这是失败注入，不只验证成功样例。
6. 官方 `AjvJsonSchemaValidator` 在未声明 dialect、draft-07、2019-09、2020-12 下，选定的本地 `$ref` + `oneOf` 样例正向接受、反向拒绝。
7. 官方 `UriTemplate` 可处理路径参数编码和查询参数扩展。

## 影响设计的已发布 API 约束

以下来源均为锁定包中 `dist` 的类型与源码，行号只对应本次 `2.0.0` artifact。

| 事项 | 已核实行为与设计含义 |
|---|---|
| URI 模板 | `@modelcontextprotocol/client` 根导出 `UriTemplate`，包含 `variableNames`、`expand`、`match`；无需自写 RFC 6570 解析器 |
| JSON Schema | `@modelcontextprotocol/client/validators/ajv` 导出 `AjvJsonSchemaValidator`、`Ajv`、`addFormats`；默认 provider 按 `$schema` 选 dialect，未知 dialect 抛错，传入自定义 Ajv 后 dialect 选择归调用方负责。无需额外直接依赖 Ajv |
| 分页 | `ClientOptions.listMaxPages` 默认 64；无 cursor 聚合路径写缓存，显式 cursor 路径只返回单页且不写缓存。`listResources`、`listResourceTemplates`、`listPrompts` 的 types 也定义同样聚合合同；本次分页运行测试只覆盖 Tools |
| output schema 与目录快照 | `CallToolRequestOptions.toolDefinition` 同时决定 output validation 与新版 `Mcp-Param-*` header mirroring，不读取最新目录缓存。Forge 应把已提交目录中的 `Tool` 快照传入，而非重写 SDK 校验。来源：client `dist/index.d.mts:1807` |
| 调用中的目录变化 | 默认 `callTool` 在发送前取得 validator；一般目录刷新不会改变本次结果验证。源码 `dist/index.mjs:4119`。但无 `toolDefinition` 时 header mismatch 会刷新目录并重试一次；显式 `toolDefinition` 禁止该刷新/重试路径，源码 `:4135`。此项为源码核查，尚无并发运行探针 |
| 新旧协议 | `versionNegotiation` 默认 `legacy`；stdio `auto` 在临时 sibling process 探测，额外启动一次，不宜默认自动探测所有本地 server。本次 v2 fixture 同时支持两个时代，不代表真实旧版 server 兼容验收 |
| 进程释放 | SDK stdio `close()` 先关 stdin，等最多 2 秒，再 SIGTERM 等最多 2 秒，然后 SIGKILL；最后 SIGKILL 后未等待 exit。是直接子进程，不是整棵进程树保证。源码 client `dist/stdio.mjs:175` |
| 取消上下文 | v2 server handler 的信号是 `ctx.mcpReq.signal`，不是旧式平铺 `ctx.signal` |

## 未验证与边界

- 尚未进行 Forge 接线、真实模型续轮、真实第三方本地/远程 server、OAuth、凭据存储、Elicitation、旧 HTTP+SSE、资源订阅、远程断线恢复、跨平台和 UI 验收。
- 本次 HTTP 是 loopback 的真实 HTTP transport，不是部署于公网的真实服务。
- schema 探针只验证所列有限样例，不承诺任意 schema、模型 provider schema 转换、外部 `$ref` 或业务参数兼容。
- 探针中的短超时仅为故障测试，不是产品默认参数。运行结果不能用于替代 Issue #36 的完整验收。
