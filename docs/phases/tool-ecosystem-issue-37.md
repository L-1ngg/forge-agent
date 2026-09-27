---
doc_kind: plan
created: 2026-09-27
---

# Issue #37 工具体系收敛施工图

> 状态:已完成(2026-09-28，本地验收通过；外部未测边界见下文)。任务需求与 AC 以 [Issue #37](https://github.com/L-1ngg/forge-agent/issues/37) 为唯一真相源；架构取舍见 [ADR-026](../decisions/026-native-skills-and-markdown-memory.md)。本文件记录接口、施工批次和验收证据，不复制任务清单。

## Entry

起点 `1b369e856a0fbce9af71632351f1c7a943b3d9eb`，`master` 比 `origin/master` 领先 2 次提交；staged、unstaged、untracked 均为空。Issue 已确认 Zod、官方 `withSkills`/`memoryMiddleware`、Markdown adapter、internal/trusted、项目/个人目录和显式 `/skill` 的方向。按 [SOP](../SOP.md#改动分级)，本次大改动的 ADR 和施工图先交 operator 确认，再修改生产代码。

| 入口 | 通过条件 | 不通过时 |
|---|---|---|
| 设计 | 已于 2026-09-27 确认 ADR-026 和本图的接线、生效与删除范围 | 如关键接口证据推翻设计，先更新本图 |
| 依赖 | 锁定包公开 API 与当前 TanStack 内核兼容 | 调整版本及设计，不静默增加兼容层 |
| 现有数据 | 临时旧 Markdown 副本和 worktree 副本可读，真实用户目录不写入 | 保留原文件，修正迁移代码 |

## 接线与职责

1. `packages/tools/src/define-builtin.ts` 继续集中 Zod → `convertSchemaToJsonSchema` / `parseWithStandardSchema`；去除文件/进程工具中重复的形状检查，保留文件状态与业务失败。`read_context`、`search_context`、三个本地 `mcp_*` 辅助工具和 Markdown 工具改为 `z.strictObject` 与推导输入。`mcp_read_resource` 的 URI/模板二选一及模板展开仍保留业务校验。远端 MCP／SDK 动态 JSON Schema 继续由公共校验器处理，参数改写及 hooks 后复检和权限冻结顺序不变。
2. `session-assembly.ts` 按现有宿主 roots 创建两个官方 `skillDirectory` Source，使用 `dedupe(aggregate([...]))` 确定项目同名优先。自动来源再由官方 `filter` 排除 `disable-model-invocation`；显式输入与 `/skills` 通过同一 Source 的 `list/load`，不再依赖 Pi catalog/loader。官方 `createResourceTool` 进入公共工具集合。仅保留所需的快照展示、显式输入归属和配置收据。
3. 每次 `chat()` 以同一生效配置创建 `withSkills`、`memoryMiddleware` 和 Forge session middleware。官方 tools 经一次通用 native Tool → `HarnessTool` 接线进入 `executeToolBatch`，按注册来源赋予 internal/trusted 身份；普通工具名冲突在装配时拒绝。`beforeModel` 以最终 middleware config 构建模型请求和预算，不丢失官方 prompt/schema。官方 `execute` 仅在 Forge 批次中调用一次，原生 executor 领取按 toolCallId 保存的原生结果；失败结果不被输出 schema 伪装成成功。
4. `MarkdownMemoryAdapter` 将可信宿主绑定的 user/project 目录映射为 TanStack `MemoryScope`；thread 只关联运行，不作为长期唯一隔离键。`recall` 读取短索引与必要固定内容，附来源、作用域和参考性质，返回按需管理工具。`save` 只取本轮 user/assistant 文本与可核对的本轮会话来源，使用现有模型 adapter 独立执行一次结构化整理，按计划读写主题及短索引；无价值结果不写盘。`autoUpdate=false` 跳过整理，`injection=false` 跳过召回，显式管理保持可用。整理调用不挂载记忆 middleware，不循环保存。
5. `LongTermMemory` 保留普通 Markdown 的读/写/删除/分页/搜索及来源注释，`initializeMemoryCopy` 保留失败重试只补缺失文件；移除写入版本、操作 ID、回执、锁和临时原子替换协议及其专属测试。CLI `/memory` 继续提供可直接使用的显式管理，取消 read-before-edit 版本协议。删除旧 `ContextAssembler` 记忆投影、`MemoryTools` 专用操作/写入预算与旧 Skills scanner、formatter、loader；更新 SDK/CLI/TUI 和中英文使用文档。

## 生命周期边界

- `accepted` 表示配置准备成功；包含 Skills/Memory 变更的 `applied` 在现有 `chat()` 完结之后切换。一次响应、工具批次和官方运行快照不混用 revision。下一次运行建立新 Source 和 recall；显式 `/skill` 在消费输入时使用当时已生效来源，保留原任务与来源。
- Skills/Memory native 工具以宿主注册来源而非名称决定 internal/trusted，结果照常进入 JSONL。普通 bash/read/write/MCP 仍走权限决策；Ctrl+C 使用现有工具批次信号，官方 `save()` 无额外取消/退出协议。
- 最终预算在官方 middleware 完成注入后，以完整系统提示词、消息和工具定义检查；超限不发 provider 请求。压缩后的请求投影仍能访问当前分支原文，后续新运行可重新加载技能。
- 主运行成功时官方 `ctx.defer(save())` 整理并提交。保存失败以公开事件/回执显式报告，但不改写主任务成功；JSONL append 失败仍是权威错误并停用实例。本轮显式工具写入可供模型使用，新的自动 recall 到下一次运行才取得。

## 批次与验证

每批按 Issue 的 Testing Decisions，以公开 SDK、确定性 native adapter、临时真实目录和生产装配为主要观察边界；一条外部行为测试先红后绿，目标测试和 typecheck 随批运行。受影响 CLI/TUI 使用现有集成测试。官方 Source 未自定义，不运行 Source conformance。官方 `runMemoryAdapterContract` 要求**同一个 adapter 实例**按传入的任意 `userId`/`tenantId` 隔离；本 adapter 由宿主在每次 `chat()` 创建时绑定目录，传入的 native `scope` 只标识本次运行，因此该 testkit 的多租户前提不适用。生产绑定以真实临时目录、同 `threadId` 不同宿主的公开 SDK 测试和跨会话召回验证，不能声称通过了该 testkit。

| 批次 | 工作 | 主要 Issue AC |
|---|---|---|
| B1 | 静态工具 Zod 统一、动态 JSON Schema 及改写/权限回归 | 1, 2, 10 |
| B2 | 官方 Skills 来源、资源、显式调用与公共批次接线 | 3–5, 18–20 |
| B3 | Markdown adapter、deferred 整理、CLI 管理、旧调度/锁/回执删除 | 6–8, 14–17 |
| B4 | 最终预算、配置交错、取消/存储故障、文档和全仓回归 | 9–13, 20 |

## 实施与删除清单

- 新增 `skills/source.ts`，仅组合官方 `skillDirectory`、`aggregate`、`dedupe`、`filter` 并读取 `disable-model-invocation`；`/skills` 显示真实来源根目录，不猜测嵌套技能的文件位置。移除 Pi 来源 scanner、catalog、loader、工具包装、上游拷贝和只绑定旧扫描语义的 fixtures/tests。
- 新增 `memory/adapter.ts`，以官方 `memoryMiddleware` 调度一次独立结构化整理；`memory/store.ts` 与 `memory/copy.ts` 保留 Markdown 文件、来源注释、普通读写/搜索和 worktree 首次复制。移除旧 `ContextAssembler` 记忆投影、`MemoryTools` 自动写入预算、CAS/版本、锁、原子替换、操作回执和相应旧测试。显式管理与 deferred 整理共用 `LongTermMemory`。
- `define-builtin.ts` 将 Zod 输入同时用于 Standard Schema 解析和 JSON Schema 导出；文件/进程、上下文检索、MCP 本地辅助工具及自有 Markdown 工具迁入该路径。远端 MCP 与宿主动态 JSON Schema 仍走原动态校验器。新增 `@tanstack/ai-skills@0.1.11`、`@tanstack/ai-memory@0.2.6` 和 `zod@4.3.6` 的包依赖；不再直接依赖 `yaml`。`@tanstack/ai@0.61.0` 不升级。

## 真实模型样例

2026-09-28 使用 xAI `grok-4.6`、关闭思考、输出上限 2048、最多重试 1 次、关闭自动上下文压缩，运行 `bun scripts/memory-quality.ts --split holdout --fixture scripts/fixtures/memory-quality-v2.json --out /tmp/forge-issue37-memory-samples.json`。样例为已有 v2 场景复用，**不是新的盲测**。原始报告固定了 fixture hash `2e93bdf70996b3f8d0d8724651e83c977731f2d8eb1671f2b618db5bad83070d`、实现 hash `3c4b77f93524fa85125984d37406396f99dd7e850c9b009b158245f8d10cf943`、harness hash `e11e580cd2a884f4111c0c6260fa0800ae1d5c19b7dc6d1d813a4e1679f226e2`。样例之后修改了 Skills 解析/展示及请求预算接线，Markdown adapter、整理提示词和文件存储未变；样例不证明后续预算增量的运行结果，预算行为以后续确定性测试为准。

| 场景 | 文件与整理结果 | 人工核对的限定条件 |
|---|---|---|
| `v2-project`、`v2-user`、`v2-error` | 各写 1 个主题和短索引 | sandbox 4 次不外推 production；网络检查清单不用于法律文书；锁修复只在双条件成立时适用且仅模拟器验证 |
| `v2-authority`、`v2-auto-user` | 各写 1 个主题和短索引 | 仅记录权威文档路径，未声称修改仓库文档；先文字结论但不禁止图表 |
| `v2-inherited` | 分支新增主题并更新索引，主 worktree 文件未变 | 本分支 `jade-r4.tar` 不外推主 worktree 或 production，保留旧副本的来源限制 |
| `v2-temporary`、`v2-failure`、`v2-noise` | 各有 1 次整理，均 `skipped`，无文件 | 一次性许可、失败演练和算术噪声未固化为长期事实或成功记录 |
| `v2-repeat` | 整理 `skipped`，保留既有 2 个文件 | QA 限定和权威路径未丢失，没有重复主题增长 |

10/10 个场景的主任务成功，10 次额外整理调用共 13,937 输入 tokens、5,286 输出 tokens，目录价格估算整理费 `$0.054406`；包含基线、主任务、整理和召回的 100 个供应商请求合计估算 `$0.327378`。这些不是供应商账单。所有需要保存的 6 类场景都有后续读取和文件证据；无价值场景未写盘。部分**无记忆基线**也回答出先前细节，`v2-failure` 甚至提到另一个场景的临时路径，因此回答差异不能单独证明记忆带来的增益，跨请求污染的原因未定位；保存质量、读取路径与隔离结论以文件、公开事件和确定性测试为准。

每个批次至少反向注入一处行为失败，使对应测试变红。提交前完成 `bun run check`、`bun run typecheck:examples`、`bun run test:headless`、`git diff --check` 和 code-review；全量测试在实现末尾运行一次，修复后只重跑受影响范围与必要门禁。真实模型样例覆盖稳定偏好、项目事实、经验、限定条件、无价值及未验证猜测，记录额外调用/usage/费用；没有实际执行的供应商、macOS/Windows、长期使用不记为通过。

隔离接入探针使用发布的 `@tanstack/ai@0.61.0`、`ai-skills@0.1.11`、`ai-memory@0.2.6`，观察到一次 `recall`、官方目录/`load_skill` 注入、一次加载与续轮，以及一次 deferred `save`；`beforeTools` 预执行后原生 executor 仅消费结果，官方工具副作用计数为 1。探针位于工作区外的临时目录，不是产品验收证据；生产 SDK 与故障路径仍须按上表验证。

## 最终验收记录

| 边界 | Ran | Not run / Why | Risk |
|---|---|---|---|
| 本地软件 | `bun run check` 通过：依赖检查、源码/自动化/测试类型检查及 contract、integration、CLI 离线测试；其中 integration 369/369、CLI/PTY 14/14。`bun run typecheck:examples`、`bun run test:headless`、`git diff --check` 均通过。headless 在 Linux 验证网络隔离，并观察到主运行成功、自动记忆整理 `skipped`。受影响的定向测试按批次通过 58、13、40 项。 | 无；上述门禁在最终代码上运行。 | 离线和确定性模型测试不证明其他真实 provider 的行为。 |
| 真实模型样例 | 上述 xAI `grok-4.6` 既有 v2 场景 10/10；核对落盘主题、短索引、后续读取、跳过无价值内容及整理 usage/估算费用。 | 样例之后调整了 Skills 解析/展示和最终请求预算接线，未重新调用真实模型；该增量以本地确定性测试验证。没有新增盲测，因为复用的是已有 v2 holdout。 | 旧样例不能证明预算增量的真实 provider 运行结果；无记忆基线出现过跨请求细节污染，回答差异不能单独归因于记忆。 |
| 审查 | Spec 与 Standards 双轴只读复审均通过，没有剩余代码问题；施工图记录了样例后的改动与未测边界。 | 无。 | 审查不是运行时证据。 |
| 外部环境 | 本轮仅有上述 xAI 样例与 Linux 本地环境证据。 | 未运行其他真实供应商、macOS/Windows 或长期使用评估；长期行为需要持续使用数据。 | 其他 provider、平台和长期记忆质量仍待独立验证；不将本地验收外推到这些边界。 |

## 交付与回退

交付需满足 Issue 中本地软件 AC、真实模型 AC 的实际证据、必要检查及提交前审查；未测项逐项标明 `Ran / Not run / Why / Risk`，不得以旧 #32 的质量记录替代。仅在用户所说的验收通过后 commit 当前分支，本次不 push/关闭 Issue。回退以起点 SHA 与本次独立 diff 执行 `git revert`；Markdown 文件不自动迁移，保留原文件供旧版本读取。`autoUpdate`/`injection` 配置可独立关闭记忆行为。
