---
doc_kind: plan
created: 2026-10-01
---

# 会话交互协调器施工设计

> 状态:已实现，本地软件验收通过(2026-10-01)。中立交互包、会话容器替换、单向投影及正式 CLI 接线已完成；真实供应商、跨平台和人工体验边界仍未实测，见末尾证据。架构选择见 [ADR-031](../decisions/031-session-interaction-coordinator.md)，术语见 [CONTEXT](../../CONTEXT.md)。

## Why 与范围

起点 `83e7618`，规划开始时工作区干净。起点的 [App](../../packages/tui/src/app.ts) 约 1,080 行，集中处理执行、队列、命令、切换、请求、补全与绘制。本次将这些状态交给相应所有者，使添加管理命令或改变会话收尾规则时无需修改 App 的归属检查和资源清理清单。

operator 已确定协调器位于 App 与 SessionHost 之间，并要求 Scope/Token 自动防御迟到结果。完整交付包括协调器、作用域、正式 CLI 装配、旧路径删除、必要测试与文档；下文步骤表示施工依赖，不缩减最终范围。

按后续架构参考，本图将原来的“从 App 抽出协调器”深化为“中立业务模块 + 逐会话业务容器 + 逐会话显示容器”。新增 workspace 包有具体用途：TUI 之外的消费者无需依赖终端 package；会话切换时无需维护 App 的逐字段重置列表。四层分工不引入第二套模型循环或历史。

本图记录已获授权的施工合同与本次代码、测试和文档交付。没有创建或修改 GitHub Issue；远端规格与状态仍按 [Issue tracker](../agents/issue-tracker.md)维护。本图负责跨模块施工合同和整体 AC；未来 Issue 引用本图 AC 编号，避免复制同一标准。

## Entry Criteria

| 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|
| 方向 | 本次讨论已确认独立协调器、Scope/Token 与完整规划 | 已满足，不重复访谈已定方向 |
| 实施范围 | 明确收到实施指令；此时完整范围按本图执行 | 已获得实施授权，完整范围一起验收 |
| 起点 | 现场核对 HEAD、工作区、App/SessionHost/CLI 装配和适用 ADR | 保留其他改动，调整施工位置并记录差异 |
| 基线 | 保存本次完整 `bun run check` 的独立证据目录与测试计划 | 先定位实际失败，不通过删除用例或放宽等待隐藏失败 |
| 契约 | ADR-010 的输入、ADR-029 的归属、ADR-030 的保存合同仍适用 | 新冲突先更新设计，不采用归档的执行前保存保证 |

## 模块与状态所有权

```text
1. Host / KeyDecoder / Layout / Frame / ANSI
              ^ render plan     | semantic keys
2. App shell + PresentationSession
              ^ events/state    | intents
3. SessionCoordinator -> active SessionInteraction
       | SessionHost        | existing AgentSession / RequestBus
4. Provider adapters / tools / MCP / SessionStorage
```

新增私有 `packages/interaction` workspace，依赖只允许 `@forge-agent/protocol` 和必要内置模块。协调器、SessionInteraction、InputFlow 和 Scope 位于其中；TUI 依赖 interaction；CLI 注入真实 core/SessionHost/命令。interaction 不能 import core、tui、cli、终端 I/O 或显示库；core 不反向依赖 interaction 或 UI，headless/SDK 保持原路径。

[依赖门禁](../../scripts/check-deps.ts)已扩展至六个 package，TUI 允许集增加 interaction；interaction 的 manifest/import 和终端 I/O 均有禁止方向检查。此项定向修订 ADR-004/005 的依赖条款，保留 compositor 选择和 core/UI 隔离。

| 所有者 | 状态与行为 | 不承担的职责 |
|---|---|---|
| App shell | Host/Theme、窗口、全局 start/stop、paint 合并；一个当前 PresentationSession 引用；纯显示草稿缓存 | 逐会话字段、Agent 执行、异步查询调度、实例切换、总线消费 |
| PresentationSession | EditorState、projector/browser、卡片/FocusStack、菜单/预览缓存、viewer/selection、补全显示、反馈及显示资源 | 模型/管理任务调度、发布归属算法、Agent/RequestBus 调用 |
| SessionCoordinator | 活动 SessionInteraction 引用、切换/关闭任务、宿主调用、生命周期状态与只读输出 | 逐会话执行槽位、editor/cell、草稿缓存、完整 transcript 副本 |
| SessionInteraction | 捕获会话端口、InputFlow、前台结算、执行错误、管理/只读查询槽位、请求/MCP 订阅、pending 视图和作用域 | 终端/光标/折行、权威历史保存、第二个 Agent Runner |
| SessionHost | 实例创建、候选释放、current 提交；项目内 list/preview/import；文件身份与缓存 | 命令解析、编辑器、输入队列、审批显示 |

`InputFlow` 移至 interaction 并沿用已有策略；不重新实现 FIFO。App 的 running/runTask/compactTask/executionError/management 迁入 SessionInteraction，switchTask/switching 迁入协调器，generation 删除。savedDrafts 是显示层的纯文本缓存，不迁入业务模块；projector/选区/焦点等逐会话字段迁入 PresentationSession。

### 会话容器与单向投影

每次成功激活创建新的 SessionInteraction，捕获当次 Agent/bus；协调器将操作转交当前容器。管理/查询执行器只捕获所属容器并通过它的受控出口发布，不能在 await 后重新访问 coordinator.active。同一历史会话恢复也创建新容器身份；不保持多套后台运行的 Agent pool。

PresentationSession 从激活材料初始化原文投影和恢复草稿。App 全局字段不再平铺卡片、viewer、picker、selection、feedback 等会话状态。容器构造时登记计时器/显示资源，dispose 统一释放，成功激活的显示逻辑为“保存必要文本 → dispose 旧容器 → 指向新容器”。字段初始化属于容器创建；新增字段不修改 App 的切换流程。

准备目标期间保留旧容器：辅助发布通道关闭，前台结算仍归旧业务容器，旧显示容器保持正文/草稿并显示 switching 状态。准备失败恢复同一显示内容，但替换已失效的辅助作用域；成功后才更换两个容器。不能在工具/保存收尾前销毁必要状态。

业务 snapshot 对调用方只读，在初始绑定、领域事件及交互状态变化时由所属容器更新后统一发布；`snapshot()` 只返回最近已发布的材料，不在绘制时调用 Agent/总线/宿主读取或对账。显示状态由用户动作与有效领域事件投影。保留现有 TranscriptProjector/Browser 的缓存与 revision，不每次流事件复制完整历史。编辑器、选区和浏览位置是显示层合法状态，并不要求放进业务层。

绘制从当前业务 snapshot 和显示状态生成 frame；不能在 `visibleCard/composeFrame` 中 reconcile 请求、调用 Agent 或产生业务事件。纯布局测量/缓存可以保留，但不能改变授权、输入队列、任务和会话状态。Frame/ANSI/Host 不认识 Agent 生命周期，App 也不向核心提前写入用户消息；正式用户回显继续来自核心接受输入后的 SessionEvent。

## 协调器 Interface

以下为已实现的公共入口概览，完整结构化类型见 [contracts.ts](../../packages/interaction/src/contracts.ts)。行为和所有权不得下放回 App。

```typescript
type SubmitMode = "queue" | "replace";

interface SessionCoordinator {
  start(): void;
  snapshot(): InteractionSnapshot;
  subscribe(listener: (event: InteractionEvent) => void): () => void;
  submit(text: string, mode: SubmitMode): void;
  interrupt(): void;
  recallInput(): string | undefined;
  switchTo(id?: string): void;
  respond(response: unknown): boolean;
  reconcileRequests(): void;
  requestData(request: InteractionRead): void;
  cancelData(kind: InteractionRead["kind"]): void;
  applyCompletion(input: string, cursor: number, item: InputCompletionItem, prefix: string): { input: string; cursor: number };
  close(): Promise<void>;
}
```

- `submit` 统一分类会话命令、管理命令和模型输入。`queue` 是 Enter 的 FIFO 意图；`replace` 是 Ctrl+Enter 的停止并发送意图。`/compact` 进入相同的前台执行结算路径。
- `interrupt` 暂停自动发送，取消当前执行或压缩，按 InputFlow 恢复未处理输入；它不关闭实例、不等同于退出。
- `switchTo` 只在用户已完成目标选择或空会话丢弃确认后调用。重入拒绝；选择当前会话直接结束，不使现有操作失效。
- `respond` 是唯一向当前总线发送信封的入口；只接受当前有效且 pending 的请求。返回 false 时卡片不能显示批准成功。
- `reconcileRequests` 根据 `isPending` 对账，发布已结束请求；近期终态已淘汰时也能移除卡片。App 可在处理卡片动作前调用，绘制函数不直接操作总线。
- `InteractionRead` 只涵盖实际的 `suggestions(input,cursor) / sessions / preview(id,cached)` 三类查询。requestData 由所属 SessionInteraction 调度，结果/错误通过 data_result 事件发布；App 没有 then/catch、AbortController 或请求代次比较。无宿主返回 unavailable 状态，不能伪造空列表。
- `cancelData` 是菜单关闭、预览折叠/换候选、补全提交/焦点退出的取消意图；每类查询由会话容器持有至多一个有效操作。最新查询替代旧查询；它们全部由父作用域在切换/关闭时失效。applyCompletion 复用 Source 的同步纯替换能力，不暴露 Source/port 或 Promise 给 App。
- `close` 同步进入关闭阶段后返回同一个结算 Promise；禁止新工作，并拥有完整退出结算。

`InteractionSnapshot` 仅包含可选的当前会话 id、可选的 `hasHistory`、`phase`、派生活动状态、`hasPendingInputs` 与待发送标签、待处理请求及当前 usage。有宿主时 `hasHistory` 来自该会话的实际保存事实，不能从屏幕是否有正文推断；结算及切换边界重新读取并发布。无宿主的单实例不伪造可恢复会话 id 或保存事实，二者缺省；初始 history 仍可用于显示，但不启用恢复或空会话丢弃确认。`hasPendingInputs` 来自 InputFlow，表示排队输入或明确的 replacement；当前执行输入由前台任务事实表达，不读取编辑器草稿。`phase` 为 `active / switching / closing / closed`；执行/压缩身份留在内部，activity 从实际任务派生，不通过多个独立布尔值拼出矛盾状态。snapshot 返回调用方不可修改的材料，不暴露 Agent、RequestBus、Scope 或 Token。

`InteractionEvent` 属于中立 interaction 模块，复用已有 SessionEvent、请求信封、补全与终态类型，不写入 JSONL。它只描述交互事实与数据，不包含按键、行列、颜色、编辑器或 Frame；现有 protocol 不承载可变业务实现。只包含实际需要的通知：

| 事件 | App 行为 |
|---|---|
| `state_changed` | 更新活动/队列提示并安排 repaint |
| `session_event` | 交给现有 projector；保留输入 processed 观察的原有时点 |
| `notice` | 添加有效通知；不作为授权或待发送输入 |
| `restore_inputs` | 将给定有序文字合并到当前草稿，保留尚在编辑的内容 |
| `interaction_invalidated` | 使当前显示作用域及其子操作失效，关闭旧补全/菜单等待，保留正文与草稿 |
| `interaction_ready` | 在保留实例的切换失败后建立新的显示作用域，不重放旧结果 |
| `session_activated` | 保存原显示草稿并替换 PresentationSession；输入为新 id/history 及原会话 hasHistory，不含 EditorState |
| `data_result` | 将已确定有效的查询成功/错误结果投影为补全、列表或预览，无版本号比较 |
| `request_added / request_ended` | 创建/归档卡片及更新焦点；由 App 决定显示文案 |
| `view_command` | 执行 `clear / help / resume / quit` 等显示动作 |

订阅是同进程即时派发，不增加事件日志、重播队列或第二份历史。`start()` 在 App 订阅后绑定初始会话；单次切换先完成 current 提交，再按确定顺序发布激活事件、绑定新订阅，防止请求进入旧显示状态。事件处理中的同步重入须在启动前完成 Token/状态登记。

### 草稿与显示接线

草稿文本缓存属于显示层，协调器不读取编辑器，不注入 readDraft 回调。前台结算的 restore_inputs 必须先于 session_activated 同步投影到原 PresentationSession；激活时显示层才能归档包含返还输入的最终草稿。只缓存有历史会话的未发送文本，确认丢弃的空会话不缓存；成功恢复按 id 取回文本，失败保留原容器。草稿只驻留进程内。

PresentationSession 保留空会话丢弃确认和菜单选择；协调器 snapshot 提供实际 hasHistory/pending 输入事实。输入独立首行 `/new` 或 `/resume` 时，其他文字仍为显示草稿，沿用既有多行提交规则。菜单打开、预览或取消不停止模型；确认目标后才调用 switchTo。查询由 requestData/cancelData 驱动，UI 不维护异步执行槽位。

## Scope 与 Token

在 `packages/interaction/src/interaction-scope.ts` 实现轻量模块，封装原生 AbortController、子操作身份、有效发布及 disposer。协调器和 SessionInteraction 使用它；PresentationSession 通过私有 workspace 的 scope 子入口复用显示生命周期机制，Token 不暴露给 App 或 SDK。不建立通用 jobs 系统。

| 作用域/操作 | 生命周期 | 失效时的处理 |
|---|---|---|
| 协调器根作用域 | start 到完整关闭 | closing 禁止新工作与显示发布，结算后释放剩余资源 |
| SessionInteraction | 成功激活到释放/关闭 | 容器 owns 当前端口、队列、请求/MCP 订阅及所有交互操作 |
| 辅助交互作用域 | 当前交互有效期 | 切换开始或关闭即失效；切换失败建立新对象 |
| 管理操作 Token | memory/catalog 槽位中的一次执行 | 中止协作操作，丢弃迟到报告/结果/错误；仅释放自身槽位 |
| 前台执行 Token | 一次 runTurn 或手动 compact 到结算 | 保留处理回执和已得结果；停止后必须等待结算 |
| 查询 Token | 一次补全/list/preview 查询 | SessionInteraction 自动替代/取消，结果通过有效出口发布 |
| PresentationSession 显示作用域 | 对应当前激活的显示容器 | 清除显示计时/剪贴板反馈及订阅，不控制 Agent 或查询调度 |

作用域进入失效状态必须先于 abort/disposer，以应对 abort listener 同步触发回调。每次执行入口在调用 work 前登记对象 Token；有效发布需要作用域仍有效且槽位仍拥有同一个对象。A → B → A、失败后重试以及同名操作都不复用身份。

统一入口封装 `work / report / success / error / finally`。调用方提供业务实现和有效结果处理，不手工检查 `generation`、版本号或 token。同步抛错、忽略 signal 的 Promise、迟到 reject 均被该入口消费，不产生未处理 rejection。`finally` 始终清理本次自有资源；释放共享槽位和发布状态仍需同一身份归属。

原始 work Promise 的结算与结果是否可发布分开。前台任务保留真实事件流/result 的结算 Promise，不能使用提前完成的取消竞争 Promise 代替它；processed 与存储结果先进入内部输入/结算处理，再决定是否向 App 发布。辅助操作失效即解除本地槽位，关闭不等待其原始 Promise，但其后续错误与自有资源清理仍被消费。清理中的一个异常不能阻止其他 disposer 执行，必须结算的错误交给关闭/切换等待路径报告。

支持两种实际策略：管理 memory/catalog 槽拒绝重复；三类数据查询和纯显示复制反馈以新操作替代旧操作。UI 将预览折叠/换候选、菜单关闭、补全焦点退出/提交翻译为 cancelData，不执行异步清理算法。反馈计时器是显示 disposer，不迁入业务策略。终端剪贴板是显示层效果，原始 Host 请求可能无法撤销；只保证旧容器不再发布反馈。

显示容器的 suspend/resume/dispose 由 interaction_invalidated/interaction_ready/session_activated 和关闭驱动；成功切换不逐字段清理。SessionMenu 的选择/展开及最多 20 项预览缓存保留在容器内，关闭菜单释放它；删除数字异步 revision。查询操作绑定原会话容器与候选，fold/close 的意图取消对应查询，无需 App 比较版本。

辅助作用域失效不等于销毁当前会话绑定。前台执行在目标准备期间继续归属于旧会话，允许协调器接收 processed 回执及必须结算的事件；不会因管理命令被取消而丢失。成功切换完成后，旧绑定的任何事件都不能进入新界面。

### 取消与等待

| 工作 | 切换开始 | 目标准备成功 | close |
|---|---|---|---|
| memory/skills/mcp 管理回调 | 立即失效并传递 abort | 不等待不合作回调；有效结果不能再触发执行 | 同样不等待 |
| 补全/list/preview | 业务容器的辅助作用域失效 | 查询结果不再发布 | 不等待不合作读取 |
| 显示计时/复制反馈 | 显示容器 suspend | 成功后 dispose 旧显示容器 | dispose 并清除计时/订阅 |
| 当前 Invocation/手动压缩 | 暂停自动续发，保留结算通道 | abort 后等待事件流与权威 result、保存及清理 | abort 并等待 |
| 请求/终态/MCP 订阅 | 仍绑定旧实例，切换期间拒绝 UI 答复 | 旧实例释放后解除，再绑定目标 | 关闭总线/释放实例后解除 |
| 候选实例与宿主切换 | 不另建候选管理层 | SessionHost 提交或释放候选 | SessionHost 标记关闭，等切换清理候选 |

不新增切换期限、强制丢弃工具或存储 Promise。任意工具可能延长结算；这沿用现有 SDK 合同。辅助回调即使不合作也不能延迟 App 停止。失效阻止发布与开始下一项操作，不代表撤销已开始的文件 I/O、配置应用、剪贴板请求或外部副作用。

## 关键工作流

### 输入、停止与压缩

Enter 空闲时启动一次 Invocation，活动时按 FIFO 排队；Up 在空编辑器中取回队尾。以现有用户消息事件观察 processed，不能在 scope 失效时将已处理输入当成未处理输入恢复；权威结束继续取 `turn.result`，不从模型或 UI 状态推断。

普通停止暂停自动发送，等待取消收尾后返还未处理输入及队列；收尾期间用户新输入继续保留。Ctrl+Enter 记录一个明确的 replacement，停止当前工作并等待，收尾成功后只自动发送该 replacement，其他输入返还草稿。重复 replacement 的保留顺序沿 InputFlow；存储/执行结算失败时全部保留，不自动继续。

`/compact` 暂停队列并停止当前执行，等待其结算后调用已有 `port.compact`；完成后不自动发送旧队列。压缩和 Invocation 共用单个前台任务所有权。压缩期间的停止或指定重发也等待当前压缩结算，不启动并发 runTurn。具体核心摘要和模型循环不迁入协调器。

### 切换

1. 同步确认不是当前会话、不是重复切换、也未进入关闭；App 已处理空会话丢弃确认。
2. 协调器进入 switching，使辅助作用域失效，暂停自动发送，并发布显示失效事件；此时不 abort 当前前台任务。
3. 调用现有 `SessionHost.switchTo(id, beforeRelease)`，由宿主验证并准备候选。
4. 宿主进入 `beforeRelease` 后，协调器检查仍允许切换，停止前台任务，等待 runTurn/compact 结算及已得结果保存。结算失败拒绝回调，宿主释放候选。
5. 将未处理输入同步投影回原显示容器，记录原会话实际 hasHistory；业务模块不读取或保存编辑草稿。
6. 宿主成功释放旧实例并提交 current；协调器 dispose 原 SessionInteraction 并指向新容器，发布激活材料后启动新订阅。显示层归档必要草稿文本、dispose 原 PresentationSession 并指向新容器；字段初始化由新容器负责。
7. 准备失败时，旧前台任务继续按原 SDK 生命周期结算，队列保持暂停，App 保留草稿与历史；创建新的辅助/显示作用域。旧管理结果永远无效。
8. 保存或实例释放失败时不自动重试、不自动续发；沿现有错误报告和实例停用合同保留输入。新建/恢复后不重放旧工具。

仅 `SessionHost` 能提交当前实例。协调器不复刻 prepare/commit/candidate-release；继续使用 beforeRelease 完成顺序协调。构造失败、保存失败与释放失败按不同观察点记录，不能把任何失败统一描述为“旧实例仍可继续使用”。

### 退出与切换竞争

`close()` 的同步前缀进入 closing、失效辅助/显示作用域、暂停输入并 abort 活动工作。App 随即停止 paint、恢复终端，再等待协调器 Promise，避免不合作工具让终端持续处于 raw mode。

有 SessionHost 时立即启动其 dispose，使宿主先标记 closed，阻止准备中的候选提交；同时结算前台任务。beforeRelease 不得等待正在等待自身的宿主 dispose。等待这两个分支及切换结算后销毁业务容器和根作用域。App dispose 当前显示容器及进程内草稿缓存。无 SessionHost 时关闭注入总线并等待当前任务，保持单实例接入。

App.stop 和协调器 close 均幂等；CLI finally 中重复调用 SessionHost.dispose 仍安全，必要时为现有宿主 dispose 保存同一个 Promise。退出错误须被 App/CLI 的等待路径观察，不能以 finally 返回成功或未消费 rejection 隐藏。关闭后不可再次 start；首次启动失败也走同一清理路径。

### 管理命令与正式 CLI 接线

保留固定命令集合。`/mcp use-prompt`、`/mcp use-resource` 与 `/skill` 仍由已有 `prepareInput` 形成 AgentInput，不能被管理分类截走；不新建通用命令注册框架。`/clear` 只清显示，不能失效会话、取消执行或重置队列。

保留 AppOptions 的现有命令字段及参数顺序，增加末尾捕获会话上下文：MCP/Skills 为 `(input, report, signal, session)`，Memory 为 `(input, signal, session)`。捕获上下文仅要求 readonly port/requestBus 及可选 sessionId，不要求 hasHistory。原有少参数替身仍可使用；生产回调全部使用传入 session，而非动态 `sessions.current`。有宿主时从当时绑定的会话视图捕获；单实例从注入的 port/bus 建立固定内存绑定，不伪造可恢复会话。协调器给出受控 report 和取消信号，接收命令结果；有 `prompt` 时由同一 Token 检查后进入正常输入调度。

CLI 的 MemoryManager 配置应用回调必须绑定启动时的 port；可为 `execute` 增加本次调用的 signal/apply 上下文，复用原 store 和命令实现。`auto/inject` 只有有效操作完成后才更新进程设置；已经开始的配置应用不承诺撤销。import 返回历史材料之前、配置应用及每项新的本地写入开始之前检查 signal，不增加事务、重试或额外磁盘恢复机制。

MCP 的 `mcpCommand` 已有 signal 入口，正式接线必须传入；持久 enable/disable 的下一阶段使用捕获 controller，配置写入完成后再次检查 signal，避免接着操作新的实例。Skills reload 捕获 port，取消后不开始下一项刷新/发布；正在等待的 applied 可继续结算，但不再发布。

补全 Source 在 SessionInteraction 建立时创建/捕获 port；AppOptions 增加按会话创建 Source 的可选 factory，已有固定 Source 单实例用法保留。Source 的结构化类型定义在 interaction，仅使用 protocol 补全数据；getSuggestions 复用 core 已有 options.signal。调用 Promise 与有效结果判断在业务容器内，App 只提交请求及执行同步 applyCompletion。listSkills 和 MCP completions 使用捕获实例，文件扫描仍用显式 cwd。

### 请求与 MCP 事件

协调器为每个有效会话绑定各启动一个请求/终态消费者及一个 MCP 订阅。失效的旧消费者不能关闭新协调器。关闭、切换失败和旧错误都以绑定对象判断，不通过全局数字 generation。

卡片 parked/focused、文本编辑、动作选择与 bodyOffset 属于 PresentationSession，App 仅接线用户动作。协调器只保留当前 pending 请求材料，答复前检查归属并调用当前总线 respond。成功后只结算一次，拒绝答复保持 pending；原生总线终态到达时清理显示。缺失近期终态不表示重新 pending，以 `isPending` 为权威，保留通知淘汰后的主动对账与自动 repaint。

保持 AppRequestBus 可选诊断方法的现有替身兼容。真实生产路径使用完整 RequestBus；没有 isPending 的替身只证明有限交互行为，不用于 pending 淘汰保证。MCP 订阅回调捕获会话绑定，解除订阅后到达的旧回调不能污染目标会话。

## 文件处置

| 路径 | 处置 |
|---|---|
| `packages/interaction/{package.json,tsconfig.json}`、`src/index.ts` | 新增私有 workspace；沿用版本、Bun/TypeScript 和 build/typecheck 约定，只依赖 protocol；不发布 npm |
| `packages/interaction/src/contracts.ts` | 中立结构化端口、捕获会话上下文、只读 snapshot 和事件；CLI 工厂保留具体 Agent 类型 |
| `packages/interaction/src/session-coordinator.ts` | 新增协调器，只拥有活动容器选择、切换/关闭和宿主调用 |
| `packages/interaction/src/session-interaction.ts` | 新增逐会话业务容器，拥有输入/前台任务/管理查询/订阅/作用域；无终端知识 |
| `packages/interaction/src/interaction-scope.ts` | 共享 Scope/统一操作入口；Token 私有，显示层仅通过 scope 子入口复用生命周期 |
| `packages/interaction/src/input-flow.ts` | 从 TUI 移动现有输入策略，保持行为；删除原文件而非复制双份 |
| `packages/tui/src/presentation-session.ts` | 新增逐会话显示容器及 factory，拥有 UI 状态、投影和显示资源；dispose 统一释放 |
| `packages/tui/src/app.ts` | 保留终端外壳、动作接线和一个显示容器引用；移除平铺字段/调度/切换清理清单 |
| `packages/tui/src/session-menu.ts` | 保留显示和 20 项缓存；查询/取消意图及有效结果经显示容器接线，不保留操作身份或数字归属检查 |
| `packages/tui/src/index.ts` | 沿用现有 App 类型导出；中立契约类型从 interaction 引用，不从 App 反向引入业务包 |
| `packages/cli/src/main.ts`、`interaction-options.ts` | 正式命令/补全工厂接线，捕获会话并透传 signal，保持 headless 路径；工厂可通过真实 SDK/App 独立验证 |
| `packages/cli/src/{memory-command,skills-command,mcp-command}.ts` | 有需要时添加协作取消/调用上下文；复用现有命令逻辑 |
| `packages/cli/src/session-host.ts` | 保留准备/提交算法；必要时补 dispose 幂等，避免迁入交互调度 |
| `packages/interaction/test/{session-coordinator,interaction-scope}.test.ts` | 中立模块公开行为与 Scope 能力；包含不依赖 TUI 的数据消费者，登记 suites |
| `packages/tui/test/presentation-session.test.ts` | 显示容器替换、草稿归档、资源生命周期和纯投影合同 |
| `packages/cli/test/interaction-options.test.ts` | 验证正式命令工厂在真实 SDK/SessionHost/App 中捕获 MCP/Skills/Memory 实例与取消边界 |
| `packages/tui/test/app-*.test.ts`、`packages/cli/test/session-ui-*.test.ts` | 保留外层输入、显示与真实装配证据；请求淘汰观察点改为实际 stdout，新增退出竞争及宿主重入回归 |
| `scripts/check-deps.ts`、`scripts/check-deps.test.ts` | 增加 interaction package 和允许方向；反向注入 core/tui/cli/终端依赖必须失败 |
| `packages/tui/package.json`、`packages/cli/package.json`、`bun.lock` | 加入 workspace interaction 直接依赖并更新既有锁文件；不升级第三方包 |
| `scripts/test-plan.ts`、`tests/support/app-driver.ts`、周边 App fixtures | 登记新 suites，更新职责说明与接入；沿用 runner/Scenario/控制 helper |
| `README.md`、`README.zh-CN.md`、`AGENTS.md`、ADR-004/005 状态行 | 同步真实六包架构、所有权与依赖指针 |
| 本图、ADR-031、CONTEXT、当前导航 | 补本次证据与状态；必要时给旧施工记录增加定向后续入口 |

类型从 app.ts 迁至 interaction，App 原类型名通过 type re-export 保持接入。SessionMenu 使用中立 SessionSummary/SessionPreview；业务包不能反向 import 显示模块。CLI 工厂保留具体会话端口的类型信息，不复制完整 SDK Agent interface 或用 any/断言扩张能力。PTY 辅助函数仅要求 `composeFrameForTest`，不约束具体 App 端口类型。

删除标准：App 不直接调用 port/sessions/requestBus，也不执行补全/list/preview Promise；不保留 manage/invalidateManagement/beginSwitch/runTurn/consumeRequests/consumeTerminals 的旧实现。删除 generation/suggestionVersion/menuVersion/copyVersion 及手工比较；Token 不进入 App 分支。逐会话 UI 字段迁入显示容器，成功切换不再逐字段赋空值。保持原有显示/焦点行为，不创建第二份 InputFlow、历史或 Agent 循环。

## 施工顺序

1. **固定行为基线**：运行当前完整门禁，记录既有测试与合同；将后续 AC 映射到稳定观察点。保留代码，没有先删实现的窗口。
2. **中立模块与作用域**：创建 interaction 包/门禁，迁移 InputFlow，建立 SessionInteraction 和统一管理入口，正式 CLI 捕获会话；真实迟到操作覆盖结果、错误、finally 和目标实例。
3. **前台调度与切换**：建立协调器的活动容器、runTurn/compact 和 beforeRelease 顺序；覆盖准备失败、保存失败、退出竞争，不迁入权威历史。
4. **显示容器与投影**：建立 PresentationSession，把平铺字段及资源转为容器所有权；迁移请求/MCP 对账和三类读操作调度，完成容器替换及显示层草稿缓存。
5. **删除与整体验收**：清除旧状态/分支，保留外层公开行为回归，完成正式 CLI/PTY、类型/依赖门禁、文档与完整结果报告。

这些步骤最终一起交付；不能在仅完成抽取或 Scope helper 后宣称完成。本轮不安排工期、故事点或并行共享文件修改。

## Acceptance Criteria

以下为本图独有的整体标准，未来任务规格引用 AC-SC 编号。勾选表示本次本地软件范围通过；AC-SC-12 的真实供应商、跨平台和人工体验仍按末尾证据单列未测，不扩展本地结论。

- [x] AC-SC-01: App 的执行/管理/切换/订阅状态及旧方法按删除标准迁出；协调器不持有所有逐会话业务字段，SessionInteraction 没有 editor/cell/布局依赖，六包依赖检查通过。
- [x] AC-SC-02: 新增一个管理命令实现仅接入统一入口；不需要新增 App 的归属比较、切换清理或结果启动执行分支。生产命令和补全在启动时捕获实例。
- [x] AC-SC-03: Enter FIFO、Up 取回、普通停止、Ctrl+Enter、准备输入失败、processed 返还和结算错误均保持顺序、无丢失、无重复及无错误自动续发；压缩与 Invocation 无并发启动。
- [x] AC-SC-04: 切换先准备目标，准备失败不主动 abort 原任务；工具/保存清理完成前不提交目标，失败不自动重试；选择当前会话不打断现有工作。
- [x] AC-SC-05: 辅助操作在切换开始失效，成功/准备失败/返回同一会话后迟到结果、错误、进度及 finally 都不能污染当前交互或释放新槽位。
- [x] AC-SC-06: 忽略 signal 的管理回调不能延迟 close；旧执行及已开始工具必须等待结算；重复关闭、启动失败和准备/释放期间退出均完整释放候选及订阅，终端恢复且没有未处理 rejection。
- [x] AC-SC-07: 真实 CLI 装配的 MCP/Skills/Memory 在延迟期间切换后只使用捕获的实例；取消后不开始下一项操作，已开始外部效果按非事务边界报告。
- [x] AC-SC-08: 原生请求只被显式动作答复一次；旧请求不能命中新总线，停放/浏览/复制不授权；近期终态淘汰及消费暂停后实际 stdout 自动显示卡片结束，无额外输入或测试帧查询。
- [x] AC-SC-09: 补全替换、提交/焦点退出、菜单关闭/重开、候选变化、预览折叠、旧复制反馈在切换或关闭后均不恢复旧显示；预览只读、20 项缓存及草稿/历史恢复行为保持。
- [x] AC-SC-10: 有/无 SessionHost 的 App 接入均通过；headless/SDK/JSONL/唯一 TanStack 循环和恢复不重放行为保持，既有相关回归仍覆盖生产路径。
- [x] AC-SC-11: 必要 suites 正确登记且各有合同归属；迁移测试有去留及替代映射。Test Plan 所列五类反向验证均变红，恢复实现后对应公开行为用例转绿。
- [x] AC-SC-12: 本地完整 check、headless、examples、build、diff 与文档链接检查通过；真实 CLI/PTY 覆盖关键交互并记录实际结果。真实供应商、跨平台和外层终端人工体验按实际执行单列边界。
- [x] AC-SC-13: 一个只依赖 interaction/protocol 的数据消费者能提交、停止、切换并接收只读事件/snapshot；测试不加载 TUI/终端模块。反向注入 interaction → core/tui/cli 或终端 I/O 时门禁变红；全部 workspace 类型/build 与新 suites 登记通过。
- [x] AC-SC-14: 成功激活通过业务/显示容器替换完成，App 没有会话字段重置清单；准备失败保留草稿/历史但旧操作不复活。反复渲染同一状态不调用 Agent/总线/宿主、不改变队列/授权/任务；旧容器回调不能修改新显示，原文回显仍由核心事件产生。

## Test Plan 与 Verify

| 层 | 用例与观察点 | 复用/处置 |
|---|---|---|
| contract | Scope 替换/父失效；中立协调器/会话容器的输入顺序、结算和答复；显示容器替换及只读渲染 | 使用已有受控 Promise/scriptedTurn/端口替身；不读取私有字段或伪造另一套模型 |
| integration | App + 真实 SessionHost/SDK/存储 + 本地 HTTP；管理迟到、A → B → A、准备失败、保存失败、作用域有效结果、MCP 回调 | 复用 session-ui-management/switching/requests/preview；添加装配捕获实例与取消边界回归 |
| cli | 正式 CLI + 真实 PTY：FIFO、Esc、Ctrl+Enter、compact/new/resume、待审批切换、退出恢复 | 复用 tests/tui-integration 的驱动与现有 fixtures；观察实际输出和请求/文件效果 |
| structure | App 删除/容器替换、interaction 的独立消费者、生产 callback 捕获 current、依赖与测试分组 | 更新已有 check-deps/test-plan 及故障注入；不新建通用架构框架 |

Scope 套件只验证共享机制独有能力；业务用例通过协调器/真实 App 接口验证，不按内部方法逐个复制。本次保留全部既有 App suites：它们继续覆盖按键到业务事件再到显示的接线；新增中立套件单独验证调度和归属，防止外层替身掩盖业务依赖。Scenario、barrier、waitFor、bounded 和 scriptedTurn 继续复用，不新建第二套测试 harness。

| 原合同/观察点 | 本次归属及处置 |
|---|---|
| `app-input`、`input-ownership`、CLI/PTY 队列与停止 | 既有 suites 保留；中立 `session-coordinator` 新增事件流/result 等待、压缩和 replacement 验证 |
| `session-ui-management` 的迟到命令与失败切换 | 既有真实装配回归保留；Scope 验证通用进度/error/finally，协调器验证 A → B → A，正式命令工厂验证捕获实例 |
| `app-requests`、`session-ui-requests` 的审批与终态 | 既有 suites 保留；淘汰后取消显示改为释放通知消费者并观察实际 stdout，不借绘制触发业务对账 |
| `app-rendering/transcript`、`session-ui-preview` | 既有显示/菜单/预览测试保留；`presentation-session` 新增纯渲染和容器替换后的复制反馈/草稿验证 |
| `session-ui-switching` 的准备/保存顺序 | 既有 suites 保留，新增准备目标后的退出竞争和同步 abort 重入宿主释放 |
| `check-deps`、`test-plan` | 更新六包 fixture 和 suite 登记；禁止方向 fixture 与实际故障注入共同验证 |

反向验证覆盖原三类行为及新增依赖/渲染约束，临时注入后对应测试必须变红，再恢复修改：

1. 允许失效管理 Token 发布 prompt 或释放新槽位，真实迟到命令测试失败。
2. 跳过 beforeRelease 的执行/保存等待或在准备前 abort，切换顺序与文件证据测试失败。
3. 让旧请求/MCP/显示操作绕过作用域发布，旧卡片答复或迟到界面测试失败。
4. 给 interaction 引入禁止的 core/tui/cli/终端入口，现有依赖门禁测试失败；不能只以新 package 的 README 声明中立。
5. 让 composeFrame 对账/启动业务，重复绘制的公开行为测试失败；恢复后与实际 stdout 自动更新用例一起通过。

实施时先运行基线；每步做定向验证。最终执行一次 `bun run check`、`bun run test:headless`、`bun run typecheck:examples`、`bun run build` 和 `git diff --check`，核对本轮独立测试证据及文档本地链接。新 suite 在 `scripts/test-plan.ts` 登记，新回归不得仅通过 helper 自检冒充真实装配证据。

无需真实付费模型验证宿主对象归属；本地 HTTP 和正式 CLI 足以给出软件行为证据。没有实际 macOS/Windows、真实 provider 或外层终端环境时，报告未测，不触发远端 workflow 或擅自使用凭据补测。

## Release 与 Rollback

完整出口为 AC-SC-01 至 AC-SC-14 的本地软件部分通过、中立模块和容器替换可观察、旧执行路径删除、测试映射与证据可核对。人工/外部环境只按实际结果记录。App 行数减少、引入 Scope 类或单独 helper 测试通过不能作为整体出口；无性能基线，不承诺速度或内存收益。

实现与验证完成后单次交付全部相关代码、测试和文档。commit、push、Issue 发布/关闭和远端 workflow 仍按用户当次明确授权执行，不从施工步骤推导授权。

各施工步骤应保持可运行且可按依赖逆序 revert；不保留双执行开关。回退只撤回本次代码/文档，不删除会话、记忆、配置或工具产生的外部效果，不回滚其他工作流。JSONL 格式未迁移，已产生历史仍由现有 SessionStore 读取。若实现中发现需要修改核心保存、SDK 或 compositor 合同，先更新本图及相应 ADR。

## Dependencies、Risk 与边界

依赖现有 Bun/TypeScript、InputFlow、原生 AbortController、结构化 SessionHost/Agent 端口和测试工具。新增 interaction 是本仓库私有 workspace 模块，不新增第三方框架或外部服务。根 workspace/build 与测试发现沿用 packages 通配符，依赖门禁的 package 清单及其测试 fixtures 已同步为六包。

| 风险 | 缓解与可观察限制 |
|---|---|
| 把所有逻辑挪进新大类，耦合仍在 | 状态所有权和删除清单作为出口；协调器只输出领域事件，不了解显示对象 |
| 名义分层但业务仍依赖终端 package | 中立 workspace 包、依赖门禁与不加载 TUI 的消费者测试 |
| 容器替换被当成忽略执行收尾 | 准备/结算/提交顺序不变；指针替换只是成功激活阶段 |
| 为不可变投影重复历史或每 token 全量复制 | 权威历史保留核心，沿用 projector revision/缓存；只读输出不要求全面 immutable 重写 |
| Scope 一次失效误丢 processed 或保存结果 | 辅助交互与前台结算分开；通过真实输入/存储和停用实例观察验证 |
| callback 动态读取 current 绕过归属 | 正式装配捕获 session；延迟跨会话用例观察实际目标实例与请求 |
| 退出等待宿主、宿主等待 beforeRelease 形成循环 | closing 同步生效，宿主 dispose 与前台结算并行启动，回调不 await 宿主 dispose |
| 事件回调同步重入启动重复任务 | 先登记 Token/切换/关闭状态再执行 work 或派发事件 |
| token/订阅/缓存无限保留 | 槽位结束即解除；根关闭清空；不保留终态 token 日志，沿用已有预览缓存边界 |
| 取消被描述成外部事务回滚 | 只保证阻止迟到发布与后续操作；已开始的 I/O/工具效果明确保留 |

明确不做：替换 TUI 框架、添加通用任务框架/事件总线产品、升级 TanStack、第二套模型循环、远程 API、持久队列、操作跨进程恢复、JSONL 格式迁移、事务补偿、新超时策略和 UI 视觉重设计。真实需求出现后另行设计。

### 架构参考的适用边界

采纳四层职责、单向投影、对象所有权和容器替换；不采纳 Scope 是安全沙箱、abort 必然强制断开所有请求、SessionScope 自建 Runner/历史或一行赋值即可完成异步切换的保证。现有 TanStack chat 与 AgentSession 继续是唯一执行循环和权威记录所有者。

业务复用的验收是中立模块独立可用，未建设 Web UI/HTTP 服务；浏览器客户端仍需要适配传输及本地文件/进程能力。模型等待取消由已有核心契约处理；不合作工具或存储仍可延长 drain，但不能串会话。连续切换重入按现有规则拒绝，不添加后台 Agent pool 或并行释放旧执行。

## 本次验收证据

环境为 Linux x64、Bun 1.3.12；测试由现有离线 runner 隔离配置与 network namespace，仅允许本地 fixture 通信。基线完整 check 的独立证据为 `.test-results/run-XOFMFw/summary.json`：contract 333、integration 619、cli 49，全部通过。

最终完整 `bun run check` 退出 0，证据为 `.test-results/run-xBSzlf/summary.json` 和同目录 JUnit：contract 348/348(55 文件)、integration 624/624(64 文件)、cli 49/49(19 文件)，共 1,021 tests，零失败、零 skipped。依赖门禁、六包类型、automation 与 tests 类型检查均通过。正式 CLI/PTY 覆盖 FIFO、停止/替换、compact/new/resume、审批与工具效果、菜单/历史/草稿和终端退出恢复。

`bun run test:headless` 退出 0，1/1 smoke test；证据为 `.test-results/run-RzSI8b/summary.json`。两个最终测试目录绑定相同可执行源码 SHA-256 `7bd60aee7ffea0a2b55969b0c0a50229bdf105e2ed54a5578b93f17a03ebcca7`，HEAD 为 `83e7618d0f9fef7012fecc0ab6be204172420f12`，包含本次未提交实现。`bun run typecheck:examples`、六包 `bun run build`、`git diff --check` 均退出 0。`.test-results` 是本地忽略的原始证据目录；此处保留可共享的结果和源码身份。

### 反向验证

五类施工图故障均逐项临时注入、观测失败并恢复；最终完整门禁在全部恢复后运行：

| 注入 | 实际失败证据 |
|---|---|
| 让 Scope 始终允许发布 | Scope 的迟到 progress/error 用例失败；真实 SDK/App 的失败切换后导入用例出现 `LATE_RESUME_IMPORT` 并启动旧 prompt |
| 在目标准备前停止旧执行 | 准备失败用例观察到 abort 1 次，合同期望 0 次 |
| 让旧订阅绕过所属 Scope | 切换后旧 MCP 回调发布 `OLD_MCP`，中立协调器用例失败 |
| interaction 注入 core import | 实际依赖门禁退出 1；禁止方向 fixture 同时覆盖 core/tui/cli、相对越界与终端入口 |
| composeFrame 调用业务对账 | 31 次绘制产生 31 次 pending 读取，合同期望 0 次 |

收尾还发现宿主 dispose 在保存关闭 Promise 前触发同步 abort 的重入缺口。新增真实宿主用例先观察到不同 Promise，修复后同一 Promise、一次实例释放和关闭后拒绝切换均通过；与准备目标后退出、显示容器回归一起 11/11 通过，并已纳入最终 integration。

**Ran**：本次基线与最终完整门禁、定向公开行为回归、五类故障注入、正式 CLI/PTY、headless、examples、build、diff；使用已有 marked 核对 10 个改动文档，239 个本地链接、29 个锚点和 14 个唯一 AC 定义全部通过。

**Not run**：真实供应商调用、macOS/Windows、外层真实终端人工体验、长期使用与性能基准；没有执行 commit/push、Issue 或远端 workflow 操作。

**Why**：软件归属与生命周期合同可由真实 SDK/存储、本地 HTTP、正式 CLI/PTY验证；本次没有安排外部凭据、模型预算、其他平台或人工环境。

**Risk**：Scope 保证失效后不发布及协作取消，不能撤销已开始外部副作用。必须等待的工具/保存 Promise 仍可能延长结算；本次不承诺性能改善、Web 服务能力或跨平台体验通过。AC-SC-12 的外部边界仍为未测，不因本地软件通过改写为已验证。
