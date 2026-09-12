---
doc_kind: plan
created: 2026-09-07
---

# 主界面工作流与启动页设计

> 状态:本轮 UI/UX 已完成并经 operator 确认 WSL 人工验收通过(2026-09-07)。实现、双轴审查及自动化检查已完成,代码本地提交为 `19f87d5`,包含依赖的 TUI 基础修复,排除上下文管理工作。

需求规格与任务进度见 [GitHub #1](https://github.com/L-1ngg/forge-agent/issues/1)。本文继续维护整体施工设计、AC-UI 跨流程验收与验证证据。

保持本页交互行为的内部职责调整见[主界面工具浏览 module 深化](transcript-browser.md)。

## Why

operator 原话:

> 上面的两个问题解决了，但是实际上的CLI的UIUX体验和grok build差距依旧很大，比如工具结果不能展开，布局不如grok build好。

随后确认:

> 覆盖主界面的完整工作流
> 支持两种查看方式，具体行为你参考grokbuild的设计就知道了

执行边界与环境确认:

> 1.按你的推荐来，2.我目前使用的是wsl验证的

其中推荐项是保留 Forge 已定的停止、队列和权限语义,主界面浏览与布局对齐 grok。WSL 是已确认的运行环境;外层终端程序、版本及是否经过 tmux/SSH 在实际验收时补记,不假定为 Windows Terminal。

启动页补充要求:

> 还需要加一点UI相关的，就是初始页面(刚启动agent)，可以参考opencode的设计，类像素画，但文案换成forge-agent

前次修复及测试证据保留在 [Phase 2.2](phase-2.2.md#2026-09-07-后续-ui-修复)。新设计以完整阅读与操作路径验收。原有 golden 只能证明 Forge 的已知输出不漂移,不能证明达到 grok 的 UIUX。

## 已确认范围与依据

- 覆盖输入、多行编辑与补全、运行与排队反馈、消息/工具浏览、权限交互、底部状态、短窗口与 resize。
- 启动空状态参考 OpenCode 的终端像素字标与居中输入布局;品牌文字严格为 `forge-agent`。进入会话后的布局与交互继续按 grok 参考设计。
- 工具结果默认只显示调用摘要;支持就地展开和独立详情,具体导航与展示以 grok 源码为参考。术语见 [CONTEXT.md](../../CONTEXT.md#主界面工具浏览)。
- 使用本地 grok checkout 的实际 Git HEAD `bc7f02eddd3d84085849dc19ed216f11c23b0571`。`SOURCE_REV` 文件内容为 `d5a0335a47221e8c9519936cb693e9b6450227ec`,两者不同;本文的源码链接以实际 HEAD 为准。所读文件无 tracked 修改,未使用额外的未跟踪 bin 文件。
- 继续遵守 [ADR-005](../decisions/005-tui-own-compositor.md) 的自有 compositor 与依赖约束、[ADR-007](../decisions/007-no-compile-grok-reference.md) 的源码对照方法。
- Team、dashboard、媒体、语音、后台任务系统与新执行模式不因“主界面对齐”自动纳入。

## Entry Criteria

| 检查 | 通过标准 | 未通过时 |
|---|---|---|
| 范围 | 完整主界面和两种查看方式已确认 | 本项已满足 |
| 契约 | 保留 ADR-010 执行语义,浏览交互按下文作用域划分 | 本项已确认;若施工需改动执行契约,另作决策 |
| 参考 | 固定源码行为、配置条件与场景有可追溯证据 | 补查源码和测试 |
| 环境 | 在 WSL 执行自动化与人工体验验证;验收时记录外层终端及连接路径 | 外层终端信息不阻塞设计与开发,不据此宣称复制/组合键已实测 |
| 工作区 | 保留现有未提交修复和其他工作流的文档 | 仅按任务边界增量修改 |

## 交互设计

### 0. 启动空状态

首次进入空会话时,以像素风 `forge-agent` 字标作为视觉主体,下方直接提供可编辑输入框。它是可操作的空会话界面,不是需要等待或按键跳过的启动动画。

- 字标参考 OpenCode 的四行字符画,用整块/上半块/下半块字符形成像素轮廓和轻微阴影;按 `forge-agent` 重新绘制字形,保留小写和连字符的识别。采用克制的明暗分段,与现有主题配合。
- 由现有 TerminalFrame 绘制,不依赖图片协议、bitmap、浏览器或新的 TUI 框架。字标按 cell 布局,不允许终端自行换行破坏字形。
- 字标和输入区横向居中,输入区默认最大 75 列,两侧至少各留 2 列;上下空白随高度收缩,必要底栏独立留在底部。输入区复用真实 composer,支持已有编辑、粘贴与补全,不另做假输入框。
- 不保留当前欢迎页的说明性长句,不加入宣传文案或额外进入按钮。模型、目录等状态按主界面的唯一信息位置展示。
- 宽高足够时显示完整四行字标;不足以同时容纳字标、输入与必要底栏时降级为单行 `forge-agent`,优先保证输入可用。该降级是 Forge 的适配决策,不声称 OpenCode 源码已有。
- 首次提交后切换到常规会话布局,输入框回到底部;现有历史会话直接展示历史。补全、输入错误或 resize 不得清空草稿,也不能把启动字标覆盖到已有会话上。

固定参考为 OpenCode `57ef3828431790c53f8f333c7ffbfe88770a1812`:
[四行字标模板](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/tui/src/logo.ts#L1)、[字符与阴影渲染](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/tui/src/component/logo.tsx#L6)、[Home 布局与真实 Prompt](https://github.com/anomalyco/opencode/blob/57ef3828431790c53f8f333c7ffbfe88770a1812/packages/tui/src/routes/home.tsx#L70)。原始 `opencode` 模板宽 39 列;`forge-agent` 的新字形宽度须按实际模板核算,不照抄这一数值。OpenCode 的弹性空白可收缩,但此处所读 home/logo 源码没有小字标降级分支。

### 1. 焦点与条目选择

输入框、对话浏览、权限卡片、详情视图各自拥有输入焦点。选中的条目与滚动位置独立保存,不能再用“最后一个可折叠条目”替代用户目标。

| 状态 | 动作 | 结果 |
|---|---|---|
| 输入框,局部补全未消费按键 | Tab | 切换到对话浏览,草稿保留 |
| 对话浏览 | Tab / i / Space | 返回输入框;有停放的请求时优先恢复请求 |
| 对话浏览 | 上下键 / j、k | 选择前后条目,选中状态可见 |
| 对话浏览 | PageUp / PageDown、滚轮 | 浏览历史,不编辑草稿 |
| 对话浏览 | G | 到最新内容并恢复跟随 |
| 条目 | 单击 | 选中条目 |
| 条目折叠区域 | 双击 / e | 按该类条目的折叠策略切换 |
| 选中条目 | 左右键 / h、l | 明确收起 / 完整就地展开 |
| 选中条目 | Enter / Ctrl+F | 打开该条目的详情,无须先展开 |
| 对话浏览 | y / Y | 复制选中条目正文 / 路径或命令 |

上述字母键仅在相应浏览焦点内生效,不能抢走输入框文字。正文拖选与标题折叠按不同命中区域处理;单击、双击、释放和拖动是独立事件,不得把双击实现成两次切换。

参考:[actions/defaults.rs](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/actions/defaults.rs#L83)、[selection.rs](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/selection.rs#L962)。默认拖选采用 grok 的 flash 行为:释放复制并短暂高亮;不将 word_select 或 hold 当作同一默认。

### 2. 工具就地展示

工具调用、状态和结果始终属于同一条目。read、execute、edit 使用各自的标题、正文与错误呈现,普通工具也必须能查看完整结果;不能再次落为不可操作的普通 assistant 文本。

| read 模式 / 动作 | 内容 |
|---|---|
| 默认 Collapsed | Read 路径及读取范围;不显示正文 |
| Collapsed 后双击或 e | Truncated:前 5 行、后 3 行及省略标识,短内容不重复 |
| Truncated 或 Expanded 后双击或 e | 回到 Collapsed |
| Right / l | Expanded:完整就地正文 |
| Enter / Ctrl+F | 独立详情中的完整正文 |

标题、行号、正文换行、面板背景和间隔参考 [read.rs](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/read.rs#L349)。read 无内容而有错误时,源码不提供常规折叠,但允许详情查看错误;必须保留可见的失败状态与详情入口。Agent execute 默认收起;用户主动执行 shell 的特殊模式不属于本项目既有功能,不一并引入。

### 3. 独立详情

全屏阅读当前条目,不挤占主界面的输入框。详情打开期间保留主界面草稿、选中条目与滚动锚点,关闭后恢复。

- read:完整文件正文、绝对行号、代码呈现。execute:命令、输出与失败信息。edit:文件路径和完整 diff。普通工具:调用参数与可读取的完整结果。
- 上下键/j、k 逐行、PageUp/PageDown 翻页、Ctrl+D/U 半页、w 切换换行。
- `/` 搜索、f 过滤、n/N 前后匹配;搜索栏收到 Enter 后进入匹配浏览,Esc 先退出局部输入。
- v/V 范围选择、y 复制当前行或选区、Y 复制路径/命令;与主界面 y 复制整块的作用域区分。
- 无局部搜索/选区时 Esc/q 关闭详情;Ctrl+F 关闭详情。退出不会发送草稿、取消任务或改变工具权限。
- 活跃 execute 的输出可更新并跟随,F 控制跟随;静态 read 不启用动态跟随。

参考:[详情构建](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/dispatch/transcript.rs#L274)、[block_viewer.rs](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/block_viewer.rs#L405)、[详情按键与搜索](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/list_pane/state/methods.rs#L1577)。

### 4. 阅读位置与流更新

采用 grok `respect_manual_folds=true` 对应的阅读策略:人工展开/上翻后保持阅读位置,明确回到底部才恢复跟随。此项是本项目采用的阅读策略,该快照编译默认实际为 false,不能写成 grok 的无条件默认。

同一条目的鼠标与键盘展开必须具有一致的阅读起点。后续工具更新、布局变化和窗口缩放依靠条目身份与行内锚点恢复;不能因为选区或详情活动把输出拉回底部。

动态 viewer 的 grok 实现在结束时选中末行。本项目仅在原来跟随时跟到末行,主动向上阅读时保持位置,与本节人工阅读不被流更新打断的规则一致。依据:[selection_tests.rs](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/state/selection_tests.rs#L528)、[viewer 更新](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/block_viewer.rs#L1004)。

### 5. 主界面布局与输入

布局按同一状态图分配可用行,覆盖空会话、流式输出、多个工具、历史浏览、多行输入、权限请求、队列和详情返回。

| 区域 / 场景 | 设计规则 | 与当前实现的差异 |
|---|---|---|
| 外层区域 | 普通模式左右各 2 列、上下各 1 行;高度 <=20 时紧凑,左右各 1 列、上下 0 行;<=16 去除可选提示与 prompt gap | 当前 compositor 区域绘制和点击坐标未共享完整外层 Rect |
| 垂直顺序 | session 信息、transcript、队列/运行状态、composer 或请求、可选会话指标、shortcuts | 当前 activity 与指标混在一行,队列在布局后占用 transcript |
| 行预算 | transcript 目标至少 5 行,shortcuts 1 行;优先当前操作,可选状态只取剩余空间;极端小窗按顺序让位并保留返回/退出 | 不将 5 行目标写成所有窗口都能满足的绝对保证;队列进入整体预算 |
| 多行草稿 | 聚焦时按实际软换行增长,上限为屏幕一半并受整体预算约束;浏览历史时默认仅留 1 行正文与 chrome,重新聚焦恢复 | 当前固定最多 5/8 行,没有普通的输入/浏览焦点切换 |
| 条目间距 | 相邻可分组且收起的条目间 0 行;其他可见条目间 1 行;隐藏 thinking 不增加空白;选中框留必要下沿 | 由相邻条目关系决定 spacing,不再给每个收起工具固定底部空行 |
| 连续工具 | 连续探索调用从第一个就形成默认收起的混合摘要,按首次出现顺序组合 Read/Listed/Searched 计数;Run/Edit/Write 独立单行并打断探索聚合;展开组后成员保持独立身份 | 首轮将所有工具按同名分组并默认展开,产生单次调用双行;本轮按 grok VerbRun 修正 |
| 权限请求 | 替换 composer 区域;Esc 先退出内部文本输入,再停放请求;停放后保持可见且 pending,Tab 恢复;停放时粘贴不隐式授权 | 保留已有 park/resume,补齐 cardSubInput 和浏览焦点接线 |
| 运行与指标 | working/等待等在 prompt 上方;稳定指标在下方;model 等信息确定唯一位置,不重复占位 | 复用真实 usage,不引入尚未实现的上下文压缩进度或外部状态脚本 |
| 操作提示 | 随焦点、条目能力和运行状态选择提示;窄宽度保留主要动作与返回/退出 | 沿用现有路由与提示同源机制,补上 selected entry 与 viewer 状态 |

正文仍保持统一 accent 列 1、内部左右 padding 各 2;外层区域与条目内边距分别计算。分组是展示聚合,不改变底层工具调用顺序、权限或执行。双击组标题控制组,成员保持独立选中/展开/详情身份;组不会被错误解析成“最后一个工具”。

依据:[外层与行预算](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/agent.rs#L194)、[prompt 高度](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/render.rs#L1097)、[相邻间距](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/state/layout.rs#L1439)、[工具分组](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/state/verb_group.rs#L1)、[请求焦点](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L123)。

### 6. 执行与权限边界

| 行为 | 当前 Forge | grok 参考 | 本轮规则 |
|---|---|---|---|
| Ctrl+Enter | 停止旧任务后发送指定输入 | 向当前任务插入消息 | 输入框内保留 ADR-010 的停止并发送 |
| 普通停止与队列 | 暂停自动发送,恢复未处理输入 | 有其自身 queue/interject 规则 | 不通过 UI 改动隐式替换已定契约 |
| Ctrl+O | 操作最后一个折叠块 | 切换自动批准权限 | 移除旧的最近条目折叠绑定,不绑定自动批准;e/左右键操作选中条目 |
| Ctrl+C | 退出并恢复终端 | 依草稿状态清空/取消,退出另有按键 | 保留全局退出与终端恢复 |

取消和返回按作用域决定:详情内 Esc 先关闭搜索/选区,再关闭详情;请求内 Esc 先退出内部文本输入,再停放请求,已停放时不取消任务;普通输入/浏览焦点的 Esc 在运行时按 ADR-010 停止任务并保留草稿。补全等局部控件优先消费 Esc。Enter 在输入框发送或排队,在浏览区打开详情,在请求内仅执行已选择的明确动作。

参考:[grok 输入与取消](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/actions/defaults.rs#L502)、[grok interject](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/actions/defaults.rs#L635)、[ADR-010](../decisions/010-input-ownership-and-interruption.md)。不得因为打开详情、导航或复制发出授权响应。

## 实施组织

1. 按 operator 最新确认,在当前工作区的正式 TUI 上增量实现,保留所有已有未提交改动;不另开独立工作区或一次性原型。用确定性事件场景驱动真实终端中的完整工作流,不以静态截图代替操作。
2. 统一焦点、选择、鼠标命中和动作路由,再接入就地模式、详情和滚动锚点。已有 projector、frame、host 作为底座,不预设再次清空重写。
3. 对齐消息/工具呈现、输入与权限区域、状态栏和短终端布局。按现有包边界施工,若第三方文本渲染能力与 ADR-005 冲突,先提出具体决策,不私自加依赖。
4. 将以下跨流程验收逐条落到可复现输入、可见结果与反向验证,最后进行实际终端人工验收。

主要变更边界预计为 `packages/tui/src/{app,keys,host,layout,input-router,composer,request-card,scroll,welcome}.ts`、`transcript/` 与新增的详情/选择模块。最终文件切分在施工时按现有 API 确定,不先为每个术语创建模块。

## Acceptance Criteria

以下是本设计的跨流程验收。自动化证据见各实施记录,WSL 整体人工验收已由 operator 确认;其余条目保留原逐项记录,不将整体确认扩写为未提供的逐项操作日志。后续 issue 只引用这些跨流程标准,任务级范围另在 issue 定义。

- [ ] AC-UI-01:在有多次工具调用的历史中,用鼠标和键盘选中较早的调用,预览/完整展开/收起只影响目标;双击不会切换两次。
- [ ] AC-UI-02:不先就地展开也能打开工具详情;查看全文、搜索、复制后返回,草稿、选中条目和阅读位置保持。
- [ ] AC-UI-03:read、execute、edit、普通工具及失败调用均有可识别摘要和正确详情;默认无正文泄露,更新/完成不产生重复条目。
- [ ] AC-UI-04:后台继续输出、工具完成和 resize 时,主动阅读的历史与详情不会跳动;明确跟随时能看到最新内容。
- [ ] AC-UI-05:同一组空闲/流式/工具/输入/权限/队列场景在 40x12、80x24、120x32 下无重叠,文字可达,窄窗口保留返回和退出路径。
- [ ] AC-UI-06:编辑、补全、浏览、详情、权限之间切换,按键只由当前作用域处理;复制/导航不提交输入或作出授权。
- [ ] AC-UI-07:运行中输入、停止、指定重发、失败保留草稿符合 ADR-010;既有执行契约回归继续通过。
- [x] AC-UI-08:有代表性的终端交互完成 operator 人工验收;记录实际终端、版本、窗口尺寸和复现步骤,不能仅以自生成 golden 或 PTY 通过代替。operator 已确认 WSL 人工验收通过,确认原话及已知环境见文末记录。
- [ ] AC-UI-09:连续 10 次 read 的分组标题随调用更新,失败可见;打开组并查看中间成员的详情后返回,成员身份与原组仍正确,不会操作最新的另一条工具。
- [ ] AC-UI-10:多行草稿在输入与浏览间切换后文本/光标不丢失;pending 请求内部退出、停放、粘贴、恢复不误答;队列与运行状态加入布局后不造成历史/输入重叠。
- [ ] AC-UI-11:80x24、120x32 的启动空状态显示可识别的像素风 `forge-agent` 字标与真实输入框;40x12 下按可用空间降级,品牌名完整、输入和必要底栏不被挤出。WSL 实际终端核对块字符和半块字符的显示。
- [ ] AC-UI-12:从启动页输入/粘贴、打开补全、缩放窗口并发送第一条消息后进入常规会话布局,文字与光标状态不丢失;有历史的会话不显示启动字标,无需额外按键跳过启动页。

## Verify / Release / Rollback

- 单元层覆盖焦点/选择/折叠/锚点;cell 层将 grok 源码导出的期望与 Forge 输出比较,不从待测实现自动生成全部答案。
- 真实 PTY 驱动实际 tools + 本地 provider,覆盖完整动作序列、CJK/长行、多工具、流更新、请求焦点与 resize。至少故意破坏一次双击或选中目标逻辑,对应回归必须变红。
- 人工验收使用运行中的主界面和详情,记录多步操作;终端画面作为辅证。复制需在实际终端验证,无可确认交付时不能显示虚假的成功。
- 发布出口为已确认 AC 与项目检查通过、operator 人工体验确认。源码读取不构成已运行 grok,不承诺跨终端像素一致。
- 按焦点/导航、详情、布局几个可独立回退批次组织。回退不能触碰用户草稿、工具外部副作用或其他工作流改动;不改变已有权限的保守结果。

## 当前验证记录

设计阶段证据:只读核对 Forge 与固定 grok 源码和单测、OpenCode 字标与 Home 源码;未执行 grok/OpenCode 进程。

### 首轮体验反馈与修订入口

operator 在运行场景后提供两张截图,明确表示:"[Image #1] 的设计我不是很满意,我想要 [Image #2] 这种设计"。

- 当前截图:单次 Edit、Run、write 也各占一行组标题与一行调用;普通 write 标题直接展示参数 JSON,包含完整 content 值。视觉上重复标题较多,调用摘要缺少统一的可读呈现。
- 参考截图:用户消息背景带、独立 assistant 正文、紧凑的执行记录、混合工具摘要、状态标记、选中行背景及执行区域侧边界共同形成层次;输入与状态区域留在底部。
- 此反馈确认视觉验收尚未通过。截图仅提供可见设计依据,不能单凭画面认定折叠、聚合边界、标题生成方式或后台任务语义;这些规则需核对参考源码并在访谈中确认。
- 本轮先修订设计;不据此增加后台任务能力或修改执行权限契约。新术语在确认后更新 `CONTEXT.md`,实现变更在整体方案确认后推进。

operator 随后确认整体视觉层次,并指示:"图2是我从grok build截图来的,所以你可以直接去找grok build对应的源码,然后改写为ts版本"。以下作为本轮实施规则,取代首轮冲突的展示选择:

- 探索分组使用固定快照 `scrollback/state/verb_group.rs`、`state/groups.rs` 和 `blocks/tool/mod.rs` 的 VerbRun 规则:read/list/search 等可以混合,完成且收起的 thinking 可并入且不计调用数;展开或活动 thinking 保持自身行,不割断探索序列。用户消息、assistant 正文及 Run/Edit/Write 等操作结束探索分组。已支持的工具按明确名称分类,不通过 shell 命令字符串猜测工具类别。
- 摘要默认收起成员,运行/失败可见;人工展开保持。其余连续收起执行行参照 dense truncation,超过 11 条时折叠旧前缀并保留最近 10 条,仍可展开访问。组仅负责呈现,不改变执行和授权。
- Run/Edit/Write 各显示一条紧凑标题;Write 显示路径,完整参数与 content 仅在详情中读取。Run 接收可选调用级 `description`,事件和回放一致携带;没有描述时显示实际 command,不虚构目的。展开及详情保留实际命令。
- 按 `scrollback_pane.rs` 和 `selection.rs` 转写选中行背景、状态标记及选中区域两侧括线,保留 diff/stdout 自身背景。用户消息保留背景带,assistant 正文使用主文字色,密集执行行减少空白。
- 顶部左侧目录、右侧实际上下文用量;模型放在 composer 下沿,运行/队列在输入区上方,快捷提示在底部。全屏采用主题 base 背景,普通窗口保留区域间距,小窗优先保留操作区域。不填充未知分支、任务数、权限模式等假状态。
- `Worked for` 按完整执行完成输出一次,不在每个模型/tool 轮之间插入。grok 依据 `app/turn_completion.rs` 的 prompt completion;Forge 使用现有 `agent_start/agent_end` 执行边界计时,失败/取消不再追加成功耗时标记,重复结束事件不重复插入。
- 启动页继续使用已确认像素字标;详情、输入归属及 ADR-010 契约沿用已确认行为。按原定 App/cell/真实 PTY 边界做回归,新增可审查的实际帧视觉证据,WSL 人工体验仍单独验收。

### 首轮实现记录

- 起始 HEAD 为 `545517d50ec6c4998fdb1f7f8a0b5572534667e1`,开工时已有 TUI 修复和设计文档未提交;上下文管理工作保持独立。先记录 staged/unstaged/untracked 状态与文件副本,审查时区分已有基础与本次增量。
- 沿用真实 PTY + 正式 App + SDK/实际 tools 的验证入口,新增 `tests/tui-integration/main-workflow.test.ts`;App 边界补充历史选择、默认预览、双击、失败详情、会话恢复、请求子输入、拖选和活跃详情更新回归。
- 复制优先使用宿主可用的原生剪贴板命令(WSL 为 `clip.exe`);不具备原生交付条件时请求 OSC 52,只显示 `Copy requested`,不将终端是否接收写成已确认成功。自动化使用替代终端输出验证 OSC 52 请求,不改动用户系统剪贴板。
- 可在实际 WSL 终端运行 `bun tests/tui-integration/main-workflow.fixture.ts` 验证确定性场景:首次发送生成多次实际 read,第二次发送产生 edit/bash/write。场景使用临时目录和本地 provider,退出时清理;真实产品入口仍是 `bun run forge-agent`。
- Ran:最终 `bun run check` 通过,包含依赖边界、各包与自动化脚本类型检查及全仓 314 项测试(53 个文件,0 失败)。新增/更新的 PTY fixture 与测试另经 strict TypeScript 检查通过;`bun run test:headless`、`bun run typecheck:examples` 通过。
- Ran:真实 PTY 工作流与 App 定向检查共 44 项通过,覆盖三种窗口尺寸、实际 read/edit/bash/write、失败详情、中文搜索、复制请求、返回草稿和退出恢复。故意禁用双击时间窗口后,分组/成员回归按预期失败;恢复后通过,未保留故障注入。
- Review / Standards:发现并修复详情拖选遗漏最右字符的问题;未发现项目标准违规,最终修复复核无遗留问题。Review / Spec:发现并修复长行搜索未定位到匹配片段、请求停放后缺少键盘选择标记两项问题;增加回归,最终复核无遗留问题。审查以开工快照区分原有改动与本次实现。
- Not run / Why:未执行 WSL 外层终端人工验收,尚缺实际终端程序、版本及 tmux/SSH 使用情况;未运行 grok/OpenCode 进程或远程模型请求。源码对照、本地 provider 与 PTY 结果不替代这些验证。
- Risk:AC-UI-08 及 AC-UI-11 的实际字形部分仍待 operator 验收;系统剪贴板交付、组合键和布局是否达到预期也需在用户实际终端确认。上述 AC 勾选框保持未验收状态。
- Release(首轮当时):实现依赖开工前未提交的 TUI 基础修复,当时保留工作区结果等待提交范围确认。operator 随后授权本轮 UI/UX 相关改动一起审查并本地提交,上下文管理工作排除在外;不推送或关闭 Issue。

### 视觉修订验证记录

- 基线:在首轮实现上增量修改,HEAD 仍为 `545517d50ec6c4998fdb1f7f8a0b5572534667e1`;另保存此次修订前的工作区副本,与原始开工记录一起隔离用户改动。`CONTEXT.md` 仅修改工具分组术语,不修改并行上下文管理设计。
- 源码依据:固定 grok HEAD `bc7f02eddd3d84085849dc19ed216f11c23b0571` 的 [VerbRun](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/state/verb_group.rs)、[分组扫描](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/state/groups.rs)、[选择框](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/selection.rs)、[Run 呈现](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/execute.rs)、[请求完成](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/turn_completion.rs)。采用 TypeScript/自有 compositor,未新增 TUI 依赖或执行模式。
- Ran:`bun run check` 最终 322 pass / 0 fail,53 个测试文件;包含依赖边界、各包和自动化类型检查。`bun run test:headless`、`bun run typecheck:examples` 通过;两组 PTY fixture/test 的 strict TypeScript 检查通过。
- Ran:新增回归先失败后修复,覆盖单行工具摘要不泄露 Write 正文、混合探索默认收起、组内正文与返回、组首 thinking、长 dense run、未知工具名、三尺寸选中行背景与模型/用量位置、description 开始/成功/失败/回放、长命令全文。完整执行计时回归覆盖多次模型轮和重复结束。
- Golden:仅 `execute-truncated-80`、`execute-failed-80`、`edit-expanded-80` 的首行 marker/标题偏移变化,分别 8、9、22 个 cell;其他 golden 内容不变。更新按本地 golden 约定生成并逐 cell 检查,不作为 grok 运行截图证据。
- Visual:通过真实 PTY 场景导出 cell frame,用本机 Chromium/Playwright 渲染成图片检查,覆盖启动页、探索摘要、120x32/80x24/40x12 工具区域及 40x12 详情。工具区域单行、选中行背景与两侧括线、composer 下沿 caption 可见;窄窗口保留输入与退出。临时画面目录为 `/tmp/forge-tui-visual-captures/`,图片是 Forge frame 的可视化,不是用户外层终端截图。
- Review / Standards:修复继承属性名被误归探索工具、回放 bash 展开缺少实际命令,复审通过。Review / Spec:修复组首 thinking 未聚合、无描述长命令展开仍截断,并核对 Worked 边界修订;复审通过,无遗留发现。
- Not run / Why / Risk:未运行 grok 二进制,未访问远程模型;仍未获得 operator 对新版 WSL 字形、复制、按键和整体视觉的验收结果。截图中后台 Task 能力没有纳入实现。实际产品入口 `bun run forge-agent`;确定性体验入口仍为 `bun tests/tui-integration/main-workflow.fixture.ts`。
- Release(视觉修订当时):保留未提交结果,未推送或关闭 Issue。后续提交范围已获 operator 确认;本轮视觉实现完成不替代完整人工验收记录。

### 回复选择框侵入用户背景带修复

operator 再次提供截图:选中紧邻用户消息的 assistant 回复时,选择框上角挤入上一条用户消息的底部背景。

- 原因:用户消息的 `vpadBottom` 是背景带内部留白,选择框却将回复 `start - 1` 当作外部空行,覆盖上一条的左右背景 cell。相邻紧凑工具无空行时也存在同类边界问题。
- 修复:区分内部 padding 与背景带外侧的 `gapAfter`,用户消息后保留 1 行外部间隔;选择框和选中标记使用正文起点,上下角仅使用实际可用空行,没有空行时侧线限制在选中范围。间隔计入统一高度与滚动位置,不依赖临时覆盖顺序。
- Ran:新增 App 回归先复现背景 cell 被角标及 base 色替换,修复后在 120x32、80x24、40x12 检查用户背景带不变、角标在其下方、详情返回不漂移;另检查相邻紧凑工具行不被覆盖。最终 `bun run check` 为 324 pass / 0 fail,包含类型检查、依赖边界和真实 PTY 流程。组合 golden `transcript-stack-80x16` 的后续内容下移一行,其余本轮 golden 不变。
- Visual / Risk:检查真实 PTY cell frame 的回复选择画面,选择框与用户背景带已分离;图片为 `/tmp/forge-tui-visual-captures/reply-selection-120x32.png`。WSL 外层终端仍需 operator 再次确认。未提交或推送,已有工作区改动保留。

### 工具标记颜色修订

- 按 grok 的 `ExecuteToolCallBlock::accent`、Read/Edit/Other 的 `bullet` 及 `ThinkingBlock::bullet` 区分类型,不再把所有成功工具统一画成绿色。收起的 Read/Edit/Write/普通工具和已完成 Thought 使用中性灰色;成功 Run 使用绿色;失败工具使用错误红色。展开的文件/思考条目使用默认正文色,普通工具使用工具强调色,不将其误标为命令成功。
- 实时 execute/edit block 与历史回放的普通 tool entry 使用一致规则。运行中的 Run 保留运行强调色;本次仅修正颜色分类,未新增 grok 的逐帧呼吸动画或收起彩色标记的额外亮度混合。
- Ran:呈现回归覆盖工具类型与成功/失败/运行状态,新增测试先失败后通过。`bun test packages/tui/test tests/tui-integration/main-workflow.test.ts` 为 176 pass / 0 fail,TUI 类型检查及 `git diff --check` 通过。5 份 golden 各仅改变 marker 及后接空格的前景色,未改几何和正文。未重复全仓非 TUI 测试;WSL 实际观感仍需 operator 确认。

### 本轮提交前审核

operator 指示:"这一轮的uiux优化就先进行到这里了,请你把该范围的相关代码改动审核一下然后提交,其中有关上下文管理的相关代码不用动"。

- Scope:以 `545517d50ec6c4998fdb1f7f8a0b5572534667e1` 为固定基线,对全部相关 tracked/untracked 改动做 Standards / Spec 双轴审查,包含原始滚轮和工具结果归属修复。`CONTEXT.md` 仅纳入工具浏览术语;上下文管理术语、ADR 草稿和研究文档保留在工作区。
- Standards:发现并修复 2 项 P2 问题。旧式 X10 大坐标字节经 UTF-8 解码后变成错误坐标,现仅对其二进制 payload 保留原字节;历史 toolResult 缺少可选 `toolName` 时丢失 read/bash 类型,现从原调用恢复展示名称。复核无遗留问题,未发现项目标准违规或需阻塞的代码异味。
- Spec:发现并修复 1 项 P2 问题。主 transcript 重排使用物理行号导致阅读跳位,现贯穿换行、Markdown、工具呈现保留逻辑行与行内偏移;原始锚点跨纯 resize 保留,用户导航才更新,避免同一超长行反复缩放的累积漂移。最终复核无遗留问题。
- 反向证据:X10 边界回归修复前将坐标 95 解成 65500;无 toolName 的 read/bash App 回归修复前 2 fail;正文缩放回归修复前从 `ROW_044` 跳到 `ROW_009`;单行连续缩放回归修复前从 `W0471` 附近漂到 `W0454`。对应修复后均通过,测试保留正常/失败与主动导航路径。
- Ran:最终 `bun run check` 为 329 pass / 0 fail,53 个测试文件,包含依赖边界、各包和自动化类型检查及真实 PTY。`bun run test:headless`、`bun run typecheck:examples` 与两组 PTY fixture/test 的 strict TypeScript 检查通过;`git diff --check` 通过。源位置元数据不改变 cell 输出,本轮审核修复未更新 golden。
- Release:本地提交经过审查的 UI/UX 范围,不推送、不关闭 Issue。上下文管理文件不暂存;混合词汇文件只暂存 UI 部分,不改写工作区完整内容。
- Not run / Why / Risk(审核当时):未运行 grok/OpenCode 进程或真实远端模型;当时尚未记录 operator 的 WSL 人工验收确认。后续确认见下节。

### WSL 人工验收确认

operator 于 2026-09-07 明确确认:"我已经用WSL人工验收过了"。

- 结论:本轮 UI/UX 的 WSL 人工验收通过,不再作为待验收项。以上各实施阶段的待验收表述保留为当时的历史记录,当前结论以本节及文首状态为准。
- 依据:operator 对本轮实际终端体验的直接确认;自动化验证另见提交前审核记录。代码交付为 `19f87d5`,此次仅补记验收结论。
- 环境记录:已知为 WSL;外层终端名称、版本、具体窗口尺寸和逐步操作日志未提供,不推测这些细节或另行归因到某个测试步骤。
