---
doc_kind: plan
created: 2026-09-05
---

# 通用内核与 SDK 边界

> 状态:代码与自动化验证完成,已提交 `04db82b`(2026-09-06),包含 ADR-010 输入归属与取消修复;人工交付审核仍待确认。接入说明见 [SDK](../sdk.md)。

## Why

落实通用 Agent 路线的第二批。立项时 CLI 自行装配 SessionStore、RequestBus、权限与 pi-port,AgentRunner 直接依赖具体 JSONL 存储。外部宿主需要重复这套装配,也没有明确的释放与失败后复用契约。

保留自研 ExecutionCore,不增加第二套执行逻辑。SDK 是单 Agent 的宿主接入层,不是 Team 编排器或服务框架。上位决策为 ADR-008 与 ADR-009。

后续 review 的输入归属、执行干预与提交边界方案见 [ADR-010](../decisions/010-input-ownership-and-interruption.md)。其决策状态以该文件为准,此前自动化证据不代表该方案已实现或已验收。

## Entry Criteria

| 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|
| 内核基线 | 开工前重新运行 bun run check;上一批记录为 249 pass | 先修复替换回归 |
| 依赖边界 | 无 pi-agent-core;pi-ai 仅位于模型适配边界 | 不绕过依赖门禁 |
| 设计审核 | operator 确认本施工图的生命周期与存储失败策略 | 暂停实现,调整施工图 |

## What

### 1. 宿主接入层

路径:新增 `packages/core/src/agent.ts`,当前导出为 `@forge-agent/core/sdk`(ADR-011 更名),保留仓库内部导出。

接口名称与语义:

- `createAgent(options): Promise<Agent>`:显式传入 provider/model、已解析凭据、systemPrompt、cwd、工具和权限配置;不隐式加载配置文件、环境变量引用或执行 secret command。
- `runTurn(input): AgentTurn`:仍为单消费者 `AsyncIterable<SessionEvent>`,附带只读 `id: symbol`,同实例一次只运行一个 invocation;同时运行直接拒绝。
- `steer(input, expectedTurnId)` / `followUp(input, expectedTurnId): InputAcceptance`:两条 FIFO 只属于当前活动执行;SDK 必须匹配事件流的 `id`,未启动、结束、取消或过期调用返回 `{ accepted: false }`。
- 接受时返回 `{ accepted: true, processed: Promise<boolean> }`。内核在输入加入下一次模型请求上下文时确认 `true`,未处理而关闭时确认 `false`;确认不等于模型完成、存储成功或工具副作用回滚。宿主保留原文直到确认,仅恢复 `false` 的输入,不按文本匹配去重。
- `abort(): void`:取消当前 invocation,实例可在清理结束后复用。
- `getUsage()`:返回现有 usage 真相点。
- `dispose(): Promise<void>`:幂等;先拒绝新输入,取消并等待活动模型/工具与请求总线清理,清空队列;释放后执行或入队明确报错。
- `requests` / `respond(response)`:暴露自有协议请求流与响应入口,不暴露 pi 类型。请求流与执行事件分离,复用当前 RequestBus,不新增 callback 和 subscribe 双机制。

模型选择复用 pi-ai,公共签名只包含自有类型。SDK 不预装 coding tools 或 coding prompt。CLI 的默认工具、read 自动许可与提示词仍由 CLI 显式传入。

权限默认保守:未明确允许的调用需要授权,缺少响应按有限超时拒绝;不可因宿主没启动 TUI 而自动放行。交互 CLI 可显式使用无限等待。权限记忆与请求总线默认每实例独立,不共享可变单例。

### 2. 会话存储契约

路径:新增 `packages/core/src/session-storage.ts`,修改 `agent-runner.ts`;现有 `session-store.ts` 适配契约但不改 JSONL v3 格式。

最小契约为 `load(): Promise<SessionMessage[]>` 与 `appendTurn(messages): Promise<void>`。存储由宿主提供,省略时使用实例内存存储;不把 branch、搜索、文件路径或 SessionHeader 纳入 SDK 必选契约。`load` 在创建时调用,明确一个活动实例独占同一会话写入,不承诺跨进程并发安全。

存储适配器负责一次 appendTurn 的事务与失败恢复;SDK 不替数据库实现事务,也不假设抛错意味着底层完全没有写入。失败时向消费端抛错并使实例进入不可继续执行状态,要求宿主检查实际提交状态后重新创建并重载会话,防止模型上下文与持久化内容静默分歧。现有 JSONL append 的部分写入故障不具备事务保证,本批不改为数据库或重写文件存储。不能假装工具外部副作用已回滚。

执行事件中的 agent_end 表示模型/工具执行终止,不代表存储提交成功;只有 runTurn 正常迭代完成才表示整个调用完成。提交开始前的错误、取消与提前关闭不持久化。appendTurn 已开始后必须等待结算,不承诺取消或回滚写入;失败停用实例。

### ADR-010 施工契约

- 内核在最后一次队列检查到发出 agent_end 之间同步关闭接收,所有终止路径结算未处理确认;不能靠宿主消费缓冲事件的时间判断可接收性。
- SDK 在 iterator 占位时记录取消状态;首个 next 前 abort 后,iterator 只会完成,零模型/工具/提交,释放占位后可复用。旧 iterator 的关闭和旧 id 都不能影响新任务。
- TUI 保留现有跨 invocation FIFO,不新增自动 steering。队列原文在 transcript 底部显示;空输入框按 Up 取回队尾编辑。普通 Esc 恢复队列到草稿并暂停续发,保留已有草稿。权限卡片 parked 状态的 Esc 行为不变。
- Ctrl+Enter 等旧任务收尾,只自动发送指定输入,旧队列恢复草稿;提交失败或模型错误停止续发并保留待发内容。停止等待期间的新输入仍保留,不会暗中续发。
- 当前 composer 仅支持文本,恢复按原顺序用空行连接,保留所有原文;不增加附件或持久队列。已有处理的输入不恢复。提交失败时当前已执行内容保留在 transcript,待发送内容保留在 composer。
- 验证分为 SDK/内核故障注入、TUI 状态回归、真实 PTY 输入/终端恢复与完整检查;回滚按本次差异恢复 API 和宿主行为,不改变存储格式。

### 3. CLI 与宿主示例

路径:修改 `packages/cli/src/main.ts`,按需要调整 headless 与 PTY fixtures;新增 `examples/embedded-agent.ts`。

CLI 保留参数解析、配置/secret 加载、JSONL 选择与 UI 装配,改用 createAgent;在 finally 中 await dispose。CLI 与 SDK 的差异仅为宿主装配,不是执行流程。测试注入点保持内部使用,不为了 fake provider 扩大公共模型接口。

示例使用自定义无副作用工具与内存存储,不导入 CLI/TUI、不读取项目配置、不创建会话文件。明确 Bun 支持范围;对外 npm 发布与 Node.js 兼容暂不承诺。

## Batches

1. 存储接口与提交失败回归:先使 AgentRunner 脱离具体 SessionStore。
2. SDK 工厂与生命周期:接入请求总线、实例隔离、释放和失败状态。
3. CLI 迁移与示例:统一装配入口,文档与全套回归收口。

## Acceptance Criteria

- [x] AC-SDK-01:最小宿主仅依赖 SDK、tools/protocol 自有契约,完成自定义工具循环;不启动 TUI、不创建 JSONL。
- [x] AC-SDK-02:自定义存储恢复历史,签名保留;提交开始前的错误、取消和提前关闭不提交;正常调用恰好提交一次,已开始的提交等待结算。
- [x] AC-SDK-03:注入存储失败后 runTurn 抛错且拒绝继续执行,重新创建实例可从存储恢复。
- [x] AC-SDK-04:dispose 在空闲、未启动 iterator、模型流、工具执行、权限等待及提交期间均幂等收尾;无遗留 waiter/timer;释放后拒绝执行和入队。
- [x] AC-SDK-05:两个并行实例的上下文、工具、权限、队列、usage 和取消互不串扰。
- [x] AC-SDK-06:CLI/headless/PTY 通过同一工厂,既有退出码和交互回归通过。
- [x] AC-SDK-07:SDK 公共声明无 pi 类型,无隐式配置读取或 coding 默认能力;依赖门禁、typecheck、完整测试通过。

出口为上述 AC 全部通过并报告 Ran / Not run / Why / Risk。一次真实文本回答不代替生命周期与存储故障验收。

## Test Plan

| 层 | 覆盖 |
|---|---|
| 契约测试 | 异步内存存储、提交失败、恢复签名、权限默认拒绝、生命周期 |
| 属性测试 | 取消/释放与队列操作的终态和实例隔离 |
| 集成测试 | 同一工厂驱动 CLI JSON 与 PTY,本地 HTTP 模型重放 |
| 宿主示例 | Bun 类型检查与 faux/本地 HTTP 无凭据自动化验证;真实 provider 受控烟测 |

反向验证:临时移除 dispose 的取消传播或存储失败保护,对应测试必须失败;随后恢复代码再运行完整检查,记录具体证据。

## 明确不做

不增加 Run/Step、checkpoint、预算、Skills、MCP、调研工具、Team、远程 API、npm 发布或 TUI 美化。这些不作为本批出口。

## Rollback / Risk

保持五包结构与会话格式不变。批次提交须由 operator 另行授权;回退时连同 CLI 工厂接入恢复,不加入永久双执行路径。

同进程工具必须配合 AbortSignal,dispose 不承诺强制终止不合作的宿主代码。自定义存储的事务正确性由宿主负责;工具副作用不随会话回滚。示例与文档必须显式说明这些边界。

## Evidence

### ADR-010 修复

- 提交验证(2026-09-06):`04db82b`,tree `25b6aaf7c09393abac4c44519abbaed6df2a8eff`;在独立暂存快照执行 `bun install --frozen-lockfile`、`bun run check`(290 pass / 0 fail)及示例/PTY fixture 的严格 TypeScript 检查,均通过。未重跑远程供应商请求。
- Ran:`bun run check`,290 pass / 0 fail,50 个文件;AC-SDK-02/04/05/06 重新验证。干预返回类型贯通内核、runner、模型适配器与 SDK;headless 只依赖其实际消费的 runTurn 接口。
- Ran:核心/SDK 新增 11 个用例,包含 seed 91004 / 40 runs 的交错属性测试;TUI 新增 6 个用例并加强既有 Ctrl+Enter 断言。真实 PTY 新增 4 条慢存储路径,覆盖提交成功、普通停止、指定替换和提交失败。
- Ran:先补测试再修复,旧实现 SDK 目标测试 3 fail、TUI 目标测试 4 fail。详细用例、边界与未测项见 [ADR-010 验证](../decisions/010-input-ownership-and-interruption.md#本轮验证)。
- Ran:embedded-agent 示例及新增 PTY fixture/test 独立严格 TypeScript 检查通过;fixture 补齐 homeDir 后 4 条 PTY 用例再次通过;`git diff --check` 通过。
- Not run:远程供应商矩阵、断电与部分写入、人工交付验收。
- Why:本批验证已批准的输入归属与取消行为。
- Risk:SDK 干预需传 expectedTurnId;宿主保留拒收及未处理输入。存储开始后不承诺回滚,进程退出不持久化草稿。

### SDK 基线历史记录

- Ran:`bun run check`,269 pass / 0 fail,48 个测试文件;包括依赖门禁、五包 typecheck、CLI/PTY、HTTP replay、SDK 与存储回归。`bun install --frozen-lockfile`、示例独立 TypeScript 检查和 `git diff --check` 通过。
- Ran:`sdk-integration.test.ts` 从公开子路径通过本地 Anthropic HTTP 验证两个实例各自授权,仅允许实例执行工具并续轮;损坏的 .myh 配置不影响 SDK,无 JSONL 输出。
- Ran:`sdk.test.ts` 验证提前关闭、暂停消费时释放、权限与工具清理、旧 iterator 不取消新任务、存储故障;属性测试 seed 90502 / 20 runs 验证队列、取消与释放终态。
- Ran:反向验证临时禁用 AgentRunner 的 commitFailed 保护,故障测试 0 pass / 1 fail;恢复后全套通过。
- Ran:由宿主显式加载当前凭据传给 embedded-agent 示例,xAI/grok-4.6 返回 SDK_EMBEDDED_OK;仅提供无副作用 marker 工具,空内存历史,不输出凭据或读取项目内容作为模型输入。
- Not run:跨供应商远程矩阵、长期任务、断电与文件系统部分写入故障、Node.js 兼容和包发布。
- Why:本批限于 Bun 宿主接入与生命周期,真实烟测不替代长任务可靠性验收。
- Risk:宿主工具取消需配合 AbortSignal;存储故障后的实际提交状态需宿主核对,JSONL 无断电事务保证。此历史记录产生时尚未提交;后续提交证据见上节,不据此补记人工验收通过。
