---
doc_kind: plan
created: 2026-10-01
---

# 官方 OTel 中间件接入

> 状态:初次接入与 operator 确认的耦合优化均已完成本地实现及离线验收(2026-10-01)；任务接线已随 [Issue #45](native-execution-issue-45.md) 迁入内部原生执行模块，本次回归证据见该施工图。真实 provider/collector 与跨平台未验证。

## Why / Entry

为现有 TanStack 执行链增加可导出的模型与工具观测。安装的 `@tanstack/ai@0.61.0` 已提供 `@tanstack/ai/middlewares/otel`；使用原生实现，无需升级 TanStack 或维护自有 span 引擎。入口工作区干净，上轮会话简化已提交为 `0ab1f34`。

## What

- SDK 的创建参数增加 `otel?: OtelMiddlewareOptions`，直接复用官方类型与回调。省略时关闭；配置只在创建时设置，浅快照 options，tracer/meter 由宿主共享和释放。Core 不注册全局 OTel provider、不加载 exporter。
- 任务、压缩摘要和 deferred 记忆整理都使用现成的 `chat()` 入口接入同一官方中间件，以 `forge.request.kind=task|summary|memory` 区分。辅助请求独立 root，用 session ID 关联；revision 只在任务的已应用响应上记录，不为辅助请求伪造 revision。
- 顺序为 `memory? → skills? → forge-session → otel?`。任务接线在请求边界更新官方中间件的稳定上下文视图，provider/model 来自已应用的响应配置；宿主 span 回调保留各 span 创建时的模型身份，内容采集使用最终 `providerMessages`。补充 session、run、parent run、配置 revision 属性，用户 enrich 回调仍可添加属性。
- 原生中间件负责 chat/iteration/tool span、usage、可选 meter、错误和取消。每次原生 `chat()` 为一个 root；审批 interrupt/resume 为不同 root，通过 run/parent run 属性关联。不额外生成 Forge invocation span。
- `0.61.0` 在 interrupt 等待时跳过 terminal hook，官方 OTel 不自行关闭 span。接线层在明确 `RUN_FINISHED/outcome: interrupt` 后仅调用 OTel 的 `onFinish`，并在 root 标记 `tanstack.ai.outcome.type=interrupt`；不触发会话保存或 memory 成功调度。该补充已由真实 exporter 测试发现的未结束 span 驱动。
- CLI 设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 或 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 时启用官方 HTTP/JSON trace exporter 和 batch processor；`OTEL_SDK_DISABLED=true` 禁用。`OTEL_SERVICE_NAME` 默认 `forge-agent`。支持 exporter 原生 headers/timeout 环境变量；协议固定 HTTP/JSON。正常退出在 Agent 释放后等待 provider shutdown，导出失败写 stderr，不改变任务结果。CLI 本轮只导出 traces。
- 官方 `captureContent` 默认 false；CLI 仅 `FORGE_OTEL_CAPTURE_CONTENT=true` 时启用。SDK 可使用官方 redact。关闭内容采集仍包含工具名、模型名、usage 及异常信息；异常本身可能带业务文本。

### 已确认的耦合优化

- 任务接线仅接收 `provider`、`model` 与 `revision`，由内部原生执行模块从会话提供的 applied 请求快照提取；观测模块不依赖完整 `SessionConfiguration`。职责迁移见 [Issue #45 施工图](native-execution-issue-45.md)。
- 删除实时查询配置的 `Proxy`。保留原生中间件需要的稳定上下文对象，在模型请求边界更新它的模型身份；root 与当前 iteration 分别保存创建时的身份。宿主的 span 回调拿到对应 span 的模型身份快照，下一轮配置不改写旧 span 的回调信息。其余上下文字段仍遵循原生生命周期。
- 摘要、记忆调用的 adapter 固定，直接使用官方 `otelMiddleware`；只共享 session/run/kind 属性补充，不进入任务的动态配置与 interrupt 适配。
- interrupt 兼容处理集中在任务接线。升级 TanStack 时验证审批 run 的 span 是否原生结束，再决定删除兼容代码；不通过新增通用钩子转发框架隐藏版本依赖。

## Acceptance Criteria

- [x] AC-1: 使用真实 OTel in-memory exporter 得到模型续轮与工具父子 span、usage 和可选 metrics；默认没有消息/工具正文。任务、摘要和 deferred 整理均有实际 span。
- [x] AC-2: 配置应用后身份、revision 和采集的实际请求正确；审批续接关联 run，工具只执行一次。
- [x] AC-3: provider 错误、取消与观测回调失败有正确边界，观测回调失败不改写任务结果。
- [x] AC-4: CLI 向本地 OTLP fixture 实际导出，并在退出前完成 flush；JSON stdout 保持协议完整；不配置或禁用时不导出。
- [x] AC-5: SDK/README 中英文指南、示例与必要仓库检查通过。
- [x] AC-6: 同一原生 run 内切换模型后，旧 span 的结束回调及已保存的开始回调上下文保留各自创建时的 provider/model；最终请求采集、辅助请求和 interrupt 验收仍通过。

## Verify / Release

集成测试用官方 `InMemorySpanExporter`/metric reader；CLI 用 loopback OTLP HTTP fixture。按仓库 Linux 网络隔离 runner 验证。一次移除接线的反向验证必须令对应测试失败，恢复后通过。最终记录本次检查、未测边界及证据路径。

初次接入证据：

| 检查 | 结果 |
|---|---|
| `bun run check` | 通过：333 contract + 618 integration + 49 CLI/PTY = 1000 tests；依赖边界、workspace/automation/tests typecheck 通过 |
| 网络隔离 | Linux x64 / Bun 1.3.12，独立 HOME/XDG，无继承 provider 凭据；loopback fixture 可用，外部 IPv4/IPv6 TCP/UDP 与继承子进程隔离探针通过 |
| `bun run typecheck:examples`、`bun run build`、`bun install --frozen-lockfile` | 通过；冻结安装无更改 |
| `bun examples/otel.ts` | 成功任务及两个实际导出的 chat/iteration span，默认不含正文 |
| 反向验证 | 同样的 Linux 网络 namespace/空环境中暂时移除任务 middleware 接线；审批续接测试因 root span 由 2 变为 0 失败；恢复后 1/1 通过，临时目录已删除 |

完整记录：`.test-results/run-jgz2nH/summary.json` 及同目录分组日志/JUnit。新增 OTel 测试为 `packages/core/test/sdk-otel.test.ts` 的 8 项和 `packages/cli/test/telemetry.test.ts` 的 6 项。CLI 覆盖 HTTP/JSON payload、精确 endpoint 优先级、退出 flush、内容开关、关闭/禁用及接收端返回 400 后主任务仍成功。该证据不扩展为 exporter 重试送达、真实后端兼容性或真实供应商行为。

耦合优化证据：

| 检查 | 结果 |
|---|---|
| 同 run 模型切换回归 | 完整 `AgentSession` 中，原生工具参数校验失败后在同一 run 续轮并应用新模型。旧实现的结束回调记录新模型，测试失败；修正后通过，并验证宿主保存的三个开始回调上下文不随下一轮改变模型身份 |
| `bun run check` | 通过：333 contract + 619 integration + 49 CLI/PTY = 1001 tests；依赖边界与 workspace/automation/tests typecheck 通过。Linux 网络隔离探针通过 |
| `bun run typecheck:examples`、`bun run build`、`bun examples/otel.ts` | 全部通过；示例成功完成任务，实际导出 root/iteration span |

当前完整记录：`.test-results/run-bU4RM2/summary.json` 及同目录分组日志/JUnit。SDK OTel 现有 9 项测试；初次接入的审批、metrics、最终内容采集、错误、取消、资源归属和辅助请求验收均仍通过。回归先红后绿验证在独立 HOME/XDG、无继承凭据的 Linux 网络 namespace 中执行；临时目录已清理。

## Boundaries / Risk

Span 状态只描述 TanStack 生命周期，`AgentTurn.result` 仍为 Forge 权威终态；后置存储、deferred 工作失败可能发生在任务 span 结束后。摘要/记忆整理的调用失败有自己的 span，但后续记忆 JSON 校验/落盘不属于模型 span。无法承诺进程强杀、断电或 exporter 不可用时送达。真实 collector/backend 和跨平台行为另行验证。

## Rollback

SDK 省略 `otel`、CLI 清除 endpoint 或设置 `OTEL_SDK_DISABLED=true` 即关闭观测。代码接入与依赖可随本轮变更一并撤回，不涉及会话格式迁移。
