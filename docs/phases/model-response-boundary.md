---
doc_kind: plan
created: 2026-09-28
---

# Issue #40 模型响应边界施工图

> 状态:本地实现与 Linux 离线验收已完成(2026-09-28)，真实供应商、跨平台及长期人工验收未完成。任务范围与 AC 以 [Issue #40](https://github.com/L-1ngg/forge-agent/issues/40) 为准；现行工具执行合同见 [ADR-027](../decisions/027-native-tool-approval-and-interruption.md)。

## Entry And Design

起点 `0fe2e505f7e0cffb00b772ee688cc5950c574d72`，`master` 工作区干净，无暂存、未暂存或未跟踪文件。Issue #40 已确定 `chat()` 唯一循环、原文 JSONL 和公开测试边界。起点的 `ResponseCollector` 在原始流上重建完整成功消息，TanStack 同时聚合 `ModelMessage`；本次删除前者的成功消息状态。

1. 原始 adapter 旁只审计事件生命周期、终态、工具 JSON 和缺失字段，并保留失败/取消时恢复部分输出所需的临时缓冲。审计等到迭代器 `finally` 结束；`RUN_FINISHED` 及 TanStack 的正常 EOF 均不能替代完整协议检查。流式 `SessionEvent` 保持原顺序。
2. `beforeTools` 读取当前请求的 TanStack assistant `ModelMessage`，补齐原始流上 TanStack 未表示的签名、redacted 标记与 usage，投影为 `SessionMessage`。完成参数准备和逐条 JSONL 提交后才让工具执行。TanStack 已产出原生错误结果的批次在续轮前走相同门禁。
3. 无工具的正常回答在 `onFinish` 投影并提交一次。`onError`、`onAbort` 保存尚未提交的部分响应；存储故障后不再追加一条响应。每次模型请求和提交状态负责去重，审批 `resume` 沿用现有进程内状态。
4. 摘要调用同一原始审计和投影；usage、费用、重试和旧 JSONL 请求投影保持各自现有职责。`length`、`deferred`、错误、取消不得启动工具；完整工具提案的 provider `stop` 可进入工具阶段。

锁定版 Gemini adapter 在 `RUN_ERROR max_tokens` 后还会发送已开启内容的闭合事件与一次 `RUN_FINISHED stop`。审计仅允许这段截断收尾，结算仍为 `length`；额外内容、重复的 `RUN_FINISHED`/消息闭合事件或独立的 adapter/`finally` 故障结算为 `error`。推理消息与 step 在成功终态前必须配对；同一 step 的多次 `STEP_FINISHED` 增量通知仍有效。

已发布依赖比较以实际发布包、peer 与离线协议矩阵为准；只有行为覆盖并减少维护代码才升级或删补丁。不要引入第二份持久化 transcript。

## 发布包与补丁核验

2026-09-28 使用 `npm view <package> version peerDependencies --json` 和 `npm pack <package>@<version>` 下载发布包到隔离临时目录，再以 `tar -xOf` 阅读其 `src/`。这只核对发布产物，不把上游 main 当作已发布修复。

| 组件 | 锁定版 → 已发布最新版 | 发布版核验与决定 |
|---|---|---|
| `@tanstack/ai` | `0.61.0` → `0.63.0` | `beforeTools`、`onFinish` 仍有相同生命周期；`ModelMessage.thinking` 仍没有 redacted 类型，且没有 Forge 的逐条 JSONL 门禁。单独升级不删除本次审计职责。 |
| `@tanstack/openai-base` | `0.11.1` → `0.12.1` | Responses 完成事件已有停止迭代改进，但 Chat Completions 仍固定 `stream_options` 且在缺少 `finish_reason` 时回退 `stop`；Responses 非法参数仍回退 `{}`，错误响应的 `RUN_ERROR` 仍缺 usage。三个补丁职责未全部覆盖，保留补丁。 |
| `@tanstack/ai-anthropic` | `0.19.1` → `0.19.3` | 发布的 text adapter 仍缺 redacted thinking 回放，并在 `message_delta` 发终态，未等 `message_stop`；保留补丁。 |
| `@tanstack/ai-bedrock` | `0.3.15` → `0.4.1` | 发布的 Converse 转换仍将失败工具结果写作 success，缺 redacted reasoning 与 `additionalModelRequestFields` 传递，stream processor 对缺失 `messageStop` 仍回退 `stop`；保留补丁。 |
| `@tanstack/ai-skills` / `@tanstack/ai-memory` | `0.1.11` / `0.2.6` → `0.1.13` / `0.2.8` | 最新版 peer 均要求 `@tanstack/ai@^0.63.0`；只升级 core 或单个 companion 都不构成可用组合。 |

本次未升级依赖或删补丁。现有精确锁定继续由本地 HTTP 协议矩阵验证；最新版未安装进生产工作区，未把其协议矩阵宣称为通过。只有后续发布包覆盖剩余行为、peer 一致、维护补丁净减少且相同矩阵通过时才重新取舍。

## Verification And Release

测试边界沿用 Issue #40 的 Testing Decisions、ADR-025 与 Issue #39/ADR-027：公开 `createAgent`、`runTurn/continue`、`AgentTurn.result`、`SessionStorage` 和执行计数驱动真实 `chat()`，本地 HTTP fixture 验证内置 adapter；不 mock 工具循环。

**Ran**：`bun run test` 在 Linux network namespace 中通过，contract 534/534、integration 367/367、CLI/PTY 15/15。覆盖自定义 adapter 的完整/错误/取消/截断响应、孤立推理事件、Bedrock 跨 step 推理、七协议本地 HTTP 回归、签名续轮、审批与策略停止、工具提案及结果提交、旧 JSONL 副本恢复和再次打开。`bun run test:headless`、`bun run typecheck`、`bun run typecheck:tests`、`bun run typecheck:automation`、`bun run typecheck:examples`、`bun run check:deps`、`bun run build` 和 `git diff --check` 通过。反向验证临时跳过工具提案提交时，写入故障测试观察到工具执行次数由 0 变为 1；恢复代码后测试转绿。

**Not run / Why / Risk**：未执行真实供应商 AC-7，缺少本次授权的供应商目标、凭据及费用预算；未执行 macOS/Windows 或长期人工使用。离线通过只证明本地 fixture 与 Linux 执行边界，供应商协议变化和跨平台行为仍需各自验证。发布新版依赖的协议矩阵未运行，因为发布包比较表中的行为和 peer 条件尚未达到升级门槛。

**职责核对**：已删除 `ResponseCollector` 对成功响应的完整 assistant 聚合。`RawResponseAudit` 仅保留原始事件协议校验、失败/取消时部分输出缓冲、流式索引、签名/顺序 metadata 与错误 usage；成功内容由 `ModelMessage` 投影。未新增并行 transcript 或持久化 run 账本。出口为 Issue #40 的适用 AC、必要文档、双轴审查和本地 commit；真实供应商与跨平台证据不由离线测试替代。

若交付需要回退，按起点 SHA 审查并 revert 本次提交；存储或协议不确定时拒绝工具执行。不迁移真实会话文件，不保留旧响应聚合双轨。
