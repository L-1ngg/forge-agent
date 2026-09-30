---
doc_kind: plan
created: 2026-09-30
---

# 测试文件与冗余审计

本表是基线 `45c2221a31b6bb30ab32d8c34860da96bc584475` 到本轮重构的迁移记录，不是第二份执行清单。当前可执行归属仅以 `scripts/test-plan.ts` 为准。

审查方法：逐文件核对发现/登记、测试名称与观察接口、import/入口引用；重点阅读有子进程、HTTP、时序与资源风险的实现，纯解析、schema、Markdown、cell/golden 用例沿用独立预期。最终 985 用例门禁与保存的 971 用例基线按 JUnit 名称多重集比较：969 保留、2 个参考自检删除、16 个真实入口/支撑回归新增；文件搬迁不作为新增有效覆盖。

## 原有测试文件

原有 119 个文件全部列出；拆分后的文件数量增加是按合同组织的结果，不追求删除有效用例。每行的合同例取自该文件的原始测试名，仅用于识别职责。

| 原文件 | 处置与最终归属 | 合同例 / 依据 |
|---|---|---|
| `packages/cli/test/headless-request.test.ts` | 保留并迁移支撑：cli | headless policy returns a conservative response and stable code for every kind |
| `packages/cli/test/headless.test.ts` | 保留：integration | headless uses settled %s even when events disagree |
| `packages/cli/test/mcp.test.ts` | 保留：cli | MCP configuration uses whole-server replacement, source-relative cwd, and parses literal prompt JSON/task |
| `packages/cli/test/memory-command.test.ts` | 保留：integration | memory management saves, corrects and deletes with auto/injection off |
| `packages/cli/test/memory-host.test.ts` | 保留：integration | a real worktree inherits project Markdown once and then diverges independently |
| `packages/cli/test/runtime.test.ts` | 保留并迁移支撑：cli | real CLI retries after a read effect and starts an independent session on restart |
| `packages/cli/test/session-host.test.ts` | 保留并迁移支撑：integration | empty startup and new sessions stay ephemeral; consumed input survives restart and resume |
| `packages/cli/test/session-preview.test.ts` | 保留：integration | preview shows six recent visible messages from the resume branch without executing or writing |
| `packages/cli/test/session-ui.test.ts` | 拆分/迁移：`packages/cli/test/session-ui-management.test.ts`、`packages/cli/test/session-ui-preview.test.ts`、`packages/cli/test/session-ui-requests.test.ts`、`packages/cli/test/session-ui-switching.test.ts` (integration) | late memory import after new cannot send to the selected session or alter its draft |
| `packages/cli/test/skills.test.ts` | 保留并迁移支撑：cli | formal CLI lists, reloads, selects and disables Skills with valid JSON and no management history |
| `packages/cli/test/startup.test.ts` | 保留：cli | CLI reports misspelled credential fields as a JSON startup error |
| `packages/core/test/agent-assembly.test.ts` | 保留并迁移支撑：integration | SDK rejects the removed execution factory before loading storage or calling a model |
| `packages/core/test/bedrock-converse.test.ts` | 保留并迁移支撑：integration | Bedrock reasoning text and redacted signature reach Forge output and Converse history |
| `packages/core/test/blocks.test.ts` | 保留：contract | core computes line hunks and aggregate edit counts |
| `packages/core/test/compaction-lifecycle.test.ts` | 保留并迁移支撑：integration | normal length output remains available when a later user asks to continue |
| `packages/core/test/context-compaction.test.ts` | 保留并迁移支撑：integration | SDK restores sourced constraints without replacing raw history; legacy=%s |
| `packages/core/test/context-http.test.ts` | 保留并迁移支撑：integration | HTTP permanent summary failure %s never retries or rebuilds |
| `packages/core/test/context-transform.test.ts` | 保留并迁移支撑：integration | projection is isolated, selected history stays durable, usage is invalidated and signatures survive |
| `packages/core/test/foundation-data.test.ts` | 保留并迁移支撑：integration | a copied pre-foundation JSONL restores through native chat, appends and reopens without rewriting source evidence |
| `packages/core/test/foundation-lifecycle.test.ts` | 保留并迁移支撑：integration | waitForIdle waits for manual compaction that is replacing an acquired invocation |
| `packages/core/test/foundation-review.test.ts` | 保留并迁移支撑：integration | an invalid mutation by afterToolCall becomes a durable tool error and permits continuation |
| `packages/core/test/incremental-session.test.ts` | 保留并迁移支撑：integration | cancellation while launching a batch saves started results but does not start later tools |
| `packages/core/test/input-ownership.test.ts` | 保留并迁移支撑：integration | ADR010: abort an acquired but unstarted iterator without model, tools or commit; reuse |
| `packages/core/test/input.test.ts` | 保留：contract | slash parser only treats a leading command as a command |
| `packages/core/test/model-auth.test.ts` | 保留：contract | explicit API key wins over ambient provider key |
| `packages/core/test/model-catalog.test.ts` | 保留：contract | Forge catalog contains only supported built-in transport models |
| `packages/core/test/model-policy.test.ts` | 保留：contract | catalog pricing chooses the highest request tier and accounts for cache writes |
| `packages/core/test/native-approval.test.ts` | 保留并迁移支撑：integration | native tool errors save their proposal before the next model request |
| `packages/core/test/native-model.test.ts` | 保留并迁移支撑：integration | summary chat rejects missing or late-failed protocol terminals and keeps partial text |
| `packages/core/test/openai-stream.test.ts` | 保留：integration | OpenAI TanStack terminal: %s |
| `packages/core/test/permission.test.ts` | 保留：contract | permission layers are independently observable and ordered |
| `packages/core/test/persistent-memory.test.ts` | 保留：integration | existing and newly written Markdown are readable across instances and scopes |
| `packages/core/test/provider-matrix.test.ts` | 保留并迁移支撑：integration | 参数化合同与公开行为 |
| `packages/core/test/provider-replay.test.ts` | 保留并迁移支撑：integration | provider thinking signatures survive session storage and replay over HTTP |
| `packages/core/test/provider-stream.test.ts` | 保留并迁移支撑：integration | every retained catalog model selects a TanStack transport |
| `packages/core/test/request-budget.test.ts` | 保留：contract | output reasoning follows provider semantics without inventing an extra budget |
| `packages/core/test/request-compaction-budget.test.ts` | 保留并迁移支撑：integration | Memory recall crosses the soft line before the task request and uses the same fixed material in compaction |
| `packages/core/test/responses-terminal.test.ts` | 保留：integration | 参数化合同与公开行为 |
| `packages/core/test/runtime-adapter.test.ts` | 保留并迁移支撑：integration | SDK uses a native TanStack adapter with the request snapshot and durable history |
| `packages/core/test/runtime-configuration.test.ts` | 保留并迁移支撑：integration | invalid Azure endpoint cannot replace the applied model configuration |
| `packages/core/test/runtime-retry.test.ts` | 保留并迁移支撑：integration | SDK task retry schedules exponential backoff and resets for a new invocation |
| `packages/core/test/runtime-session.test.ts` | 保留：integration | SDK session saves and reopens text; continuation adds no duplicate user |
| `packages/core/test/runtime-tools.test.ts` | 保留并迁移支撑：integration | SDK native image, details and progress survive storage without leaking display data to the model |
| `packages/core/test/runtime-turn-policy.test.ts` | 保留并迁移支撑：integration | policy waits for the entire persisted batch, returns pending input, and retains the completed configuration snapshot |
| `packages/core/test/sdk-bounded-checkpoint.test.ts` | 保留并迁移支撑：integration | omitted success, failure and unknown calls are retrievable without replay or foreign branch access |
| `packages/core/test/sdk-integration.test.ts` | 保留：integration | public SDK drives isolated HTTP tool loops without implicit config or file storage |
| `packages/core/test/sdk-mcp-boundaries.test.ts` | 保留并迁移支撑：integration | MCP missing environment is isolated, filters match usable snapshot, and Agents do not share disposal or permission |
| `packages/core/test/sdk-mcp-legacy.test.ts` | 保留：integration | real v1.30 SDK server interoperates over explicit legacy SSE and closes ports |
| `packages/core/test/sdk-mcp-oauth.test.ts` | 保留：integration | MCP OAuth public lifecycle: auth-required startup, verified callback, persistence, refresh rotation, logout |
| `packages/core/test/sdk-mcp-subscriptions.test.ts` | 保留：integration | MCP modern resource subscription delivers updates and unsubscribe stops the owned stream |
| `packages/core/test/sdk-mcp.test.ts` | 保留并迁移支撑：integration | MCP permission refusal sends zero resource/tool business calls; annotations do not authorize |
| `packages/core/test/sdk-memory-organizer.test.ts` | 保留并迁移支撑：integration | aborting a deferred organizer settles local waiting and blocks its late plan |
| `packages/core/test/sdk-message-codec.test.ts` | 保留并迁移支撑：integration | corrupt message blocks fail file reopening with their actual record and field location |
| `packages/core/test/sdk-native-memory.test.ts` | 保留并迁移支撑：integration | deferred memory save uses one audited model response and a new session recalls persisted Markdown |
| `packages/core/test/sdk-native-skills.test.ts` | 保留并迁移支撑：integration | official Skills load and resource tools run once through the public batch without approval |
| `packages/core/test/sdk.test.ts` | 保留并迁移支撑：integration | SDK disposal remains terminal across generated queued inputs and cancellation |
| `packages/core/test/session-conversion.test.ts` | 保留：integration | multiple compactions and branches reload in order and reject invalid retained boundaries |
| `packages/core/test/session-first-write.test.ts` | 保留：integration | new file storage stays ephemeral until append, then reloads the first input and serializes queued appends |
| `packages/core/test/session-tools.test.ts` | 保留：integration | SDK authorizes the rewritten input and sends that object on the permission bus |
| `packages/core/test/session.test.ts` | 保留：contract | session store appends valid v4 entries and branches in place |
| `packages/core/test/tool-arguments.test.ts` | 保留：contract | custom validators cannot coerce invalid input or return invalid output |
| `packages/core/test/usage.test.ts` | 保留：contract | context usage prefers the current assembly over the last call usage |
| `packages/tools/test/tools.test.ts` | 保留：integration | local tool definitions derive strict provider and execution contracts from one schema |
| `packages/tui/test/ansi.test.ts` | 保留：contract | styleToSgr covers truecolor, indexed, default and attributes |
| `packages/tui/test/app.test.ts` | 拆分/迁移：`packages/tui/test/app-input.test.ts`、`packages/tui/test/app-rendering.test.ts`、`packages/tui/test/app-requests.test.ts`、`packages/tui/test/app-transcript.test.ts` (contract) | coalesced output paints the final streamed frame and stops scheduled paints |
| `packages/tui/test/composer.test.ts` | 保留：contract | rounded border, prompt prefix and model caption |
| `packages/tui/test/editor.test.ts` | 保留：contract | insert, submit and reset |
| `packages/tui/test/entry-shell.test.ts` | 保留：contract | AC-25: every kind shares the same content start column at 40/60/80/120 |
| `packages/tui/test/focus-stack.test.ts` | 保留：contract | Tab cycles inside the top card and never escapes it |
| `packages/tui/test/fold.test.ts` | 保留：contract | AC-17: a manual fold survives streaming default updates |
| `packages/tui/test/frame.test.ts` | 保留：contract | createFrame allocates blank cells |
| `packages/tui/test/host.test.ts` | 保留：contract | start enters alt-screen and raw mode; stop restores exactly once |
| `packages/tui/test/input-router.test.ts` | 保留：contract | key owner priority is card → scrollback → composer → global |
| `packages/tui/test/keys.test.ts` | 保留：contract | mouse reports survive every byte split and do not become text or Escape |
| `packages/tui/test/layout.test.ts` | 保留：contract | layout stays non-negative and within the viewport at every locked size |
| `packages/tui/test/markdown.test.ts` | 保留：contract | headings, lists, fences, bold and italic are recognized |
| `packages/tui/test/parity.test.ts` | 保留：contract | identical dumps hash equal and compare equal |
| `packages/tui/test/present.test.ts` | 保留：contract | user entry wraps the full prompt instead of truncating |
| `packages/tui/test/projector.test.ts` | 保留：contract | AC-24: entry ids stay stable from first delta to message_end |
| `packages/tui/test/reference-parity.test.ts` | 保留：contract | each scenario dump is deterministic across two paints |
| `packages/tui/test/request-card.test.ts` | 保留：contract | AC-12: five request kinds share the same action contract |
| `packages/tui/test/scan-files.test.ts` | 保留：contract | scanFiles scans synchronously and filters by path prefix |
| `packages/tui/test/scroll.test.ts` | 保留：contract | follow mode pins the viewport to the end until the user scrolls |
| `packages/tui/test/theme.test.ts` | 保留：contract | all 32 semantic slots are resolvable |
| `packages/tui/test/transcript-browser.test.ts` | 保留：contract | browse group, expand a member, append a call and resize without changing the selected detail target |
| `packages/tui/test/welcome.test.ts` | 保留：contract | narrow welcome keeps the complete brand and omits explanatory copy |
| `packages/tui/test/width.test.ts` | 保留：contract | visibleWidth follows the locked width policy |
| `scripts/check-deps.test.ts` | 保留：contract | dependency check rejects the replaced execution engine even inside the model adapter |
| `scripts/context-compaction-report.test.ts` | 保留：contract | 参数化合同与公开行为 |
| `scripts/live-probe.test.ts` | 保留并迁移支撑：integration | live probe refuses missing/invalid explicit target and budgets before any request |
| `scripts/release-policy.test.ts` | 保留并迁移支撑：contract | release inputs require a prerelease version, full SHA, and master dispatch |
| `scripts/tui-frame.test.ts` | 保留：contract | tui-frame dump then compare against itself is equal |
| `tests/fixtures/protocol-request.test.ts` | 保留：contract | 参数化合同与公开行为 |
| `tests/integration/cancellation.test.ts` | 保留：integration | 参数化合同与公开行为 |
| `tests/integration/lifecycle.property.test.ts` | 保留并迁移支撑：integration | generated operations drive the real SDK: ownership, cancellation, reuse and disposal |
| `tests/integration/protocol.test.ts` | 保留：integration | 参数化合同与公开行为 |
| `tests/integration/retry.test.ts` | 保留：integration | 参数化合同与公开行为 |
| `tests/loop-contract/abort.property.test.ts` | 删除参考模型自检；保留真实取消：`tests/loop-contract/abort.test.ts` (integration) | 删除 2 个仅验证 abort-machine 的自检。替代：真实 SDK cancellation/lifecycle.property + 本文件保留的 abort 回归 |
| `tests/loop-contract/native-lifecycle.test.ts` | 保留并迁移支撑：integration | tool argument preparation runs before strict validation and authorization |
| `tests/loop-contract/owned-core.test.ts` | 保留并迁移支撑：integration | owned core preserves a length-limited response without preparing or executing its tool calls |
| `tests/loop-contract/parallel-tools.test.ts` | 保留：integration | native serial tool settlement retains every result when one tool fails |
| `tests/loop-contract/steering.test.ts` | 保留：integration | native agent drains steering after the active tool turn |
| `tests/loop-contract/stop-reason.test.ts` | 保留：integration | native agent exposes every stop reason with an explicit follow-up action |
| `tests/request-bus/request-bus.property.test.ts` | 保留并迁移支撑：contract | request bus terminal outcomes are absorbing under arbitrary late input |
| `tests/request-bus/request-bus.test.ts` | 保留：contract | request bus emits a request and accepts exactly one response |
| `tests/support/controlled-tool.test.ts` | 保留：contract | undeclared or mismatched tools fail before side effects and remain failures after being caught |
| `tests/support/http-fixture.test.ts` | 保留：contract | strict HTTP replay rejects mismatched bodies and reports missing exchanges |
| `tests/support/scenario.test.ts` | 保留：contract | scenario rejects a missing request without an explicit completeness assertion |
| `tests/tui-integration/context.test.ts` | 保留并迁移支撑：cli | PTY compact uses the SDK, stays idle and never streams summary as an answer |
| `tests/tui-integration/input-ownership.test.ts` | 保留并迁移支撑：cli | 参数化合同与公开行为 |
| `tests/tui-integration/main-workflow.test.ts` | 保留并迁移支撑：cli | PTY: startup to historical tool detail, search, copy, resize and return through the real SDK |
| `tests/tui-integration/mcp.test.ts` | 保留并迁移支撑：cli | formal CLI PTY: MCP catalogs, prompt input ownership, typed elicitation, and clean exit |
| `tests/tui-integration/memory.test.ts` | 保留并迁移支撑：cli | PTY /memory saves, reads, edits and deletes without starting model work or leaving raw mode |
| `tests/tui-integration/permission.test.ts` | 保留并迁移支撑：cli | formal CLI PTY permission allow writes once, deny preserves the real file |
| `tests/tui-integration/pty.test.ts` | 保留并迁移支撑：cli | PTY: paste, permission park, resize, execute and Ctrl+C restore the terminal |
| `tests/tui-integration/retry.test.ts` | 保留并迁移支撑：cli | PTY: transient retry shows progress and successful completion without stopping the next input |
| `tests/tui-integration/session-management.test.ts` | 保留并迁移支撑：cli | real CLI PTY: empty exit, clear, new, resume, active cancellation and restart |
| `tests/tui-integration/skills.test.ts` | 保留并迁移支撑：cli | formal CLI PTY lists/reloads, completes explicit-only skill, submits once, restores failed draft and exits |
| `tests/tui-integration/tool-ui.test.ts` | 保留并迁移支撑：cli | PTY: real read calls collapse, expand individually, scroll and survive resize |

## 非测试文件与重复入口

| 对象 | 处置 | 依据 / 替代覆盖 |
|---|---|---|
| `tests/loop-contract/abort-machine.ts` | 删除 56 行参考状态机 | 仅被已删除的 2 个参考自检引用；真实生命周期不依赖它 |
| `scripts/test-headless.ts` | 删除独立入口与全局 console/cwd/env 改写 | `packages/cli/test/headless-smoke.test.ts` 启动正式 CLI，严格检查主请求与 deferred memory 请求、JSON 与退出码 |
| `.github/workflows/verify.yml` headless 步骤 | 删除重复执行 | smoke 已在 `check` 的 cli 组；保留 `test:headless` 独立命令 |
| core helpers 的 5 个共享模型文件 | 迁至 `tests/fixtures/` | 48 个 import 使用统一位置，原生 chunks/protocol 内容保留 |
| App 与 session UI 的 3 个 Input/Output 替身 | 合并至 `tests/support/app-driver.ts` | 四组 AppPort 与四组真实 SessionHost UI 使用同一 HostInput/HostOutput |
| 12 套 Bun.Terminal/UTF-8/退出清理 | 合并至 `tests/support/pty.ts` | 全部 11 个 PTY 文件复用驱动；真实终端输出由 @xterm/headless 解析，不自研 ANSI parser |
| 3 套 capture/ack | 合并至 `tests/support/pty-control.ts` | 输入 arm/consumed、resize、drain、显式布局 capture；drain 不调用 composeFrameForTest |
| App / session UI / PTY 的自写轮询 | 合并至 `tests/support/control.ts` | 有界等待含条件名和失败观察；PTY 加画面/输入/exit/signal 诊断 |
| 属性测试的分散 seed/path 规则 | 合并至 `tests/support/property.ts` | 保留各性质独立预算与固定默认 seed，支持精确 -t 复现 |
| `helpers/mcp-server.ts` | 保留 | 真实 v2/legacy MCP stdio executable；SDK、CLI、示例均有启动路径引用 |
| 协议 fixtures、10 个 cell golden | 保留 | 供应商终态、UTF-8、布局/样式的不同观察面；来源保留，未自动更新 |
| 实验 v1/v2 JSON 与冻结复算脚本 | 保留 | 当前 runner 或历史 provenance/研究文档仍引用；不是普通软件门禁，删除会破坏历史可复算性 |
| live probe / benchmark / release 脚本 | 保留 | 各自有贡献入口和测试/历史合同；真实模型/发布继续独立授权 |

## 行为加强与计时规则

- 路径：公开 list() ID 替代原始临时路径，普通/别名 × 成功/装配失败四分支保留。
- 自动 paint：App final-stream 与真实 RequestBus 终态从实际 stdout 观察；PTY 主流程、布局变化与管理结果从真实 screen 观察，布局 capture 不作为 paint 证据。
- 第二轮取消：旧 PTY 用例的 second 被详情浏览消费；现在显式返回输入框，先观察慢流，再停止并检查两条 user 记录和 raw/pending 终态。
- MCP：不把历史许可卡片当作当前卡片；回到 composer 后匹配完整 Run cancel 输入。
- 正式 CLI 输入：管理命令等待当前可编辑草稿后提交；Skills 等当前 picker 标签和补全后的草稿，不把旧目录描述当作候选就绪。
- setup / disposal：Scenario 立即持有 App、SessionHost、服务器与 PTY；provider-replay 的 first/second Agent 补齐 dispose。
- 异常退出：main-workflow/memory fixture 改用父级目录，构造失败时释放终端解析器；移除重复资源关闭，执行与框架期限为清理留出预算。
- 业务流程不使用 45/50/80 ms 采样延迟。保留 bare-Escape 的真实 25 ms 歧义计时测试；事件循环让步使用 nextTurn。
- 模型速率、工具异步交错、RequestBus timeout/期限、取消兜底等独立计时合同保留。HTTP 协议 stream gate 与控制事件继续决定进度，不假定 TCP chunk 等于 enqueue。

本轮覆盖比对与验证结果见 [重构施工记录](testing-system-redesign.md)。
