---
doc_kind: plan
created: 2026-09-26
---

# 其余内置模型传输迁移到 TanStack AI

> 状态:内置传输、`pi-ai` 包依赖清零及 AC-2 至 AC-5 离线矩阵通过完整门禁；无等价协议目录与旧装配命名已清理，真实供应商 AC-7 未测(2026-09-26)。operator 要求全量替换 OpenAI 之外的内置 adapter，并允许移除无等价适配器的 provider；沿用 [ADR-024](../decisions/024-incremental-tanstack-ai-adoption.md) 的 Forge 循环与单供应商单传输决定。OpenAI 已有[独立施工与证据](openai-tanstack-transport.md)。

## Entry

迁移前固定目录快照有 39 个带模型的 provider、1354 个模型、9 种 `api`；另有一个空目录 provider。当前目录只含 37 个 provider、1314 个模型和 7 种有 TanStack 传输的 `api`。无等价协议的目录数据已移除；选择旧模型得到 `Unknown model`，宿主仍可显式提供自定义 `streamFn`。目录、认证、公共类型与预算辅助由 Forge 维护，直接 `pi-ai` 包依赖清零。

| 迁移前 `api` | 模型数 | 当前路径 | 特殊验证 |
|---|---:|---|---|
| `openai-completions` | 679 | TanStack OpenAI-compatible Chat Completions；原生 Groq、OpenRouter 可用对应适配器 | provider URL、headers、reasoning 扩展、工具参数及 usage |
| `anthropic-messages` | 325 | TanStack Anthropic；网关按实际兼容性单独配置 | beta/缓存 headers、thinking 签名、工具结果 |
| `bedrock-converse-stream` | 121 | TanStack Bedrock | AWS bearer/profile/角色凭据、region、Converse 消息语义 |
| `openai-responses` | 107 | OpenAI 桥及 TanStack Responses-compatible/Grok | xAI 与网关请求体、reasoning 和函数 `itemId` |
| `azure-openai-responses` | 39 | Azure OpenAI SDK 客户端接 TanStack Responses adapter | endpoint、deployment、api-version、key |
| `mistral-conversations` | 32 | 已从内置目录移除 | TanStack Mistral 使用 Chat Completions，不能冒充 Conversations API |
| `google-generative-ai` | 29 | TanStack Gemini；网关独立配置 | 图片、thinking 签名、工具结果、项目网关 |
| `google-vertex` | 14 | TanStack Vertex | API key 与 ADC、project/location、模型路径 |
| `openai-codex-responses` | 8 | 已从内置目录移除 | `@tanstack/ai-codex` 是 coding harness，不是该私有模型流协议 |

## 施工合同

1. 在现有 `StreamFn` 接缝复用一次模型请求的 TanStack chunk 投影。Forge 继续拥有循环、工具准备/授权、会话、摘要、重试、预算和取消；适配器不得调用 TanStack `chat()` 的 Agent 循环。请求失败和取消必须作为最终 `AssistantMessage` 返回。
2. 将模型 `api` 和 provider 标识映射到唯一的 TanStack adapter 工厂。普通请求与 `createSummaryDriver` 使用同一选择结果；自定义 `streamFn` 不经过内置工厂。对于 OpenAI-compatible 网关，按目录模型的实际协议选 Chat Completions 或 Responses，不能只按 provider 名称猜测。
3. Forge 目录与认证解析负责 key、headers、baseUrl 和 provider env；显式 `apiKey`、OAuth、云凭据与 CLI 环境变量按当前合同选择。认证解析与传输工厂同一次配置提交生效。
4. Provider 专属请求参数、system/history/image/tools、thinking、usage、成本、`responseModel`、终态和错误分类通过真实适配器 fixture 校验。版本化保存 reasoning/工具 continuation，不把缺失或损坏的续接元数据误当新工具调用。SDK 重试设为零，由 Forge 决定 429/5xx/超限/取消是否重试。
5. 对无等价传输的 Codex 与 Mistral Conversations 明确停用内置路径；宿主仍可为完整模型对象提供自定义 `streamFn`。任何供应商不能仅因类型通过就宣称协议兼容；不受支持的请求在配置期明确失败。

## Batches

1. 抽出通用 chunk/历史投影，保持 OpenAI fixture 通过；建立目录 `api` 和 provider 选路矩阵。
2. 接入标准协议的 TanStack 适配器，逐协议完成请求体、终态、工具与摘要 fixture。
3. 接入特殊认证及端点，完成 Azure/网关 fixture；拒绝 Codex 与 Mistral Conversations，再删除所有生产 `models.streamSimple()` 调用与无用适配器依赖。
4. 同步中英文 README/SDK 与依赖门禁，运行冻结安装、全量检查和反向验证；真实凭据项单独标注实测或未测。

迁移后清理：从运行目录移除无等价传输的 `mistral`、`openai-codex` 模型与数据文件，沿用未知模型的配置错误；将内部 `pi-port` 装配层改名为 `session-port`，不保留旧导入入口。本仓库安装目录中不受当前锁文件管理的旧 Pi 包及链接也应清除。保留当前实际使用的 Pi 来源 `runtime/Agent`，历史决策与来源记录不改写。

## Acceptance Criteria

- [x] AC-1:当前目录的 37 个 provider 由 `api` 选择单一 TanStack 传输；Codex 与 Mistral Conversations 不再出现在内置目录；生产代码不再调用 pi-ai 的 `models.streamSimple()`，自定义流函数仍可用。
- [x] AC-2:7 种保留的 `api` 的普通请求、摘要、工具续轮、历史恢复和取消经锁定包的离线协议 fixture 通过。
- [x] AC-3:原生 key、显式 key、OAuth、AWS/Google 云凭据及网关附加 headers/URL 的解析与请求体一致；失败配置不替换生效配置。此项为本地端点与凭据模拟验收，不代表云账号实测。
- [x] AC-4:文本、reasoning、工具、usage/成本及 `stop`/`toolUse`/`length`/`error`/`aborted` 终态正确；429/5xx、提前 EOF、协议错误和非法参数不产生成功或工具副作用。非法工具参数可反馈给模型继续修复，但不会执行工具。
- [x] AC-5:版本化 continuation 经 JSONL 保存、重开、压缩和下一轮仍能配对，不重放旧工具。
- [x] AC-6:`bun install --frozen-lockfile`、`bun run check`、`git diff --check` 和故障注入反向验证通过；中英文文档与依赖边界一致。
- [ ] AC-7:真实凭据可用的 provider 完成受控普通回答、工具续轮和摘要；其余逐项标记未测与风险，不把离线通过称为真实供应商验收。
- [x] AC-8:无等价协议的数据文件、旧内部装配命名及本仓库安装目录的旧 Pi 包残留清零；当前目录仅包含可用模型，冻结安装与完整离线门禁通过。

## Risk

2026-09-26 验证记录：`bun install --frozen-lockfile`、`bun run check`、`bun run typecheck:examples`、`git diff --check` 通过。`packages/core/test/provider-matrix.test.ts` 对 7 种保留协议逐项执行普通回答、摘要、工具续轮、JSONL 重开、取消、长度截断、429/503、提前 EOF、损坏协议响应、非法工具参数及压缩后重开；工具与 reasoning 元数据检查覆盖 Anthropic、Bedrock、Responses 和 Gemini。Anthropic 锁定适配器已改为等待 `message_stop` 才发终态，提前 EOF 不再误报成功。Bedrock Converse 的 reasoning 文本、签名、redacted 内容、失败工具结果及未闭合块有单独离线覆盖；真实 AWS SDK HTTP 流的普通回答、摘要、工具续轮和中途取消也通过本地端点夹具。Bedrock profile、容器凭据及 Web Identity 角色凭据，Vertex ADC、Azure endpoint/deployment/version/key、Cloudflare 网关 URL/header 和配置更新原子性均经本地端点夹具验证。这些夹具不证明真实 AWS/GCP/Azure/网关账号可用。

AC-7 未运行：当前环境没有真实供应商凭据，真实模型权限、账号端点兼容、usage/费用和工具续轮仍是待验证假设。离线通过不能替代真实请求。

迁移后清理验收：目录测试先因 39 个 provider 与旧协议变红，移除 `mistral`、`openai-codex` 数据文件后核对为 37 个 provider、1314 个模型；内部装配改为 `session-port.ts`，测试夹具改为 `createTestPort`，无旧导入入口。根包、core、TUI 与 Bun 隔离安装目录中的旧 `pi-ai`、`pi-agent-core`、`pi-tui`、`pi-telemetry` 本地残留已删除；随后 `bun install --frozen-lockfile` 未重装这些包。清理后的 `bun run check`、`bun run typecheck:examples`、`git diff --check` 通过。仍保留实际生产使用的 Pi 来源 `runtime/Agent`，其来源见 `packages/core/src/runtime/README.md`。

后续验收顺序：取得明确凭据和预算后逐 provider 完成 AC-7 的受控普通回答、工具续轮及摘要；无凭据的 provider 保持未测。

- TanStack 官方 adapter 名称不等于协议等价：`@tanstack/ai-codex` 不是 ChatGPT `/codex/responses` 模型流，Mistral Chat Completions 也不是 Conversations API。Azure 没有独立的同名 TanStack 包，当前经 Responses-compatible 路径接入，真实账号仍需验证。
- 多数目录模型由 OpenAI-compatible 或 Anthropic-compatible 网关承载，认证和请求字段有 provider 特例。单一通用配置可能在代理层返回 2xx 后仍产生语义错误，必须检查真实请求体及响应终态。
- 当前环境没有各供应商凭据。离线 fixture 可证明 Forge 合同和客户端请求格式，不能证明账号权限、实际模型兼容或费用。
