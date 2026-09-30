---
doc_kind: plan
created: 2026-09-30
---

# Issue #44 会话可靠性与长会话性能

> 状态:实现与离线软件验收完成(2026-09-30，离线软件门禁、受控基准及双轴复审通过)。范围、任务级 AC 与任务状态以 [Issue #44](https://github.com/L-1ngg/forge-agent/issues/44) 为准；继承 ADR-010、017、023、025–028 和 Issue #40–43 的合同，不改写历史验收。

## Entry

起点 `eea5167f9a9a134ea73442d144b781eaa3712c34`，`master` staged、unstaged、untracked 均为空。规格已固定方向、完整范围和公开测试接口，本次实现不重新确认已定决策。

| 检查 | 门槛与失败处理 |
|---|---|
| 生命周期 | 先在真实 App/SessionHost 与 SDK 上复现归属和整理等待问题；无法复现则核对 gate 和实际请求，不以私有标志替代证据 |
| 性能 | `scripts/session-reliability-benchmark.ts` 在运行时代码修改前记录冻结 fixture 的旧实现基线；新旧同机、同 Bun、同 fixture、同视口比较 |
| 数据与资源 | 坏消息入口、10,000 请求和历史调用投影通过公开接口验证；固定容量和回收规则先声明 |
| 出口 | 定向测试、check、headless、examples、build、diff/文档检查和双轴 review；有失败先修复，不将部分完成标成验收通过 |

## Design And Parameters

1. App 管理操作绑定启动时的 Session 对象、generation、AbortController 和槽位身份。切换开始或停止时立即取消并释放旧槽位；report、prompt、error、finally 都检查同一身份。可选 signal 传给现有命令回调，不合作回调不阻止 App 停止；显式外部副作用不回滚。执行和通信消费者继续用自己的 generation，管理失效不丢弃正在收尾的任务事件。
2. 官方 memoryMiddleware 仍拥有 deferred 调度；Markdown adapter 使用 Invocation signal 和有限模型等待。`organizerTimeoutMs` 默认 60,000，必须为有限正安全整数；超出 JavaScript timer 范围时按单调耗时分段等待。期限从模型调用到完整审计结束，取消时结束本地等待。预检之后及每次文件操作开始前再检查有效性；部分 I/O 沿用非事务合同。
3. 短投影将可用消息预算定义为本轮 inputBudget 减有效 system/tool 固定材料。active 状态与来源额度为其 20%，最多 2,048 估算 tokens；可选 claims 在此额度剩余部分取近期项。执行索引额度为其 10%，最多 1,024 tokens；按 active 引用的未知副作用、近期失败、近期调用选择，并按分支顺序展示。完整状态不可装入时保守失败。完整 checkpoint 和历史不变，节选显式给出 search_context/read_context 入口。
4. RequestBus 近期 settled、dropped、response 和 terminal 通知各默认保留 256 条，可选有限容量配置。请求队列只保留仍 pending 的信封；已结束信封不再向消费者展示。诊断队列采用有限环形保留，公开累计截断计数和 `isPending` 对账；慢消费的卡片每次展示/操作前对账，不依赖永久 getTerminal。ID 携带实例随机身份和单调序号，即使自定义 idFactory 重复也不得复用已发身份。关闭后只回执，不增加驻留记录。
5. 共享消息 codec 检查可持久化值、role、timestamp、已知 block 与必需字段，保留合法扩展。加载完整校验，追加只校验新记录与其分支关系；请求配对继续单独投影，允许历史部分响应、provider 工具及缺失结果。
6. Invocation 与 Response/ToolBatch 状态封装领域转换；普通工具和官方 AnyTool 在集中 bridge 处理来源、schema、最终参数、信号和结果。原生 chat 生命周期及提交屏障继续由 Session 协调。
7. 历史派生视图只缓存内存事实，以 committed revision、leaf 和相关配置/投影预算失效。每个实例只保留当前分支/上下文视图；外部快照隔离；失败提交不发布 revision。公共 UsageTracker 的可变输入继续实时观察，Session 复制提交后的上下文快照才启用查询缓存。TUI 每条内容 revision 缓存展示，当前宽度/主题/折叠下最多保留当前条目的一份 presentation，缓存只覆盖当前历史。未变化的 frame 复用同一条目快照与布局，viewport 单独更新；重绘合并至一次事件循环，终态对账引起卡片退役时安排刷新，停止取消待画任务。

## Batches And Verification

按生命周期、资源/codec/投影、内部状态/派生视图、TUI 顺序实施，最终一次完整交付。测试边界直接继承 Issue #44 Testing Decisions：SDK 实际请求、工具副作用、权威 result、真实文件和 App frame；不用私有 Map 或 reference model 自检代替。

- AC-1–4: gates 控制导入、切换装配失败、旧 error/finally、整理取消/超时/迟到计划；回归在旧实现变红。
- AC-5–7: 100/1,000/5,000 工具调用与固定请求预算、跨分支找回、无解预算与 transform 顺序。
- AC-8–11: 10,000 请求的无/快/慢消费、诊断回收后旧 ID、损坏文件/自定义 load/append、合法历史兼容与快照隔离。
- AC-12–14: 既有工具提交/审批/editedArgs/配置测试及 SDK 组合序列，追加失败不污染派生视图。
- AC-15–16: 冻结 100/1,000 条 Markdown/tool/thinking fixture；100 columns/24 rows，记录冷/热 layout 和完整 frame 中位数，流式局部变化、历史查询；1,000 热布局/frame 目标 <=50 ms 且至少 10 倍提升。性能基准独立于共享 CI 绝对计时断言。
- AC-17–18: 归属、整理写盘门禁、存储屏障、诊断回收反向故障注入，恢复后定向检查；全量 check 末尾运行一次。review 对 starting HEAD、任务 hunk 与新文件执行 Standards/Spec 双轴，修复后刷新输入。

## Release And Rollback

出口为 Issue #44 全部适用离线 AC、新鲜基准与软件门禁、受审提交推送至 `origin/master` 及 Issue 关闭。实现提交为 [`2b7be5d`](https://github.com/L-1ngg/forge-agent/commit/2b7be5df5823ff95d5bca7eadb05d4efc40d92ea)；发布或付费真实供应商评估不在本次交付范围。回退通过本任务提交 revert；整理可由既有 autoUpdate:false 关闭，预算/codec/提交故障始终保守拒绝。旧 JSONL 不自动重写，外部副作用没有新增回滚保证。

## Evidence

### 软件合同

本次新增回归及既有合同检查通过，按 Issue AC 引用证据，不另定义验收标准：

| AC | 本次证据 |
|---|---|
| AC-1–2 | `packages/cli/test/session-ui.test.ts` 使用真实 SessionHost/App 和 gates，覆盖 memory import 后 `/new`、真实 `/resume`、装配失败、stop、当前正常 prompt，以及 memory/skills/MCP 的旧 error/finally；模型请求、目标历史、草稿与可见 frame 均有断言 |
| AC-3–4 | `packages/core/test/sdk-memory-organizer.test.ts`、`sdk-native-memory.test.ts`：取消/释放、忽略 signal 的迟到计划、公开期限、预检期间取消、计划全量校验、I/O 部分失败、真实 calls/可选 usage；整理自身失败保留任务 success |
| AC-5–7 | `packages/core/test/sdk-bounded-checkpoint.test.ts` 通过 SDK 实际请求验证 100/1,000/5,000 调用额度、成功/失败/未知原文找回、跨分支拒绝和 active 无解预算；既有 compaction/context-transform/自动恢复测试覆盖来源、硬线与宿主回调顺序 |
| AC-8–9 | `tests/request-bus/request-bus.test.ts`：10,000 请求在无/快/慢通知消费下有界、关闭后重复请求、旧/未知答复、重复 factory 标签和取消早于信封消费；真实 App 卡片在终态诊断被回收后仍退役 |
| AC-10–11 | `packages/core/test/sdk-message-codec.test.ts` 从真实文件重开、自定义 load、file/memory append 验证坏 block/必需字段及定位；既有 foundation-data、provider-replay、MCP 输入、旧副本与中断历史测试通过 |
| AC-12–13 | `native-approval.test.ts` 新增 editedArgs 修订提交失败时整个批次副作用为零；既有 runtime-tools、incremental-session、配置与 hooks 回归验证提案/结果屏障、去重和同一 applied 快照；没有新增循环或审批持久账本 |
| AC-14 | `session-first-write.test.ts` 的快照隔离/追加/分支选择，以及存储失败、压缩和配置用量回归通过；`usage.test.ts` 验证调用方可变输入实时观察、owned 快照隔离/更新；同 revision 查询基准见下表，缓存不进入 JSONL |
| AC-15–16 | 冻结基准通过；App/browser/详情/golden/CLI PTY 回归覆盖流式内容、工具、宽度、主题、折叠/分组、选取/复制、锚点、会话切换、最终 paint 和 stop 后无迟到 paint；新增真实总线回归在不查询 frame/发送新输入的情况下等待实际取消输出 |
| AC-17 | 真实 SDK + Scenario 的配置/审批/取消/记忆组合属性测试：默认 seed `44017`，8 runs，失败输出 path/操作序列；本次故障注入见下段 |
| AC-18 | 最终全量门禁、双语 SDK、ADR-029 及受影响文档通过；Standards/Spec 双轴复审无未解决问题，本地提交范围为本任务完整受审改动 |

**故障注入**：实施中临时去掉管理操作的归属门禁后，旧 import 触发目标模型请求（预期 0，实际 1）；去掉整理取消后的写盘门禁后，迟到计划生成 `topic.md`；去掉提案持久化后，存储失败场景工具副作用由 0 变为 1；去掉 settled 回收后，已退休请求仍能查询终态。相应公开行为测试变红，恢复后定向检查通过；注入没有留在交付代码中。一次 runtime-tools 注入只能得到超时，随后用 incremental-session 的副作用断言确认存储屏障故障，未把超时当作有效证明。

**审查探针与修复**：初轮 Standards 确认期限溢出、公共 UsageTracker 外部输入陈旧缓存两项 P2；Spec 确认终态卡片遗漏 paint、同一 usage 问题两项 P2，共三个独立问题。新增五个公开回归先失败（超大期限错误取消、usage 返回旧估算、终态无实际输出等），修复后相关三文件 44/44 通过。长期限回归用另一实例公开 30 ms 整理期限作时间控制，不用固定 sleep 跨业务边界。审查中的成功 editedArgs JSONL 探针验证双工具修改参数、两条修订、两条结果、重开、新任务、实际 compact（5,242→542 估算 tokens）、再次重开；索引仍为 result-recorded，模型投影不含空修订，工具副作用始终只有两次。临时目录已清理。

后续复审又确认一项期限 P2：连续微任务使 timer 尚未执行时，已超期的完整响应仍可落盘。新增公开 SDK 回归使用 5 ms 期限和约 30 ms 连续微任务；去掉完成后的耗时门禁，记忆回执为 `saved` 而变红，恢复后回执包含 timeout、目录为空且主任务保持 `success`。整理和原生记忆两文件 24/24 通过；两个审查轴的独立探针均确认修复。

**双轴复审**：Standards 硬违规 0、判断性 smell 建议 0；Spec 未解决发现 0。初轮和后续的四个独立问题全部修复，完整任务改动及最终证据文档按同两轴复核后进入本地提交；不把审查探针扩展为真实供应商或跨平台验收。

**Ran**：最终审查修复后的 `bun run check` 通过依赖边界、五包源码/测试类型、automation/tests 类型检查及 Linux network namespace 断网探针；本轮 JUnit 为 contract 562/562、integration 392/392、CLI/PTY 15/15，共 969/969。最终修复后 `bun run test:headless`、`bun run typecheck:examples`、`bun run build`、`git diff --check` 通过；13 个变更 Markdown 的 214 个本地文件链接均有效，未验证外部 URL 和锚点。重绘变为异步后，两项原 PTY 测试暴露 IPC 先于终端绘制的等待假设；改为条件等待实际答案/成功展示后定向 2/2，随后上述完整门禁通过。原始 `.test-results/*.log` 会追加旧运行，当前结果以同轮 XML 根统计和 `timings.json` 为准。

### 冻结基准

运行 `bun scripts/session-reliability-benchmark.ts --output <path>`，无模型调用。旧实现数据在运行时代码修改前取得，见 [baseline](../research/session-reliability-baseline.json)；最终实现数据见 [results](../research/session-reliability-results.json)。均为同机 Linux x64、Bun 1.3.12、100 columns/24 rows，100/1,000 条 Markdown、tool、thinking 混合消息。fixture SHA-256 一致，冷路径各 1 样本，预热后各 7 样本，表中单位为 ms、中位数。

| 消息数 | 旧热布局 | 新热布局 | 旧完整热 frame | 新完整热 frame | 旧冷布局 | 新冷布局 | 新局部 streaming | 旧历史查询 | 新历史查询 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 48.833 | 0.020 | 36.369 | 1.687 | 111.947 | 106.906 | 3.017 | 0.295 | 0.223 |
| 1,000 | 352.800 | 0.010 | 356.737 | 2.997 | 362.561 | 400.060 | 9.470 | 2.557 | 2.032 |

1,000 条的热布局及完整 frame 均低于 50 ms 且超过 10 倍提升；完整 frame 提升约 119 倍。完整 frame 包括 App 布局和 cell 生成，不包括外层终端实际传输/绘制。热布局主要复用未变化布局，不能将其极小耗时解释为整条交互时延。冷布局仍全量处理并有缓存建立开销，本次不宣称冷路径变快；历史查询省去重复索引/验证，仍要为公开快照复制全量消息，收益有限。容量和速度数字只覆盖此冻结合成场景。

### 验证边界

**Not run / Why / Risk**：未运行真实供应商任务及整理质量/费用评估，本次没有指定目标、凭据和预算；合作式 provider 取消行为、真实抽取质量与额外检索成本没有新样本。未运行 macOS/Windows、外层终端人工体验或长期使用；Linux fixture/PTY 与同机性能不证明其他环境。取消仅停止本地整理模型等待并禁止迟到自动写盘，不强制终止任意外部操作或回滚已开始的文件 I/O。预算使用项目启发式计数，不保证精确 tokenizer 上限；短节选仍可能增加查找次数或语义遗漏风险。
