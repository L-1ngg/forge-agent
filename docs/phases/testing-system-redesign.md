---
doc_kind: plan
created: 2026-09-30
---

# 测试体系全面重设计与重构

> 状态:重构已交付并完成跨平台软件验证(2026-09-30)。macOS 路径失败已修复；全仓审计、去重、重构、反向验证和本地门禁完成。修复提交 `00be399` 的 Ubuntu 24.04/macOS 14 CI 均通过；远端证据与后续权限 PTY 退出竞态修复见文末。逐文件去留依据见[处置清单](testing-system-inventory.md)。
> 继承 [现行测试合同](testing-system-implementation.md)、ADR-010、025–029 和各功能的有效软件合同。Issue #33 的历史平台证据保持原版本含义。本设计涉及软件测试，真实模型质量与付费评估继续单独验收。

## Why

operator 原始请求："可以，请你修复这个bug，然后全面重新设计和重构测试"。

operator 补充："之前写的那些测试脚本和文件可能会有大量冗余，你也要关注一下这个问题"。冗余审查覆盖测试用例、helpers、fixture 脚本、runner 和重复门禁；每个删除/合并都记录依据与替代覆盖，最终报告实际减少的维护内容。

触发失败的 CI 为 [36698714767](https://github.com/L-1ngg/forge-agent/actions/runs/36698714767)，源码为 `45c2221a31b6bb30ab32d8c34860da96bc584475`。macOS 的 `session-ui.test.ts` 在成功恢复分支比较 `sessions.current.id === target.path`；前者基于规范化项目目录，后者保留临时目录的路径别名。恢复成功后条件仍不成立，最终超时。这是测试身份比较错误，延长等待无法修复。

本轮局部修复从 `SessionHost.list()` 取得目标 ID，并把成功/装配失败场景分别放到普通目录与符号链接目录执行。新增别名场景在原断言下变红；修复后真实 App/SessionHost 相关三文件 31/31 通过。最终完整门禁结果在下方单列，不把这个局部修复计为全面重构完成。

### 当前盘点

范围为当前工作树的 `packages/*/test/`、`tests/`、`scripts/` 测试、fixtures、支撑代码，以及相关入口、类型配置和 CI。2026-09-30 使用 TypeScript AST 统计可执行调用，不执行模型：

| 事实 | 对设计的影响 |
|---|---|
| 119 个测试文件，当前按文件名分为 contract 73、integration 35、cli 11 | 分组必须依据实际测试接口，并检查发现范围的完整性；文件改名不能悄悄改变证据类别 |
| `packages/tui/test/app.test.ts` 为 1,424 行，39 处 `Bun.sleep` 调用 | 按交互合同拆分；区分真正的按键计时规则、事件循环让步和业务等待，不统一扩大延迟 |
| 测试文件共 84 处 `Bun.sleep`、12 处 `new Bun.Terminal` | 逐处审查；PTY 的启动、输出、退出和诊断通过共享驱动处理，保留真实终端观察 |
| 测试文件共 129 处 `Bun.serve`、108 处 `mkdtemp` | 资源从创建起纳入生命周期；重点检查 setup 失败、断言失败、取消与迟到回调时的结算 |
| 8 个使用本地 HTTP 的文件仍归 contract，包括 session UI 和 context compaction | 明确模块合同与系统组合合同；拆分混合文件后显式声明归属 |
| 旧 `abort-machine.ts` 仅由参考模型自检引用，测试已标注非生产覆盖 | 逐项核对实际 SDK 替代覆盖；没有独立价值的参考模型和自检一起删除 |
| runner 的日志写入没有显式选择截断，现行 Issue #44 记录已注明旧日志会追加 | 每次执行产生独立证据目录，JUnit、日志、环境、清单与退出码必须属于同一轮 |

上述调用次数只表示审查位置，不等于已确认的缺陷数。纯解析、schema、Markdown、cell golden 等有效模块测试不因规模盘点而重写。

## Entry Criteria

| 检查 | 门槛 | 不通过怎么办 |
|---|---|---|
| 当前失败 | 原测试在符号链接路径下变红，发现 ID 修复后四种恢复场景通过 | 保留失败与原因，不通过延长超时或跳过平台得到绿色 |
| 设计 | operator 确认本施工图的范围与验收 | 只交付已授权的小修复和设计，不启动大范围迁移 |
| 基线 | 保存当前完整测试集合、JUnit 名称、合同映射、运行环境和耗时 | 先处理实际失败，不能在迁移中把失败用例静默移除 |
| 契约 | 对照 SDK 指南、当前 ADR 与各功能施工图 | 冲突先记录并对齐真相源，不恢复已移除的 Pi runtime 或旧审批机制 |

## What

### 1. 按观察接口组织覆盖

保留 `bun:test`、`fast-check`、Bun 1.3.12，以及现有 `test:contract`、`test:integration`、`test:cli`、`test:headless`、`test:network` 命令。分组定义如下：

| 层 | 观察对象 | 能证明什么 | 典型内容 |
|---|---|---|---|
| contract | 生产模块的稳定接口；测试支撑自身的接口 | 输入到输出、验证错误、局部状态转换与布局规则 | codec、schema、预算算例、RequestBus、Markdown、cell golden、Scenario/fixture 自检 |
| integration | 真实 SDK、存储、SessionHost/App 装配、provider adapter 与本地服务 | 跨模块归属、提交顺序、取消、恢复、完整请求和协议终态 | 权限、工具副作用、配置、压缩、记忆、Skills、MCP、session UI、协议与操作序列 |
| cli | 正式 CLI 子进程及真实 PTY | 入口配置、退出码、JSON 输出、按键/粘贴/窗口变化、终端恢复 | 启动错误、headless、交互审批、停止、新建/恢复、详情浏览 |

纯 App 交互合同可以在 HostInput/HostOutput 与 AppPort 接口提供替身；真正的执行与会话保证由真实 SDK/SessionHost 验证。两类用例名称与说明分别指出证据范围。测试不因导入 SDK 就全部提升到最慢的 PTY 层。

`scripts/test-plan.ts` 维护显式测试文件归属，发现只覆盖约定源码测试根目录。每个文件恰好归一组；新增未登记、重复登记、丢失文件、空组均使检查失败。输出实际执行计划供 runner 与诊断使用。移除当前文件名前缀规则和默认归 contract 的隐式回退，不额外引入第二套测试执行器。

### 2. 以合同映射保留覆盖

对全部 119 个现有文件逐项分类为保留、迁移、合并或删除。迁移清单以产品合同为主，记录旧用例位置、最终位置及变更理由；重命名、参数化和测试数量变化不作为覆盖提升的证据。

| 必须保留的风险 | 最强的观察证据 |
|---|---|
| 模型响应未完整提交就执行工具 | 存储失败时工具副作用为零；完整批次终态与历史可核对 |
| 旧 Invocation、管理操作或审批结果污染新会话 | 实际请求、当前草稿、历史与响应回执保持正确归属 |
| 取消/释放等待失控，整理迟到写盘 | 权威 result、idle/dispose 结算，真实记忆文件没有迟到写入 |
| 配置与预算在错误边界生效 | 真实下一轮请求使用 applied 快照；预算失败发生在 provider I/O 前 |
| 历史损坏、分支混用或恢复重复副作用 | 文件重开、实际模型投影和工具执行次数符合合同 |
| 通知回收丢失、TUI 卡片或缓存陈旧 | pending 对账、实际终端 paint、当前分支/宽度/主题的展示结果 |
| SSE/UTF-8/工具参数/协议终态处理错误 | 原生 provider adapter 接受合法完整流，拒绝截断与非法终态且不执行工具 |
| CLI 退出、终端模式或入口配置错误 | 正式子进程退出码、JSON、真实 PTY 控制序列与文件结果 |

只有证明重复或没有对应产品合同，且替代测试已经通过反向验证，才删除旧用例。针对 `abort-machine.ts` 的两个自检，先核对真实 SDK 操作序列中的取消、工具配对和迟到事件合同，再删除无生产用途的自检及模型。有效的格式/算法单元测试继续保留。

### 3. 收敛测试支撑与资源所有权

扩展现有 `tests/support/scenario.ts`，保留它的结算顺序：释放 gates，停止与释放执行资源，等待所有已登记执行，验证 HTTP 预期，关闭 fixtures，最后移除目录。主断言错误保持为主错误，结算错误保留为次要诊断；清理失败不能假绿。

项目目录夹具支持普通路径与符号链接路径，并负责 HOME/XDG 目录和临时文件的清理。涉及会话选择时使用公开发现 ID；涉及文件身份的断言明确采用规范路径或真实文件内容。资源在创建后立即登记，setup 中途失败也走结算。测试不得在资源未登记时先启动子进程再进入 finally。

`tests/support/control.ts` 统一有界等待、屏障与失败诊断。优先等待实际 request/event/commit/settlement，只有 UI 或文件异步观察使用带名称、最后观测值和子进程状态的条件等待。期限采用单调耗时，超时仅作为失败边界。

所有固定 sleep 分成三类逐项处理：业务等待改为可观测条件或 gate；单纯事件循环让步采用明确调度点；Escape 解析、重试、整理期限等真实计时规则保留专门测试和适用理由。不能把所有 sleep 机械替换为另一种轮询。

### 4. 重构 App 与 PTY 用例

实施补充：保留现有依赖版本，新增测试专用 `@xterm/headless@5.5.0`，通过维护中的终端解析器还原实际 PTY 差量 ANSI 画面。`screenText` 验证用户当前能看见的内容，原始 `text` 验证 clipboard/终端恢复控制序列；fixture frame RPC 只验证布局，不作为自动 paint 证据。由差量重绘导致的 `PREVIEW_BOTTOM` 分段输出已有支撑层反例，不自研 ANSI screen parser。

共享 `tests/support/app-driver.ts` 负责 HostInput/HostOutput、输入、输出收集、有界观察和停止，不实现任务归属、请求总线或 Agent 状态机。AppPort 替身只控制输入事件与独立的 `SessionTurn.result`；真实 SessionHost 场景使用生产对象。

按输入与提交、审批卡片、管理操作、会话恢复、流式展示、历史浏览、主题/窗口等合同拆分 `app.test.ts` 和 `session-ui.test.ts`。关键 paint 测试读取实际 stdout，不通过反复 `composeFrameForTest()` 触发状态刷新后宣称自动重绘成功。

共享 `tests/support/pty.ts` 负责 Bun.Terminal 与子进程所有权、增量 UTF-8 解码、输入、resize、IPC、输出条件、退出和清理。各测试保留可读的用户操作与断言。fixture 的 capture 使用 request/ack，并区分模型任务完成、App frame 完成与外层 PTY 输出可见；不以固定 45/50 ms 代替这三个阶段。所有 Bun 子进程使用 `process.execPath`。

正式 CLI 与专用 fixture 保留各自用途。覆盖粘贴分段、多字节中文、窄窗口、审批停放、停止/替换、退出恢复。驱动失败报告保留输出尾部、最近输入、窗口、IPC 及子进程退出信息，绝不记录真实凭据。

### 5. 协议 fixtures、存储与属性序列

把跨目录复用的 adapter/reply/request/HTTP fixture 帮助代码统一放入 `tests/support/` 或 `tests/fixtures/`；provider 特有的字节和元数据仍按协议保留。手写 fixture 显式记录版本/来源；只有模型响应是受控依赖，TanStack chat 与 Forge 生命周期继续执行生产实现。

HTTP fixture 默认严格：请求 method/path、有效消息、工具 schema/参数/ID/顺序必须匹配，缺失、额外和错误请求都失败。简单成功响应可以复用帮助函数；协议错误、未知工具或取消不能落入无限成功回复的 fallback。stream 的中途状态通过发送 gate 与消费事件确认，不假设 enqueue 等于 TCP read 分片。

存储夹具使用生产 SessionStorage/SessionStore 接口，覆盖写入前 gate、写入失败、重开、分支和合法扩展，避免检查私有缓存。读取原始 JSONL 只用于外部持久化格式合同，不用它替代公开会话行为断言。

`fast-check` 保留真实 SDK 操作序列和独立不变量，统一输出 seed/path、最小操作序列和场景 trace。拆分 reference-model-only 自检与产品覆盖；取消、配置、审批、记忆和存储组合通过真实权威结果观察。随机测试默认固定可复现预算，避免数百次无意义参考模型运算充当稳定性证据。

### 6. Runner、失败证据与 CI

离线入口继续采用环境白名单、假凭据和隔离 HOME/XDG；Linux 强制 network namespace，并验证主进程、原生 socket、Bun/Bash/CLI 子进程外连拒绝。macOS 跑完整兼容性测试，明确记录 `networkIsolation: none`，不重新接入 Seatbelt/PF。

每次 runner 调用创建独立 `.test-results/<run-id>/`，同目录写入执行计划、环境/源码标识、JUnit、原始日志、network 证据和状态汇总；日志显式截断。状态汇总指出未执行、执行失败、通过以及进程退出码，不能消费上轮 JUnit 作为本轮结果。失败也保存汇总；根目录的最新结果索引只指向具体 run-id，不拼接旧日志。

CI 的 Ubuntu 24.04/macOS 14 矩阵运行相同静态检查、完整测试、headless 与示例类型检查。每个平台上传本轮证据，平台失败不取消另一平台；保留首次失败，不增加自动重试。并发本地执行使用独立目录，不能互相覆盖报告。

运行入口、计划分组和证据写入有自身回归：未登记/重复/缺失测试、测试非零退出、setup 或子进程失败、旧结果残留和并发报告均可通过公开接口验证。对 path aliases 和 App/PTY 易受调度影响的场景进行有界重复验证；重复预算在验证记录中列明，不对已通过的全部测试无限重跑。

## Batches

以下是实施依赖顺序，确认后在一次完整交付中完成，不分成后续另行授权的能力批次：

1. 保存基线与合同映射，实现显式执行计划、独立证据与 runner 自检。
2. 收敛 Scenario、路径夹具、等待诊断和严格 HTTP 资源结算。
3. 迁移 App/SessionHost 与全部 PTY，拆分混合用例，移除业务时序 sleep。
4. 逐文件检查 SDK/存储/协议/属性/纯模块测试；迁移共享 fixtures，合并重复或无产品合同用例，核对覆盖映射。
5. 同步开发说明和 CI；做反向验证、完整门禁与风险场景稳定性检查，记录各平台实际结果。

测试重构暴露的真实产品缺陷另行记录契约与最小修复，不削弱断言。新增抽象必须在至少两个真实调用点替换现有重复，且不复制生产领域状态。

## Verify / Release

以下为本施工图负责的整体出口；后续任务 Issue 引用本节，不重复定义。当前未创建新 Issue 或修改远端状态。

- [x] AC-1: 119 个起点测试文件均有保留/迁移/合并/删除记录；有效产品合同全部有最终测试归属，删除有替代或无产品用途依据。
- [x] AC-2: 执行计划与发现集合一致，每个文件恰好归一组；漏登记、重复、丢失与空组注入均失败。
- [x] AC-3: 管理归属、工具提交屏障、取消后记忆写入、严格 HTTP 匹配、终态自动 paint 各至少一次反向故障验证变红，恢复后对应公开行为回归通过。
- [x] AC-4: 普通/别名路径及工作树归属、setup 中途失败、慢消费/迟到回调、子进程提前退出的关键场景通过；失败含名称与最后观察诊断。
- [x] AC-5: 正式 CLI、全部 PTY 和 headless 用例迁移完成；业务流程不依赖固定 sleep，真实计时测试保留原因；测试结束完整等待资源结算。
- [x] AC-6: 新鲜证据与源码/环境对应；旧报告不能产生假绿，连续与并发运行不混写；首轮失败保留。
- [x] AC-7: 本地 `bun run check`、`bun run test:headless`、`bun run typecheck:examples`、`bun run build`、diff/文档链接检查通过；修复提交的 Ubuntu 24.04/macOS 14 CI 分别通过，平台隔离边界见文末。

设计确认只授权本地完整重构与验证。commit、push、Issue 发布/关闭、远端 workflow 触发依 operator 的明确授权执行。没有远端授权或 macOS 环境时，交付本地结果并明确 macOS 未验证，不声明跨平台验收完成。

本地验收完成后，operator 明确要求 `commit, push`；本轮提交全部相关代码、配置与文档，并验证 push 自动触发的 Ubuntu/macOS CI。该授权不包含发布或关闭 Issue。

## Rollback

按已记录的迁移组恢复测试、支撑、runner 和文档即可回退；生产会话格式、公开 SDK 与依赖版本不因本设计改变。旧 golden 和协议数据保持可审查来源。执行计划检查失败时停止测试入口，不默默漏测。

## Risk

| 风险 | 控制 |
|---|---|
| 大范围移动导致覆盖丢失 | 基线 JUnit 与合同映射逐项核对，先迁移后删除，关键保证做反向验证 |
| 驱动成为第二个产品实现 | 只负责输入/输出、资源与诊断，执行和请求语义留在真实对象 |
| 异步重绘/IPC 引入新的等待误判 | 分别确认任务结算、frame 和 PTY 输出；负向断言先等待明确业务边界 |
| 平台/API 差异被 Linux 结果掩盖 | 在 Linux 主动构造路径别名，保留 macOS 矩阵与证据边界 |
| 报告/目录调整破坏既有调试方式 | 保留命令入口，同步 CONTRIBUTING 与上传路径，报告迁移提供明确 run-id |

## 重构前局部修复基线

- Ran：普通目录与符号链接目录共四种恢复场景；旧比较条件得到 3 pass / 1 fail，失败为别名路径下的成功恢复。改用公开发现 ID 后，session UI/host/preview 三文件 31/31 通过。
- Ran：局部修复后的 `bun run check` 通过依赖边界、包/automation/tests 类型检查与 Linux network namespace 探针；JUnit 为 contract 564、integration 392、CLI/PTY 15，共 971/971，无失败或跳过。`bun run test:headless`、`bun run typecheck:examples`、`git diff --check` 通过。
- 上述 971 用例是重构前的保存基线，不作为最终源码通过证据。符号链接回归验证已确认路径原因，不代替 macOS 整套环境验证。

## 本轮实施与验证

### 最终实现

- 全部 119 个起点测试文件均在[处置清单](testing-system-inventory.md)中有记录。最终计划为 132 个文件：contract 52、integration 62、cli 18；文件拆分不计作覆盖增长。
- App 拆为输入、请求、渲染、记录四文件；真实 SessionHost UI 拆为管理、预览、请求、切换四文件。共享 App/PTY 驱动只负责输入、实际输出、资源和诊断。
- 11 个 PTY 文件统一驱动；@xterm/headless 解析实际差量画面。正式 CLI 的管理命令先确认可编辑草稿，再提交；Skills 补全先确认当前 picker，再确认已补全草稿。frame capture 不作为自动 paint 证据。
- 资源创建后立即登记，移除原 finally 与 Scenario 的重复清理。main-workflow/memory fixture 目录由父 Scenario 提供；构造失败、setup 失败、执行超时和提前退出均有清理验证。PTY body 预算 26 秒，外层 35 秒，清理先于报告错误完成。
- 5 个跨包模型 helpers 迁到 tests/fixtures；保留有效协议字节、golden、MCP executable 与实验来源。删除 abort 参考模型及 2 个自检、旧 headless 脚本和 CI 重复 headless 步骤。headless smoke 使用正式 CLI、严格 HTTP 和权威退出结果。
- 显式计划拒绝漏登记/重复/缺失/空组；每次 runner 保存独立执行计划、源码 hash、日志、JUnit 与状态。属性测试统一 seed/path；模型速率、Escape 歧义、重试/期限等真实计时规则仍有独立测试。

### 最终绿色证据

Ran：`bun run check` 返回 0，证据 `.test-results/run-Q4T5jT/`。环境为 Linux x64、Bun 1.3.12，network namespace 探针通过；依赖边界、包/automation/tests 类型检查通过。

| 分组 | 文件数 | 用例数 | 失败 / 跳过 |
|---|---:|---:|---:|
| contract | 52 | 333 | 0 / 0 |
| integration | 62 | 609 | 0 / 0 |
| cli / PTY / headless | 18 | 43 | 0 / 0 |
| 合计 | 132 | 985 | 0 / 0 |

源码为 HEAD `45c2221a31b6bb30ab32d8c34860da96bc584475` 加本地改动；465 个执行输入的 SHA-256 为 `bd6b40f0fa8333eed30fe5be83ed5fdce525f32b431e3c41b1c909d0b29eb102`。hash 包括代码、测试、配置与锁文件，Markdown 状态收尾不改变它。

JUnit 用例名称按多重集比较：971 个基线中保留 969 个，仅缺已记录的 2 个参考模型自检；新增 16 个计划/证据/等待/PTY/正式 headless 回归，得到 985。机器核对结果在 `.test-results/redesign-baseline/coverage-comparison.json`，测试移动和改名不算覆盖提升。

Ran：独立 `bun run test:headless` 返回 0，证据 `.test-results/run-PVfq1Y/`；`bun install --frozen-lockfile` 无依赖变化；`bun run typecheck:examples`、5 个包的 `bun run build`、`git diff --check`、10 个入口/相关文档的相对链接检查通过。Standards 与 Spec 两轴审查的实际 findings 已修复，最后复核均无遗留问题。

### 反向故障与稳定性

在独立本地 worktree 中顺序变异，生产文件未改入交付工作树。各目标先通过、变异后失败，恢复后 5/5 通过；日志在 `.test-results/redesign-mutations/`。

| 目标保证 | 故意破坏 | 目标测试变红的实际证据 |
|---|---|---|
| 管理归属 | owns() 只检查 App 启动状态 | late memory import after new：模型请求 1，预期 0 |
| 工具提交屏障 | tool proposal 落盘不 await | assistant persistence barrier：工具副作用 1，预期 0；改为 nextTurn 后再次变红 |
| 取消后记忆写入 | 移除 plan 文件操作前的 signal 检查 | cancellation during plan preflight：出现 topic.md，预期空目录 |
| 严格 HTTP 匹配 | 跳过 exchange.match(body) | strict HTTP replay：错误 body 返回 200，预期 400 |
| 自动 final paint | 定时 paint 仅 compose，不输出 | coalesced output：实际 stdout 没有 FINAL_STREAM_SENTINEL，条件超时 |

有界稳定性预算：普通/别名 × 成功/装配失败 4 场景各 5 轮，共 20/20；main workflow、取消/粘贴、会话管理、MCP 4 个 PTY 场景各 3 轮，共 12/12；Skills 补全 5 轮，共 5/5。全部在 Linux network namespace 中执行，日志在 `.test-results/redesign-stability/`。本轮不再无理由重跑全部测试。

首轮及后续失败均保留：`run-MYphae` 的差量 ANSI 误判、`run-AoG2nn` 的管理命令/旧画面误判、`run-Q5971b` 的旧 Skills 目录描述误判。修正观察边界后才重新验证，没有自动重试或忽略首次失败。

Not run / Why：上述本地验收未运行 macOS/Windows、真实供应商、模型质量/费用与人工 UI 验收。本地验收后已获得 commit、push 授权，远端 CI 结果另行记录；配置存在不等于执行通过。

Risk：本节为提交前的本地证据，macOS 的 Bun.Terminal、文件系统与运行器差异以以下实际 CI 验证为准。未执行发布或关闭 Issue。

## 远端交付与平台验收

operator 授权后，完整修复与重构提交为 `00be39999b5bc521add6e6096baa4da66063a60a`，已正常推送 `origin/master`；对应 [CI 36728440944](https://github.com/L-1ngg/forge-agent/actions/runs/36728440944) 首次执行成功，未重跑。

| 平台 | 执行证据 | 测试 / 失败 / 跳过 | 网络边界 |
|---|---|---|---|
| Ubuntu 24.04 x64 | run-G1Q3d0；依赖/类型检查、完整测试、示例类型检查与证据上传通过 | 985 / 0 / 0 | network namespace 与主/子进程拒绝探针通过 |
| macOS 14 arm64 | run-MyC8PT；相同完整门禁与证据上传通过 | 985 / 0 / 0 | networkIsolation: none，仅 fixture 兼容性证据 |

两平台 JUnit 均为 contract 333、integration 609、cli 43；普通/路径别名的四种恢复场景均通过。GitHub artifacts `test-evidence-ubuntu-24.04` 与 `test-evidence-macos-14` 已下载至本地 `.test-results/ci-36728440944/`，核对 summary 的实际 commit SHA、状态和 JUnit 计数，未把旧报告作为新提交证据。

Windows、真实供应商、模型质量/费用和人工 UI 验收仍未运行。CI 成功不包含公开发布或 Issue 关闭。

## 权限拒绝 PTY 退出竞态修复(2026-10-01)

[CI 36804062251](https://github.com/L-1ngg/forge-agent/actions/runs/36804062251) 验证 `d8e10e6` 时，Ubuntu 通过，macOS 14 arm64 的 contract 333、integration 619 均通过，CLI 48/49 通过。唯一失败为 `permission.test.ts` 的 allow/deny 场景：`cli-permission: missing exchanges: denied-continuation`。该轮 SDK/CLI OTel 用例全部通过。

测试原先看到 `Denied by user` 已写入会话就发送 `Ctrl+C`，但工具结果持久化是模型续轮之前的中间状态；退出可能取消尚未发出的下一次请求。修复仅调整测试的观察边界：等待拒绝后的第四次请求到达、最终回复出现在真实终端并写入会话，再发送退出按键。保留目标文件、退出码、终端恢复和严格 HTTP 预期，未修改生产逻辑、超时或平台覆盖。

现有 HTTP fixture 的 gate 暂停最终回复，确认工具拒绝已保存时最终回复仍未保存。保留原退出顺序时回归因最终回复缺失而变红；修正后释放 gate，再等待实际输出及持久化。Linux 网络隔离下两个权限 PTY 场景连续 5 轮通过；临时 HOME/XDG 与目录已清理。

本地 `bun run check` 通过：333 contract + 619 integration + 49 CLI/PTY = 1001 tests，依赖边界、workspace/automation/tests typecheck 与网络隔离探针通过；`bun run typecheck:examples` 通过。完整证据为 `.test-results/run-ijPBPw/summary.json`。本地证据不代替 macOS 验证；修复提交的跨平台结论以其实际 CI 结果为准，不沿用旧提交的绿色结果。
