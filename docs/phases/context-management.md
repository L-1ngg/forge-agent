---
doc_kind: plan
created: 2026-09-07
---

# 上下文管理方案

> 状态:已实现并完成本地自动化及受控真实任务验收，未推送或发布(2026-09-07) | Owner:operator / Codex | [实现证据](context-management-acceptance.md)

## 目标与范围

让同一任务在多轮模型与工具调用中自动管理上下文，保存真实过程，窗口不足时按 Pi 的方式压缩和有限恢复。设计授权为“剩余还有和上下文工程相关的，请你都直接和pi对齐吧，然后整理一下方案”；后续按“请你依次实现，验收这些tickets”实施。代码、测试与副本转换已验收，未迁移用户数据、推送或发布版本。

最终决策以 [ADR-014](../decisions/014-pi-aligned-context-management.md) 为准；[ADR-012](../decisions/012-context-management-direction.md) 留作历史访谈记录，[ADR-013](../decisions/013-incremental-session-persistence.md) 保留逐步保存与 SDK 存储故障原则。本稿替换旧施工图的多轮提案，不再保留待选算法和任意预算常量。

需求规格、用户故事与任务级状态见 [GitHub #2](https://github.com/L-1ngg/forge-agent/issues/2)；本稿维护跨模块施工和 AC-PICTX 验收，不另存一份 Issue 正文。

基准为 earendil-works/pi coding-agent，SHA `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`。Forge 仍使用 Bun/TypeScript、自研 ExecutionCore 和 pi-ai 适配层；本地 pi-ai 0.84.4 的可用 API 在实施时按锁定依赖核对，不将新 AgentHarness 搬入项目。

## 一、完整执行流程

```text
输入按既有 FIFO 进入上下文并保存
  -> 从当前分支重建消息，过滤中断响应并补缺失结果
  -> 校验 usage 有效性，估算上下文
  -> 自动压缩开启且超过 W - reserveTokens？
       是：一次压缩操作 -> 成功保存摘要 / 失败保留当前视图
  -> pi-port 发起普通任务请求
  -> 保存完成的 assistant（包含失败状态）
  -> 明确 overflow 或可恢复 length？
       是：本失败链尚未恢复且自动压缩开启
             -> 压缩成功 -> 排除失败响应后重试一次
             -> 压缩失败或已恢复 -> 停止该次恢复
  -> 合法工具调用：执行整批 -> 按调用顺序保存结果
  -> 消费下一批可处理输入，再准备下一次请求
```

- 每次请求准备只做一次主动压缩操作，不循环压缩至低于阈值。刚保存 compaction 且无新增记录时跳过原地重复压缩。
- 当前 user、已消费 steer/followUp 可以进入旧前缀摘要；system prompt 和工具定义仍单独完整提供。近期原文顺序和 provider signatures 保留。
- 工具批次未结束不压缩、不补假结果；失败响应中的半截调用不执行，已有工具不重放。
- 成功 stop 回答报告用量超窗时，保留回答、压缩后续上下文，不重新生成回答。
- 连续失败链中 overflow 与 `length && model.maxTokens > 0 && usage.output < model.maxTokens` 共用一次恢复；部分输出不排除恢复。新 user 实际进入执行流或任务 assistant 非 error/length 完成后重置，摘要完成不重置。
- 取消、迭代器关闭和 dispose 停止后续工作并等待清理；存储写入失败优先停用实例，不进入“压缩失败继续请求”分支。

## 二、参数与请求

| 设置 | 最终规则 |
|---|---|
| `context.enabled` | 默认 true；false 禁用主动压缩及 overflow/length 自动恢复，手动 compact 仍可用 |
| `reserveTokens` | 默认 16384；严格 `contextTokens > W - reserveTokens` 时触发 |
| `keepRecentTokens` | 默认 20000，近期原文选择目标，不是最终上下文上限 |
| 普通任务输出 | pi-ai 默认/宿主显式配置映射；无 Forge 的 B/M 硬准入或额外16K/W四分之一上限 |
| 历史摘要输出 | `floor(0.8 * reserveTokens)`，模型 maxTokens 为正时与其取 min |
| turn 前缀摘要输出 | `floor(0.5 * reserveTokens)`，模型 maxTokens 为正时与其取 min |
| `summaryReasoning` | 默认 inherit；off 为保留的项目扩展，不支持时继承并报告 |
| 摘要重试 | 主任务策略；缺省 enabled=true、maxRetries=3、baseDelayMs=2000，即2/4/8秒退避 |
| 累计调用额度 | 不设每次 compaction/invocation 总额度，累计次数及 usage 可观察 |

R/K做合法数值校验，不按窗口比例改写默认值，也不因 R >= W 新增普通请求门禁；小窗口可能每次触发检查，仍按单次准备/无材料规则处理。未知窗口沿用现有模型注册/宿主声明契约，不能显示准确阈值。W=200000时触发线为183616，等于边界不触发，180000也不因旧B被拒绝。

reserveTokens不等于实际输出上限。供应商可能将thinking加到基础maxTokens再clamp；适配器记录有效参数，不承诺精确装入。摘要同样不设独立的本地硬准入门禁：序列化和输出适配后发请求，实际超限走摘要失败处理。

### 计量依据

最近有效任务assistant的usage.totalTokens为依据，缺少/零值时合计input/output/cacheRead/cacheWrite；后续新增消息采用Pi chars/4启发式，图片估算，不宣称精确tokenizer或数学上界。error、aborted、全零usage无效。

保留Forge有效性约束：关联model/provider/API、system/tools、分支及被计量前缀；压缩或投影变化后旧依据失效。无有效依据时全量估算，未被usage覆盖的system/tools计入，已有覆盖不重复相加。保留历史usage，但摘要usage不作任务依据，不跨模型换算。

## 三、摘要算法

1. 固定当前分支快照，从最新有效压缩边界开始，逆向累计近期消息估算量。按Pi findCutPoint选择合法user/assistant切点，不在toolResult开始切分；K不是至少保留的精确量，不强拆工具配对。
2. 切在用户turn中间时，分成此前历史与被省略的turn前缀；旧摘要进入历史更新模板。最多两个逻辑请求顺序执行，没有通用分块、递归摘要或模型合并。
3. 独立摘要system要求仅总结、不继续对话；序列化消息放入conversation标签，旧摘要放入previous-summary标签。保留文本、thinking和调用参数的文字表示；每个toolResult文本只取前2000个JS字符并标记省略。这不改会话原记录，也不是普通工具预览的50KiB限制。
4. 历史模板采用Goal、Constraints & Preferences、Progress、Key Decisions、Next Steps、Critical Context；增量更新保留有效事实、更新进度、移除失效内容。turn前缀采用Original Request、Early Progress、Context for Suffix。
5. 使用当前主模型、相同路由/认证及有效重试策略；摘要cacheRetention为none，沿用session routing ID，无工具定义。主任务system/tools不复制为摘要的活动指令。
6. 两部分成功后直接拼接历史摘要及Turn Context (split turn)。从read/write/edit调用收集路径，继承上次文件列表，在details保存readFiles/modifiedFiles并附到摘要。这是调用记录，不独立证明修改成功，不解析Bash推断所有文件副作用。
7. 保存compaction并重建上下文；有效摘要不要求token严格减少，不受总量目标或频繁触发门槛限制。

保留基本发布校验：取消、error、length、工具调用及空摘要不发布成功；firstKeptEntryId须为本分支合法边界。不要求模型生成覆盖ID/合法引用清单或严格机器可解析章节，不额外评价或修复摘要。结构检查不证明语义保真。

默认两个逻辑请求各最多四次尝试，因此最多八次模型调用入口尝试；不是maxCompactionCalls=8或任意适配器底层HTTP次数保证。provider重试显式关闭，由内核唯一控制摘要整体重试；只重试分类器识别的临时网络/限流/服务错误。认证/永久额度错误、取消、length及无效正文不重试，自定义直接抛错不无条件重试。

摘要输入过大时不拆成更多请求；主动压缩失败可继续任务请求，恢复压缩失败则停止恢复。下一次新压缩可再次尝试，不因此前累计调用数禁用。

## 四、工具输出与找回

删除core统一token限额、整批配额分配、正文切片投影和read_context。工具返回什么就记录什么并传给模型；自定义工具自行截断并提供续读方式，SDK说明责任。工具状态和调用对应关系不因体积被删除。

| 工具 | 模型可见行为 |
|---|---|
| Read | UTF-8文本默认最多2000行/50KiB，取头；采用1-based offset及行数limit，截断提示下一offset |
| Bash | stdout/stderr按采集回调顺序合并，默认最多2000行/50KiB尾部预览，附截断及临时日志路径 |
| Write / Edit | 沿用小型结果/差异摘要，不新增全文归档；保留权限链及结构化TUI适配 |
| 自定义工具 | 作者负责体积与续读，core不统一截断，不保证整批固定上界 |

50KiB限制预览正文，随后附加提示/元数据另计。Read首行已超字节上限时明确提示更细粒度读取，不返回永不前进的分页；Bash允许单长行尾部片段并标记。Read按Pi先完整readFile再选行，不保留旧方案的流式分页内存保证。当前start_line/end_line在实施时迁移至offset/limit并同步文档，不维护双参数体系。

本批不新增grep/find/ls；Pi可选工具的限额见调研，未来新增时参考。原始会话记录供宿主查看/导出，模型不新增专用历史读取工具。普通Read是当前文件，不冒充历史快照；已被工具丢弃的数据不能由会话恢复。

### Bash 临时日志

- 小输出留内存，超过预览阈值才在os.tmpdir创建独立随机日志，补写此前已采集字节并继续写后续内容；会话只保存预览/路径/结果，不保存日志全文。
- 无单命令、会话或全局日志配额，无TTL、启动清扫或任务结束删除；系统/用户清理，应用关闭句柄。不承诺系统及时清理、永久可用或磁盘有界。
- 模型使用普通Read补查，仍走现有权限链；缺失文件按普通读取错误报告，不影响会话重开。
- 正常、非零退出、超时和取消尽可能保留已采集预览及路径。日志写失败按普通工具错误处理，停止采集/命令并等待收尾，不重跑补日志，不声称日志完整，不增加继续执行与日志修复状态机。
- 实现从创建开始监听写流错误并等待背压，正确处理取消和句柄收尾。这是保留的工程约束，Pi原实现不提供同样保证；不据其缺陷承诺磁盘失败后命令继续。
- 合并流按实际采集顺序记录，无额外stdout/stderr持久双份；调整Forge现有结构化Bash结果时同步protocol及TUI，不伪造无法还原的流顺序。

## 五、记录、重建与存储

沿用已有SessionStore的JSONL/parent链，增加compaction记录，不保存任意投影图。Forge格式升级v4，只用于本项目，不承诺直接读写Pi JSONL。

```ts
type ContextEntry = MessageEntry | CompactionEntry;
// 两类均有 id、parentId、timestamp；message保留现有SessionMessage。
type CompactionData = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;
  details?: { readFiles: string[]; modifiedFiles: string[] };
};
interface SessionStorage {
  load(): Promise<{ entries: ContextEntry[]; leafId: string | null }>;
  append(entry: ContextEntry): Promise<void>;
}
```

这是目标合同草图：core生成ID/parent，串行追加；Promise成功代表可加载，而非只进入后台缓冲。MemorySessionStorage深拷贝，文件实现成功写入后发布内存head。导出类型沿用protocol命名，实施时同步所有宿主，不保留appendTurn第二保存路径。

### 保存顺序

- user实际消费时进入上下文，按原processed含义通知并等待保存，再发请求；未消费输入不写。不照搬Pi首个assistant前延迟flush优化，不削弱Forge存储成功合同。
- 完成assistant在工具调度或恢复前保存，包含已取得的error/aborted部分内容；不逐token写盘。
- 并行工具可按完成顺序通知tool_execution_end；整批settle后按调用顺序保存toolResult，再发模型请求。取消仍等待已启动工具收尾、保存已形成结果，未启动调用不伪造真实执行记录。
- compaction所有必要摘要有效后独立保存，成功再替换视图；写入开始后取消仍等待结果，已保存记录不回滚。
- 保存失败停止新调度并停用实例，已运行工具收尾；不盲重试追加或吞成摘要失败。公开message_end不等于持久化ACK，正常迭代完成等待必要保存。

### 重建与请求转换

沿选中leaf的parent链取分支。无compaction时使用原消息；有最新compaction时，生成历史摘要user消息，加firstKeptEntryId起至该compaction之前的保留消息，再加后续消息。不重复加入已覆盖前缀；后续压缩更新上一摘要并推进边界。

请求整条过滤error/aborted assistant；完整调用缺结果时仅在请求投影补关联toolCallId的错误提示，明确执行/副作用未知，不写原历史、不重放工具。当前运行中的调用不提前补结果，触发恢复的length响应也从该恢复视图排除；转换结果计入估算，不能给已过滤调用生成孤立结果。

### 加载与转换

按Pi逐行容错读取方向，坏JSON行跳过并报告；有效header、记录身份和可重建选中分支仍须检查。坏行造成父链/compaction边界不可解释时拒绝该视图，不猜测补历史。不因缺toolResult拒绝加载；无末尾换行但JSON完整仍可读，区别半截JSON。

不自动修复/重写operator源文件。v3升级通过显式副本转换，保留分支、ID及消息，目标存在则失败；校验后切换宿主使用路径。损坏文件或无换行尾部需继续追加时也先生成可追加副本。Pi原地migration/补换行属于不照搬的磁盘操作；本轮不执行转换。

## 六、配置与交互

- SDK提供compact(customInstructions?)及自动压缩配置更新能力；CLI复用现有命令分发接入 `/compact [instructions]`，TUI不新增命令解析器。
- 手动compact先abort并等待当前执行/写入收尾，faulted实例拒绝继续；手动完成不自动续跑旧任务，不能与runTurn重叠调度。
- instructions仅作为历史摘要Additional focus，不覆盖摘要system、不作为主任务输入；自动压缩关闭不影响手动操作和工具截断。
- SessionEvent提供compaction start/end/error、摘要retry、任务recovery及usage：操作ID、reason、before/after估算、生效推理、次数和失败原因。无材料为skipped，不伪装成功。
- TUI简短显示压缩/重试/恢复/失败及用量；失效usage显示估算或未知。摘要输出不混入任务回答；已有部分输出失败时区分失败尝试与后续回答，不假装流从未输出或保证断点续写。
- model/system/tools等变更按已确认有效性规则失效usage，不扩展Pi整套hook、摘要编辑器或上下文仪表盘。

## 七、模块与实施批次

| 模块 | 职责 |
|---|---|
| packages/core/src/context/ | 内部重建、估算/有效性、切点及摘要调度，不开放任意策略插件 |
| execution-core.ts | 请求准备、恢复、可等待保存点和取消收尾，仍拥有循环 |
| pi-port.ts | 模型流/独立摘要、provider参数与错误转换 |
| session-storage.ts / session-store.ts | 消息/压缩追加、v4、内存/文件加载与副本转换 |
| packages/tools/ | Read行分页/head截断、Bash tail及临时日志 |
| SDK / CLI / TUI | compact/开关/事件，复用权限与主界面，同步双语公共指南 |

| 批次 | 内容 | 验证 |
|---|---|---|
| B1 | 记录类型、重建、估算/失效及切点 | 多分支/多次压缩、中文/JSON/图片、工具配对 |
| B2 | 循环保存点、存储及副本转换 | 慢写/部分写失败、取消保留、旧格式转换 |
| B3 | Read/Bash预览与日志 | 行/字节/多字节边界、磁盘异常/取消、路径补查 |
| B4 | 摘要请求、重试/恢复及开关 | 本地HTTP、provider请求形状、连续失败链 |
| B5 | SDK/CLI/TUI、公共文档及验收 | PTY/手动压缩、完整check、受控真实长任务 |

不新增Team/RAG、全套Pi工具或进程崩溃后自动执行。规格已按后续to-spec授权发布到GitHub #2，不改变TUI优先级；代码施工时按[Issue tracker](../agents/issue-tracker.md)组织任务并记录届时基线。规格发布不代表任一批次完成。

## 八、验收与验证

本验收集替代旧施工图AC-CTX-01至20，使用新前缀避免复用旧含义。

- [x] AC-PICTX-01：固定阈值严格边界及K合法切点正确，旧user可摘要，无旧B/比例目标/强制压缩变小。
- [x] AC-PICTX-02：有效usage加增量和全量回退正确；压缩/model/system/tools/分支/投影变化失效，固定材料不重复计数、摘要usage隔离。
- [x] AC-PICTX-03：最多历史/turn前缀两个逻辑摘要，固定模板直接拼接、工具结果前2000字符；无分块/模型合并/独立本地硬准入，无效摘要不发布。
- [x] AC-PICTX-04：Anthropic adaptive/non-adaptive及OpenAI Responses/Chat输出映射正确；默认推理继承、off/不支持回退，摘要cacheRetention为none且路由可追踪。
- [x] AC-PICTX-05：默认2/4/8秒退避、主任务覆盖/禁用生效，无底层叠加重试，永久错误/取消/length不重试；两摘要各第四次成功共八次可完成，累计超过32次不禁用后续压缩。
- [x] AC-PICTX-06：无材料/摘要失败主动路径继续、恢复路径不重试；摘要未变小或频繁压缩不停止；一次准备不循环，无新增记录不重复压缩。
- [x] AC-PICTX-07：overflow/Pi length规则共用连续失败链一次恢复，已有部分输出可恢复；失败历史保留但请求排除，不执行截断调用或重放工具；成功回答超窗不重新生成。
- [x] AC-PICTX-08：Read/Bash默认2000行/50KiB head/tail、offset/limit和长行提示正确，附加信息不冒称正文限额；自定义工具没有隐藏core截断或整批配额。
- [x] AC-PICTX-09：Bash阈值前后字节落入临时文件，合并预览正确；非零退出/超时/取消保留采集信息，写失败无未处理事件且正确收尾；无配额/TTL/退出删除，普通Read补查与文件缺失可复现。
- [x] AC-PICTX-10：user/assistant/toolResult/compaction按保存边界逐步加载；取消保留过程，慢写及部分写入异常停止新调度并fault，不退回整次成功保存。
- [x] AC-PICTX-11：多分支/多次压缩重建无重复乱序；中断过滤、缺失结果只补请求且不改历史；完整无换行行可读、坏行诊断及不可解释分支拒绝，v3副本转换不覆盖源/目标。
- [x] AC-PICTX-12：enabled=false禁止自动压缩/恢复但手动可用；compact等待当前任务停止、不续跑，instructions不污染任务；状态、取消和部分失败尝试展示正确。
- [x] AC-PICTX-13：Storage/SDK/CLI/TUI合同与双语README/SDK/示例同步；相关回归及完整 `bun run check` 通过。
- [x] AC-PICTX-14：受控真实任务跑通多轮工具、自动压缩、继续工作及会话重开；核对模型/请求/usage及摘要关键事实，未执行的物理超限/provider矩阵/断电恢复分别注明。

纯逻辑采用表驱动/属性用例；运行路径使用受控模型、本地HTTP和虚拟时钟；存储/工具注入延迟、异常和取消，终端使用PTY。回归覆盖局部重试、无累计调用帽、无效摘要拒绝、工具不重放、取消或存储失败后停止调度和逐步保存；实际执行的反向验证见[实现证据](context-management-acceptance.md)。

真实provider由测试宿主设置实验调用/费用保护，不写回产品累计额度。不用低本地阈值冒充物理窗口溢出，也不以摘要变短证明语义保真。

## 发布与回退

存储合同、core、SDK和CLI同版本交付；旧二进制不能读v4而静默丢弃压缩。升级只写副本，回退使用保留旧文件与匹配版本；关闭自动压缩不等于旧格式兼容。本批完成实现与验收核对，未推送、发布或迁移用户数据，未测项见[实现证据](context-management-acceptance.md)。

## 设计阶段证据与限制

以下保留设计整理时的证据。后续实现的全部 AC 对照、388 项测试、真实 xAI 任务和未测边界见[实现与验收](context-management-acceptance.md)；任务级状态仍以 GitHub Issues 为准。

来源：[Pi总调研](../research/pi-context-management.md)、[工具核对](../research/pi-context-tools-final.md)、[会话核对](../research/pi-context-session-final.md)。保留的Forge差异集中列在ADR-014。

- Ran：核对固定Pi源码与当前Forge循环/存储/工具入口；整理ADR替代关系、最终合同/批次/验收；检查文档链接、空白和旧提案残留。
- Not run：运行代码实现、测试套件、真实模型、磁盘故障注入、会话转换与CLI/TUI验收。
- Why：授权为对齐决策与整理方案，当前runtime仍是旧行为。
- Risk：估算和摘要不保证精确无遗漏；无整批工具/累计摘要/日志全局上限，Read可全量加载大文件，固定摘要流程无法兜底任意超大输入。Pi的I/O及容错加载局限如实标明，实施须完成相应故障验证。
