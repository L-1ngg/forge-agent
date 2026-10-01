---
doc_kind: decision
created: 2026-10-01
---

# ADR-031: 会话交互协调器与操作作用域

> 状态:已实现，本地软件验收通过(2026-10-01)。中立模块、容器替换与正式 CLI 接线已完成；外部环境边界仍未实测。具体接口、施工与本次证据见[施工图](../phases/session-interaction-coordinator.md)。
> 参与者:operator 提出职责划分与 Scope/Token，Codex 核对代码并整理施工设计。

## 背景

核对起点为 `83e7618`。起点的 [App](../../packages/tui/src/app.ts) 同时拥有终端界面、输入调度、压缩、管理命令、会话切换和请求订阅。异步归属由 `generation`、管理操作对象和补全/菜单/复制版本号分别维护。切换须手工协调这些状态；管理命令产生的 `prompt` 也由 App 决定排队或执行。

operator 明确选择:“应该由介于 App 与 SessionHost 之间的独立层——「会话交互协调器（暂定名 SessionCoordinator / SessionInteractionManager）」完整负责，并配合基于作用域（Scope/Token）的对象模型来自动防御迟到结果。”随后要求“可以，你帮我都规划好”，并在设计完成后要求“请你按照这几个文档开始实现代码”。本次交付覆盖完整施工范围。

[SessionHost](../../packages/cli/src/session-host.ts) 已经拥有目标准备、旧实例释放和当前实例提交。其 `beforeRelease` 允许交互层在目标准备成功后停止并结算旧执行。起点的 [CLI 装配](../../packages/cli/src/main.ts) 部分命令与补全回调读取 `sessions.current`；异步操作即使不能发布迟到结果，仍可能在后续步骤重新选择实例。本次正式命令工厂改为使用启动时捕获的目标。

operator 后续要求参考现代交互式 Agent 的四层分工、单向数据流、Scope 生命周期和状态容器替换。原规划把协调器放在 tui 包内，并保留 App 中分散的显示字段；这不能完整表达业务层脱离终端及切换不逐字段重置的目标，因此本稿改为独立交互包与两个分工明确的会话容器。

## 决策

1. 按四种职责分工：Host/按键/Frame/ANSI 为终端与绘制；App 与 `PresentationSession` 为交互和显示状态；`SessionCoordinator`、`SessionInteraction`、SessionHost 及现有 AgentSession 为会话交互和执行；provider/tool/storage/MCP adapters 为基础设施。层是职责分工，不机械新增四套抽象或执行链。
2. 新增私有 workspace 包 `@forge-agent/interaction`，只依赖 protocol 与必要内置模块。它提供协调器、会话交互容器和结构化端口；不依赖 tui/core/cli 或终端 I/O。TUI 可以消费它，其他宿主可以独立使用它。既有 SDK、headless 与 TanStack 循环保持原入口。
3. `SessionCoordinator` 只拥有活动容器选择、切换/关闭及宿主调用；每次会话激活创建一个 `SessionInteraction`，拥有 InputFlow、前台结算、管理/查询槽位、请求/MCP 订阅及对象作用域。容器不复制权威历史，不创建第二个 Agent Runner。
4. App 只保留终端外壳和一个 `PresentationSession` 引用。该显示容器拥有 editor、projector/browser、焦点/卡片、菜单、详情、选区及显示资源。成功激活时保存必要草稿文本、dispose 旧容器并创建新容器；新增显示字段只需定义容器初始化和资源所有权，不修改切换清理清单。草稿缓存归显示层。
5. 数据流为用户动作 → 协调器/会话容器 → 领域事件与只读 snapshot → 显示投影 → frame。业务状态只有业务容器/现有核心能修改；绘制不能答复请求、对账、启动任务或切换会话。snapshot 使用已有 revision/结构共享思路，不每个 token 深复制完整历史，也不强制引入全局 immutable store。
6. 使用原生 AbortController 和对象身份实现共享 `InteractionScope`。所有异步进度、成功与失败由统一入口判断发布归属，资源清理始终执行。补全、会话列表及预览由会话容器调度，App 只发出查询/取消意图及接收结果；纯显示计时和终端剪贴板效果属于显示容器的作用域。不增加第三方任务/状态机框架。
7. 辅助取消与前台结算分开。切换开始关闭辅助发布通道并暂停自动发送；目标准备成功后才停止旧执行，等待结果保存及清理。成功后替换业务和显示容器；准备失败保留旧实例/显示状态，但建立新的辅助作用域，旧结果不复活。
8. CLI 命令及补全在启动时捕获会话实例，后续使用该实例和 signal。Token 只在内存中有效，不是用户授权；Scope 不是进程沙箱。取消能阻止迟到发布和新的操作，但不能强制终止所有 HTTP/工具、撤销已开始 I/O 或绕过必须结算的 Promise。
9. 保留 `new App(...)` 与 start/stop/waitUntilStopped、单实例用法；App 内装配协调器，业务接入也可直接使用独立交互包。更新仓内命令上下文与补全接线，不维护旧执行路径。完整 Scope 销毁代表失效并完成必要结算，不能将一次指针赋值当成完整异步切换。

## 取舍

| 备选 | 选择依据 |
|---|---|
| 只拆分 App 的方法，保留共享状态与版本号 | 不能集中切换、停止和迟到结果规则；迁移必须转移状态所有权 |
| 把交互调度放进 SessionHost | 会让实例与文件宿主理解输入队列、管理命令及显示取消，削弱独立使用和测试 |
| 协调器继续留在 tui 包，承诺未来再迁出 | 业务复用仍依赖终端 package；本轮明确中立依赖并以独立消费者测试验证 |
| 把 editor/卡片/选区与业务状态塞进同一个 SessionScope | 使中立业务模块依赖终端交互；分别用业务和显示容器表达各自所有权 |
| 用完整 immutable history/store 替代现有投影 | 增加第二份历史及 token 级复制；只读发布和容器替换已能表达本轮约束 |
| 对整个会话 Scope 一次 abort，并丢弃所有旧事件 | 会提前取消目标准备期间的任务，并丢失 processed 回执和必须保存的结果 |
| 增加通用状态机或任务运行框架 | 当前职责可由有限状态、原生取消和对象身份表达，暂无需要额外框架替换的行为 |
| 替换 TUI 框架或修改 TanStack 执行循环 | 本轮针对宿主交互职责；现有 compositor 与唯一 chat 循环继续按 ADR-005/025 |

## 后果

管理命令只需提供操作实现，归属、重复操作策略和结果转为输入由统一入口处理。App 不再知道执行任务、总线消费或管理操作的收尾细节；协调器不会接收所有逐会话业务字段。代价是增加一个 workspace 包，并同步其依赖门禁、测试登记、类型/build 和双语架构说明。

本决定已定向修订 ADR-004/005 的 TUI 依赖允许集，使其可依赖中立的 interaction 包；core 禁止依赖 UI、interaction 禁止依赖 core/tui/cli 和 compositor 的选择保留。六包依赖门禁与旧 ADR 状态指针在本次交付中同步更新。

本决定收敛 ADR-029 的归属实现方式，保留其迟到结果、切换失败、停止与 pending 权威合同；保留 ADR-010 的输入归属和 ADR-030 的普通会话保存。草稿、操作身份和待发送队列仍为进程内状态，JSONL、SDK、provider adapters 与恢复不重放语义不变。

当前运行时按本决定划分所有权。[施工图](../phases/session-interaction-coordinator.md)记录本次验证；设计、历史测试及文档检查不代替运行时验收。
