---
doc_kind: note
created: 2026-09-27
---

# TanStack 基座重构验收

> 状态:本地实现与离线软件验收已完成(2026-09-27)，真实供应商及其他外部验收未完成。对应[设计](tanstack-foundation.md)与 [ADR-025](../decisions/025-tanstack-agent-foundation.md)。本次设计与实施依据 operator 的自主执行授权，不表示人工验收通过；operator 在完成离线验收后明确授权本地提交，未 push、发布或修改远程任务。

## 基线

HEAD `1336da5ff869f08df37959f01eb353f6c8d9dc96`；Bun 1.3.12，Linux x64。

- `bun install --frozen-lockfile`：通过。
- `bun run check`：依赖/包/automation/test 类型通过，integration378与CLI14通过。首轮contract误包含研究下载包测试而失败，不是产品基线失败；隔离研究包后 `bun run test:contract` 558 pass / 0 fail。干净仓库共950项通过，OS network-namespace强制隔离。
- `bun run typecheck:examples`、`bun run test:headless`：通过。
- 本地日志：`review-notes/foundation-baseline/{check,contract-clean,examples,headless}.log`。

## Ran：最终完整门禁

下列结果来自最终生产代码、测试、依赖与 lockfile，环境为 Bun **1.3.12**、Linux x64。依赖变更先执行正常 `bun install` 更新 lock，再验证 frozen install。所有模型响应来自内存 adapter 或本地 HTTP fixture。

| 实际命令 | 结果 | 本地原始日志 |
|---|---|---|
| `bun install --frozen-lockfile` | exit 0，241 installs / 247 packages，no changes | `review-notes/foundation-final-install.log` |
| `bun run check` | exit 0；依赖边界、五包类型、automation/tests 类型通过；contract **541/0**（72 files）、integration **401/0**（32 files）、CLI/PTY **14/0**（11 files），合计 **956 pass / 0 fail** | `review-notes/foundation-final-check.log` |
| `bun run typecheck:examples` | exit 0 | `review-notes/foundation-final-examples.log` |
| `bun run test:headless` | exit 0；正式 CLI 产生预期 JSON 事件及 `agent_end.outcome=success` | `review-notes/foundation-final-headless.log` |

`scripts/test-offline.ts` 实际报告 `networkIsolation: network-namespace`。隔离探针确认 loopback HTTP 可用，外部 IPv4/IPv6 TCP、UDP 及继承的 Bun/CLI/bash 子进程断网；没有关闭隔离或使用宿主供应商凭据。PTY 已由 `check` 包含，没有重复整组执行。

三个原生 adapter 示例 `bun examples/custom-adapter.ts`、`bun examples/turn-policy.ts`、`bun examples/context-transform.ts` 已在相同 Linux 隔离条件下执行通过，分别完成注入响应、策略终止、临时请求投影且不写入历史；日志 `review-notes/foundation-native-examples.log`。它们不是实际供应商验证。

完整门禁前一轮的 `check-deps.test.ts` 因临时源码文件仍命名 `session-port.ts`、诊断预期已改为 `session-assembly.ts` 而失败。修正创建路径，保留依赖边界断言；最终完整门禁已包含该修复。其他本次回归均先定位、修复后重跑，没有通过放宽超时、删合同断言或跳过测试取得通过。

## 行为与完成判据

下表证据均已包含在上述最终 956 项中；专项运行用于开发期定位，不另外叠加到最终数量。

| 设计 AC | 最终结果与主要证据 |
|---|---|
| AC-1 原生主链 | 完成。`AgentSession.runChat` 使用 `chat`/middleware/`toolDefinition`；Pi runtime、HostedAgent、AgentPort、session-port、StreamFn 与三层流包装已删除。SDK/CLI/TUI 共用 `createAgent`。 |
| AC-2 输入、配置、终态 | 通过。`input-ownership`、`runtime-configuration`、`runtime-session`、`runtime-turn-policy`、`foundation-lifecycle` 和 `native-lifecycle` 覆盖 processed、one-at-a-time、accepted/applied、当前响应及工具快照、全部终态、取消、完整 compact/idle/dispose。已完成的结果在 break/dispose/消费者抛错后不被改成 aborted；disposed/faulted 拒绝 configureContext。 |
| AC-3 工具与提交 | 通过。`runtime-tools`、`session-tools`、`tool-arguments`、`foundation-review`、`parallel-tools` 与 `native-lifecycle` 覆盖最终参数校验、授权、并行/整批串行、before/after 干预、迟到更新、取消、按调用顺序保存和存储屏障。授权视图不能改写执行参数或工具身份；非法 after 结果成为可保存的工具错误。 |
| AC-4 provider 与模型接缝 | 通过本地协议验证。`provider-matrix`、`provider-stream`、`openai-stream`、`responses-terminal`、`bedrock-converse`、`native-model`、`runtime-adapter` 覆盖内置协议的增量、工具参数、reasoning/continuation、usage、缺失终态、失败及取消；`context-http`/`context-compaction` 与 SDK 测试覆盖任务和摘要共用 adapter，sessionId 进入原生 threadId。 |
| AC-5 数据与宿主扩展 | 通过。`context-*`、`compaction-lifecycle`、`request-budget`、`foundation-data`、`session-*`、memory/Skills/MCP 各组覆盖分支/证据、预算/压缩、旧数据副本、Markdown、MCP 资源/凭据/释放和 Skills 配置语义。只使用临时副本和受控服务。 |
| AC-6 必要检查与反向验证 | 通过。四项最终命令、14 项 CLI/PTY、两项红→绿反向验证，见上下文。 |
| AC-7 本轮规格交付 | 完成。全仓处置清单已实施；三项独立审查发现已处理；README/SDK 中英文、当前合同、ADR 替代关系和归档导航已同步。此编号仅属本轮设计，**不等于历史 provider 迁移的真实供应商 AC-7**。 |

## 数据副本与测试迁移

新增 `packages/core/test/foundation-data.test.ts` 使用旧 v4 JSONL 临时副本：包含 `adaptive` 检查点、证据 ID、完整工具 exchange/details、thinking/text/tool 签名、分支和 MCP 模板封套。执行 restore → 原生请求 → append → reopen，断言原件和副本旧前缀逐字节不变，旧工具不重放。第二项验证 Markdown 记忆与宿主持久化 MCP 二进制附件跨 dispose/reopen 保留。与原有 `session-conversion.test.ts` 的专项合计 **6 pass / 0 fail / 68 assertions**，最终全仓再次覆盖；日志 `review-notes/foundation-data-targeted.log`。

旧版本读取仍是数据合同。没有迁移或覆盖真实用户会话、记忆、配置和附件；本次没有新数据格式。旧 v3 的显式 `convertCopy`、v4 `adaptive`→`checkpoint` 读取规则仍由既有测试验证。

- 两个旧 runtime 测试文件的 **45 项**逐项处置：删除已撤下内部 API 的断言，将有效行为迁到公开 SDK；`tests/loop-contract/native-lifecycle.test.ts` 新增 **19 项**展开用例。原内部 subscriber、mutable state、legacy callback 不保留测试兼容内核。
- 删除仅验证旧 EventStream 的 `model-stream.test.ts` 两项；`runtime-stream-fn.test.ts` 迁到 `runtime-adapter.test.ts`，`session-port.test.ts` 迁到 `session-tools.test.ts`。
- `tests/support/test-port.ts` 改为 `test-agent.ts`，factory 进入公开 `createAgent`；原生 adapter/reply/request helpers 分别负责协议 fixture、响应构建和请求观察，没有旧别名。`session-conversion.test.ts` 原文保留，它验证必要旧数据解析。
- Skills header 的 BOM、LF/CRLF/CR、EOF delimiter、完整分隔符和正文保真断言保留并迁到真实 reader；只删除重复 `frontmatter/text` 实现。

逐项旧测试处置与审查原始记录位于 `review-notes/foundation-runtime-test-audit.md`、`foundation-sdk-data-audit.md`、`foundation-loop-audit.md` 和 `foundation-spec-review.md`。这些本地记录便于复核；当前可共享合同和结论以上述正文及仓库测试为准。

## 反向验证与审查修复

两项变异都在 `try/finally` 中恢复原文件，恢复后定向重跑成功，之后完成上述全仓门禁。结果索引 `review-notes/foundation-mutations.json`。

| 临时破坏 | 实际红灯 | 恢复后 |
|---|---|---|
| 将 assistant 持久化的 `await persistMessage` 改为不等待 | `runtime-tools.test.ts` 的 assistant persistence barrier 发现写入尚未完成工具就产生副作用，0 预期、1 实际，exit 1 | 同一测试 exit 0 |
| 移除最终请求预算上界拒绝 | `context-transform.test.ts` 的 hard boundary +1 检测到超限请求被发送，exit 1 | 同一边界组 exit 0 |

独立审查还促成以下实际修复，均有专项红灯或协议复现并已纳入最终绿灯：原生 chat 提前关闭 provider iterator 的保存/结算，custom adapter 显式零费用，首次 onConfig 重复消费输入，Skill 准备期配置快照，compact 存储失败结算，已完成结果的消费端关闭，最终参数和 hook 身份隔离，length/stop 规范化终态，工具阶段取消保存，以及已释放/故障实例拒绝配置。

原生 chat 默认 ConsoleLogger 会向 stdout 输出调试对象；生产调用显式使用 `debug: false` 保持 JSON/终端输出合同。错误仍经 `SessionEvent`、持久化历史和 `AgentTurn.result` 报告，相关失败与重试测试没有被删除。

## 依赖与选型证据

2026-09-27 核对 npm 已发布版本、已安装源码、package skills 与官方文档；package skills 中过时版本声明不覆盖实际源码。核心版本均已是当日 latest，未凭 upstream main 宣称发布修复。

| 实际生产依赖 | 版本与本次职责 |
|---|---|
| `@tanstack/ai` | **0.61.0**；从仅 provider 传输扩大到唯一 chat 工具续轮、middleware、toolDefinition 与 Standard Schema 接线 |
| `@tanstack/ai-openai` / `ai-anthropic` | **0.24.1 / 0.19.1**；原生协议 adapter |
| `@tanstack/ai-gemini` / `ai-vertex` / `ai-bedrock` | **0.33.1 / 0.2.19 / 0.3.15**；原生协议 adapter |
| `@ag-ui/core` | **1.0.0**；明确直接声明原生 chunks 类型/事件依赖，不再依靠隐式传递依赖 |
| `@modelcontextprotocol/client` | **2.0.0**；继续复用官方完整 MCP 协议与传输 |
| `yaml` / `ignore` | **2.9.0 / 7.0.5**；Skills 使用成熟解析/忽略规则，删除重复 header 拆分 |

移除 `typebox@1.3.7`；`@smithy/core@3.35.0` 只供 EventStreamCodec fixture，移入 core devDependencies。其余现有工具、凭据/锁和 UI 依赖经全仓审计保留其实际职责。保留 `openai-base@0.11.1`、`ai-anthropic@0.19.1`、`ai-bedrock@0.3.15` 三个 provider patches，并在本地协议矩阵回归；无已发布修复证据不能删除补丁。

未采用的五个扩展包均按“围绕原生生命周期重设计”比较，不因无法直接插进旧结构而拒绝。对应 npm 精确版本的发布源码是依据：[compaction 0.1.9](https://registry.npmjs.org/@tanstack/ai-compaction/0.1.9)、[persistence 0.6.7](https://registry.npmjs.org/@tanstack/ai-persistence/0.6.7)、[mcp 0.4.6](https://registry.npmjs.org/@tanstack/ai-mcp/0.4.6)、[skills 0.1.11](https://registry.npmjs.org/@tanstack/ai-skills/0.1.11)、[memory 0.2.6](https://registry.npmjs.org/@tanstack/ai-memory/0.2.6)。

- compaction 仍需 Forge 的证据/分支、摘要恢复和完整动态预算；custom strategy 额外增加状态桥接，直接 onConfig 更简洁。
- persistence 的 best-effort 写入及 error/abort 行为不能代替逐工具 durable barrier 和分支历史；接入后仍要保留完整存储链。
- mcp 的 v1 wrapper 不能提供当前 v2 宿主全部接缝，重设计需要第二 client；直接官方 v2 更少职责重复。
- skills 丢失 explicit-only/扫描规则，load 缺取消，loaded Set 在压缩后阻止再次加载；自定义 source 仍需完整现有 reader。
- memory 的 recall/自动抽取/deferred save 无法替代显式 Markdown 版本、来源、写入权限和 worktree 副本；自定义 store 没有删除主要自有职责。

隔离原型 `review-notes/foundation-probes/loop-capabilities.ts` 的十组断言验证 native 串行/参数改写/after hook/取消/终态差异，以及重设计后 parallel maxActive=2、授权参数一致、配置 revision 隔离和先保存再续轮。扩展探针及结果保存在 `review-notes/foundation-packages/extensions-probe.{ts,json}`，发布源码快照只用于复现、不在生产依赖中。五个扩展包网页文档当时返回 403；已读取官方发布源码、README 和包内 skills，不将网页未访问记为已读。

结构化摘要也重新比较：原生 `outputSchema` 的无工具 schema-only 可以只用一次请求；但 `ai-bedrock@0.3.15` 的 `structuredOutputStream` 在缺少 `messageStop` 时因 JSON 可解析而合成成功。`summary-structured-output` 探针实得 `providerCalls=1, missingProtocolTerminalAccepted=true`。继续统一严格 `chatStream`/ResponseCollector 后解析 checkpoint，避免第二套 provider 终态/取消/usage 校验。结构校验不能替代原文证据校验。

## 本地交付与文档

全仓处置清单已完成。主要变化集中在 core 执行/装配/协议边界，CLI 调用、示例、脚本和测试随之迁移；protocol/tools/TUI 的领域与展示职责经审计保留。Pi runtime 来源、MIT 许可、固定上游 SHA 和本地差异迁入 `docs/archive/research/pi-runtime-provenance/`，不因删除实现而删除来源声明。

对外接口迁移及可运行入口见 [SDK 中文](../sdk.md#原生-tanstack-模型-adapter) / [English](../sdk.en.md#native-tanstack-model-adapters)：`streamFn`→`adapter`，`AgentOptions`→`CreateAgentOptions`，`storage: store.asStorage()`→`storage: store`，hooks 使用领域消息类型。启动为 `bun run forge-agent`；无需模型凭据的最小执行例为 `bun examples/custom-adapter.ts`。

启动前两份研究文档与 `review-notes/foundation-baseline/` 副本逐字节一致，并保留在本次提交范围之外。用户研究原文中指向已删除 `provider-stream.ts` 的历史链接保留，没有为旧链接恢复兼容源码；当前导航指向新合同。没有修改用户数据；本地提交依据 operator 后续明确授权，不包含远程状态变更。本地进度记录位于 `review-notes/2026-09-27-foundation-progress.md`。

最终文档检查覆盖本次修改/新增的 51 份 Markdown，510 个本地链接与 35 个锚点全部通过；单独排除并逐字节核对上述两份用户原文。`git diff --check` 通过；Pi LICENSE 与 upstream.json 归档副本逐字节等于启动版本；生产源码和调用方无旧 port/stream、asStorage、AgentOptions 同义接口、typebox 或本轮待实现 TODO。一次性生成/格式化脚本和重复下载的 core 源码已清理；五个扩展包发布源码、可复现探针及日志作为选型证据保留，不是生产依赖。

## 外部边界

| Not run | Why | Risk |
|---|---|---|
| 历史真实供应商 AC-7：回答、工具续轮、摘要、恢复、取消 | 本次没有明确 provider/model、请求数及时间/费用预算，未调用真实模型 | 受控协议矩阵不能证明真实服务全部兼容性或模型任务质量 |
| 真实 MCP OAuth 账号及实际服务/模型组合 | 没有本次真实账号交互与模型预算；本轮只使用受控 AS、官方测试 server 和本地模型 fixture | 真实 scope、浏览器回调、token 生命周期和实际服务差异仍需外部验收 |
| macOS/Windows、长期 TUI、人工验收 | 当前环境为 Linux；本轮执行自动 PTY，无多日人工使用 | 不将 Linux OS 断网证明推广为其他平台；不承诺长期运行无竞态 |
| 新架构任务质量/费用/延迟对照、任意断电与文件系统崩溃一致性 | 没有新冻结任务集、预算或故障环境；既有 JSONL/Markdown 合同未增加这些保证 | 未宣称质量或性能改善；外部副作用不可回滚，未知部分写入须检查后重建实例 |

第三方 0.x 的工具阶段和 provider 语义仍会演进；升级须重核本次明确接缝与保留补丁。宿主自定义 adapter、工具与策略必须合作响应 signal；框架能等待和停止调度，不能撤销任意外部副作用。以上是剩余外部事项与合同边界，不是留待下次实施的本轮代码批次。
