---
doc_kind: plan
created: 2026-09-27
---

# 原生模型 Adapter 合同

> 状态:已实现，Issue #40 响应边界的 Linux 离线验收已完成(2026-09-28)；2026-10-01 按 [ADR-030](../decisions/030-native-arguments-and-conversation-persistence.md) 对齐当前批次保存合同；2026-10-03 完成下文缓存修复、Linux 离线验收及 xAI 代理小样本验证。deferred 记忆整理的接入和预算修复证据见 [Issue #42 施工图](memory-organizer-issue-42.md)，外部验收单列。决策见 [ADR-028](../decisions/028-model-response-boundary.md)，原响应边界证据见 [Issue #40 施工图](model-response-boundary.md)，公共示例见[SDK](../sdk.md)。

`createAgent({ model, adapter })` 接受 TanStack `AnyTextAdapter`，SDK 导出名称为 `ModelAdapter`。对象 `Model` 必须配 adapter；目录字符串可以覆盖 adapter，更新时 `adapter: null` 恢复内置传输。旧 `streamFn` 在创建和更新时显式拒绝，不提供兼容包装。任务、摘要与 deferred 记忆整理均通过 `chat()` 和同一个受审计 adapter 接缝，`sessionId` 映射到原生 `threadId`，请求取消使用 `TextOptions.request.signal`。

`model-adapter.ts` 集中目录协议到原生 adapter 的映射、认证和 modelOptions。当前目录为 37 个 provider、1314 个模型、7 种 api；无等价内置传输的 Mistral Conversations 和 Codex Responses 不在目录中。宿主可以通过对象模型与原生 adapter 接入其他能力。增加 provider 时只修改相关 adapter 工厂、目录和认证，不修改会话循环、工具策略或 UI。

`model-response.ts` 是唯一 provider/history 转换位置：TanStack 当前 `ModelMessage` 提供成功响应的 text、thinking 和完整工具调用；Forge 审计原始 chunks 的终态、事件配对和严格工具 JSON，并补足签名、redacted、内容顺序与错误 usage。失败和取消只保留恢复部分输出所需的临时缓冲。历史仅在请求时转换为 `ModelMessage`。`model-call.ts` 等迭代器完整结束或关闭；TanStack 原生校验和审批完成后串行执行工具，批次结束后由会话按提案、调用顺序的结果保存，再请求下一轮模型。原生错误结果也在续轮前共同结算；取消等待已开始工具清理并保存已得结果。保存失败停用实例，但副作用可能已发生，进程崩溃可能丢失最新批次。无工具最终回答由 `onFinish` 提交一次。`RUN_FINISHED` 本身不是 invocation 成功证据；最终以 `AgentTurn.result` 为准。当前保存合同见 [ADR-030](../decisions/030-native-arguments-and-conversation-persistence.md)。

完整工具响应即使以 provider 的 `stop` 结束也可以执行工具；半截 `length`、`deferred`、error、aborted 不执行工具。工具阶段取消保留已开始的结果并记录 aborted；已经完成的普通响应在存储等待期间取消不重复追加同一响应。自定义 adapter 报告的 `TokenUsage.cost` 原样保留，缺费用仍是未知；内置目录使用价格元数据估算，估算不是账单保证。

当前保留三个已锁定补丁：`@tanstack/openai-base@0.11.1`、`@tanstack/ai-anthropic@0.19.1`、`@tanstack/ai-bedrock@0.3.15`。补丁处理协议终态、工具参数及 reasoning/continuation；已发布最新版比较见 [Issue #40 施工图](model-response-boundary.md#发布包与补丁核验)。升级必须用本地 HTTP fixture 重新验证，不能用上游 main 或已合并 PR 代替发布证据。原传输迁移的历史证据见[归档](../archive/phases/tanstack-provider-transport-migration.md)。

真实供应商完整 AC-7 矩阵仍未测：需在明确凭据、目标、请求数和时间/费用预算下逐 provider 验证普通回答、工具续轮、摘要、恢复及取消，保留实际 usage/成本证据。Linux 离线矩阵、自定义 adapter、本地 HTTP 和下文仅覆盖 xAI 缓存的合成探针均不替代这项验收。

## Prompt cache 接线与计量修复

> 状态:已完成(2026-10-03)。软件合同通过 Linux 离线验收；当前 xAI 代理接受新参数且出现缓存命中，记忆变化后的缓存收益与长期收益未证实。本节不改变上文完整 AC-7 的验收状态。

### 行为与范围

- `chat()` 初始化即提供 Forge 主 system；官方 Skills 在 Memory 之前追加内容，最终顺序为主 system → Skills 目录 → 记忆。`beforeModel` 只更新 Forge 拥有的第一个 system 槽位。工具续轮、配置更新和原生审批恢复不重复追加主 system。继续使用官方 init recall/deferred save；记忆更新会使其后的历史前缀失效，固定前缀调整不承诺消除这种失效。
- SDK、动态配置和 CLI JSON 配置增加可选 boolean `cacheHints`，默认开启。`false` 关闭 Forge 主动提供的缓存参数，不关闭供应商隐式缓存，也不约束宿主自定义 adapter 内部行为。参数验证在配置准备时完成，生效仍沿用 accepted/applied 边界。
- 仅主任务请求启用提示：`xai` + `openai-responses` 的 `prompt_cache_key` 由 `sessionId` 稳定派生；`anthropic` + `anthropic-messages` 使用官方请求级 `cache_control: { type: "ephemeral" }`，采用默认 5 分钟 TTL。其他供应商不自动收到这些字段。摘要与记忆整理继续不主动添加任务缓存提示；不增加失败后静默移除参数的重试。
- Anthropic 与 Bedrock adapter 的 `promptTokens` 已是未缓存输入；其缓存读写独立记录。其余当前 adapter 按总输入扣除缓存读写。保持供应商有效总量信息，缺少总量时按实际语义计算；费用使用目录价格估算。上下文溢出检查包含普通输入、缓存读取和缓存写入。
- 不升级依赖、不迁移会话格式。回退可恢复代码；代理拒绝缓存字段时可设置 `cacheHints: false`。

### 验收

- [x] CACHE-1：公开 SDK / 本地 HTTP 回放验证固定 system 前缀、Skills/Memory 顺序、记忆刷新及工具续轮/审批恢复/配置更新无重复。
- [x] CACHE-2：xAI 主任务的 key 在续轮、同一 sessionId 重开时一致，新会话不同；关闭开关、辅助请求与其他 provider 不收到自动缓存提示。
- [x] CACHE-3：Anthropic 主任务发出有效请求级缓存控制；开关、SDK/CLI 配置校验与动态更新生效。
- [x] CACHE-4：Bedrock 缓存读写的成功/失败响应保留普通 input 和费用；缓存写入参与上下文溢出判断。
- [x] CACHE-5：反向验证、项目检查、示例类型检查和双语接入说明完成。

### 软件验证证据

- Ran：新增 `prompt-cache.test.ts` 的 8 个 SDK/HTTP 场景，扩展 Bedrock 成功/失败与总量零占位、窗口判断及 CLI 请求测试，保留原有测试。修复前首批回归为 8 pass / 8 fail；修复后通过，随后新增审批恢复等边界也通过。Bedrock 样例的未缓存输入从错误的 0 恢复为 100，合计 `100 + 700 cacheRead + 40 cacheWrite + 20 output = 860`，目录估算费用从错误的 $0.00066 修正为 $0.00096。
- Ran：`bun install --frozen-lockfile` 无依赖变更；`bun run test:plan`、`bun run check`、`bun run typecheck:examples`、`bun run build` 全通过。最终 `run-8BlwCV`：349 contract + 643 integration + 50 CLI/PTY = **1,042 pass，0 fail，0 skip**；Linux OS 网络隔离探针通过，headless 已包含在 CLI 组。
- 证据位于 `.test-results/run-8BlwCV/` 的 summary、JUnit 与日志。基于 HEAD `94394b4b272f54f35580169a1e3f1317e7ea4df5` 的未提交工作区，可执行源码 SHA-256 为 `2ea308a987a4ca48096ee08312de314a78bc25c97ed632c713ab3b501252d28e`；检查后现场核对一致。双语 README 和 SDK 同步说明开关、计量与边界。

### 真实代理小样本

2026-10-03 使用当前已配置的 `xai/grok-4.6` Responses 代理，共 **6 次上游请求，全部 HTTP 200 / success**，总耗时 24.406 秒。只有合成 system、单个合成 Skill 和临时 Markdown 记忆；关闭上下文压缩、deferred 整理与重试，不读私有会话。真实凭据只在父进程代理中，worker 使用假 key，未记录地址、凭据或回答正文。

上限为 6 请求、整体 180 秒、单请求 30 秒、每请求输出 256 token、请求 JSON 17,000 bytes；代理在发送前按请求字节数加 1,024 输入余量及输出上限预留目录费用，合计预留 $0.194542，低于 $0.25 预算。目录估算不是实际代理账单保证。

对照组在当前 SDK 上重建旧请求策略：Memory → Skills → 主 system，关闭缓存提示；修复组使用当前内置 adapter 和默认提示。两组使用不同 nonce 避免主要内容互相预热，每组依次发送新会话请求、追加用户输入、只修改记忆后追加输入。对照组不是旧 commit 的完整运行环境；每个场景只有一次，模型输出 token 数不同。

| 请求策略 | 场景 | 未缓存 input | cacheRead | output | TTFT ms | 总耗时 ms | 估算 USD |
|---|---|---:|---:|---:|---:|---:|---:|
| 重建旧策略 | 新会话 | 3021 | 128 | 148 | 4479 | 4709 | 0.006994 |
| 重建旧策略 | 相同前缀追加 | 243 | 3072 | 64 | 3019 | 3284 | 0.002406 |
| 重建旧策略 | 记忆变化 | 3271 | 128 | 87 | 3732 | 3882 | 0.007128 |
| 修复后 | 新会话 | 3021 | 128 | 114 | 4389 | 4588 | 0.006790 |
| 修复后 | 相同前缀追加 | 209 | 3072 | 44 | 3667 | 3874 | 0.002218 |
| 修复后 | 记忆变化 | 3217 | 128 | 109 | 3411 | 3608 | 0.007152 |

全部 `cacheWrite = 0`，TTFT 从 `runTurn` 到第一个非空 text delta。目录估算合计 **$0.032688**。修复组三请求均带同一个 `prompt_cache_key`；对照组不带。新会话也收到 128 个缓存 token，因此不能将它当作完全无共享缓存的冷启动。

相同前缀追加的缓存读取占比为旧策略 92.67%、修复后 93.63%，两者实际缓存读取量同为 3,072 token。记忆变化后，两组都只读取 128 token，**本次未观察到固定前缀调整在该代理上的命中收益**；小样本也不能分离 key、路由和模型输出差异的影响。请求接线与字节顺序由离线测试确认，不能据此保证代理会复用所有未变化的前缀，更不能据此次延迟或费用差异声明稳定提升。

- Not run：真实 Anthropic/Bedrock、完整供应商工具/摘要/恢复/取消矩阵、macOS/Windows、TTL 到期与多路由重复实验、长期使用收益。
- Why / Risk：本次真实范围限当前 xAI 代理与 6 次请求；本地协议 fixture 不证明其他服务接受参数，缓存驻留和计费受供应商/代理控制。代理拒绝字段时可显式设置 `cacheHints: false`，但它不回退 system 排序或关闭隐式缓存。
