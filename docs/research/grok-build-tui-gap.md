---
doc_kind: note
created: 2026-09-02
---

# grok-build TUI 差距调研

> 状态:调研完成(2026-09-02)。其中「保留 pi-tui、以 pixel parity 为出口」的建议已被 operator 2026-09-04 的 1A/2A/3A 推翻,见 [ADR-005](../decisions/005-tui-own-compositor.md);投影模型与 grok 信息架构的诊断仍有效。
> 上游快照:[`xai-org/grok-build@bc7f02e`](https://github.com/xai-org/grok-build/tree/bc7f02eddd3d84085849dc19ed216f11c23b0571),根目录 `SOURCE_REV=d5a0335a47221e8c9519936cb693e9b6450227ec`,`xai-grok-pager` 版本 `1.0.12`。
> 本地代码基线:`d1e06319783051a55f7de97aa60dd831159a4a13`;工作区已有未提交文档和截图不属于本次改动。通用架构调研见 [grok-build.md](./grok-build.md),本文件只回答当前 TUI 为什么仍有明显差距、怎样在受控参考环境内做到 pixel parity,以及 Rust 设计应怎样转译到 TypeScript。

---

## 1. 结论

当前差距的主因不是 Rust 比 TypeScript 更适合 TUI,也不是 `ratatui` 比 `pi-tui` 多几个 widget。真正的差距是**投影模型**:

```text
grok-build
source truth
  -> typed ScrollbackEntry
  -> kind-specific BlockOutput
  -> shared EntryRenderer chrome
  -> precomputed screen Rects

current myh
SessionEvent
  -> message / rich / footer timeline
  -> independently rendered Component children
  -> unconditional Spacer + VStack/MainScreenLayout
```

grok-build 先把每段内容定义成有 identity、lifecycle、display mode 和 chrome 的 entry,再渲染。当前 myh 虽已有 `BlockEnvelope`、`FoldState`、typed diff、head/tail 裁剪和 status truth,但最后仍把多个独立 `Component` 顺序拼起来。因此:

1. user、assistant、thinking、tool、notice 没有共享的横向几何和视觉外壳。
2. streaming 阶段先显示 `thinking:` / `tool:` 纯文本,结束后再换成正式 block,造成明显重排。
3. rail、background、padding、timestamp 不能按整个 entry 高度统一处理。
4. composer、status、shortcuts、blocking card 只是纵向叠加,没有统一 row budget 和短终端降级顺序。
5. card 的 `Esc` 当前会实际 dismiss/deny request;grok-build 的默认语义是 park,request 仍 pending。这不是配色差异,而是交互契约差异。

建议保留现有 `pi-tui`、protocol、request bus、host、editor 和 fold state,重写 `packages/tui` 的三层:

- `TranscriptProjector`:事件流投影为稳定的 typed entries。
- `EntryShell`:统一 rail / padding / background / timestamp / clipping。
- `ScreenLayout` + `InputRouter`:统一 viewport row budget、bottom dock 和 key owner。

这是一次 **以 pixel parity 为出口的 TypeScript 独立实现**。实现上仍不是逐行把 Rust 改写成 TS:逐行翻译既不适配 `ratatui::Buffer` 与 `pi-tui Component.render(): string[]` 的差异,也会把 grok-build 的 dashboard、media、minimal mode、script status line 等无关功能一并带入。这里的“独立实现”是手段限制,不是降低视觉目标:在锁定参考环境和 canonical scenario 后,目标是 terminal cell frame 与 RGBA PNG 都零差异。

## 2. 调研边界与方法

### 2.1 纳入范围

- agent transcript 的 user / assistant / thinking / tool / notice 视觉投影。
- entry 的共享 chrome、折叠、streaming 生命周期和 timestamp。
- agent view 的垂直 layout、短终端降级、prompt/status/shortcuts dock。
- blocking card 的 key owner、`EscStep` 和 parked state。
- 工作区现有 `grokbuild.png` 与 `myh.png` 的视觉对照。
- 当前 `packages/tui/src` 和现有 Bun tests 的实现证据。

### 2.2 不纳入范围

- dashboard、peek、team row、subagent view:仍属于 Phase 2.5。
- `Minimal` screen mode、native scrollback commit、media preview、voice、timeline rail。
- vim mode、mouse selection、search overlay、tool-call grouping。
- 自定义 status script 和完整 theme config。
- 在不同 terminal emulator、字体、DPI、主题、locale 或窗口尺寸之间承诺像素级一致;这些变量必须先锁定,否则比较结果没有定义。

### 2.3 证据等级

本报告使用三类证据:

| 证据 | 用途 | 限制 |
|---|---|---|
| 固定 commit 源码与上游 tests | 判断真实状态机和布局约束 | 只代表上述快照 |
| 本地源码 `d1e0631` | 判断当前实现边界和缺口 | 工作区后续修改可能使行号漂移 |
| 本地截图与 render probe | 判断视觉结果和窄屏行为 | 当前截图尺寸不同,只能作为定性 baseline,不能直接做 pixel diff |
| 锁定参考环境下的 PTY/cell/PNG capture | 作为 pixel parity 的唯一验收证据 | 在参考环境未锁定前不得把截图差异解释为实现差异 |

## 3. grok-build 实际怎么做

### 3.1 entry 先于 widget

上游的 `ScrollbackEntry` 持有 typed `RenderBlock`、`display_mode`、running/pending/finished 状态、时间与缓存。block 自己产出 `BlockOutput`;共享 `EntryRenderer` 再给所有 block 加同一套 chrome。

这不是一个通用 `CollapsibleText`。职责分成两层:

```text
kind-specific block
  owns: header/body summary, default fold, accent intent, background intent

shared entry renderer
  owns: geometry, full-height rail, padding, fill, timestamp gutter,
        clipping, selection, visible-row rendering, height agreement
```

关键证据:

- [`block.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/block.rs) 定义 typed block 行为。
- [`entry_renderer.rs#L551-L566`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/wrappers/entry_renderer.rs#L551-L566) 的 height 计算与 [`entry_renderer.rs#L569-L845`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/wrappers/entry_renderer.rs#L569-L845) 的 paint 使用同一 content width、chrome 和 timestamp reserve。
- collapsed entry 会取消 rail 但保留 rail 列,因此折叠不会造成横向跳动;对应回归测试在 [`entry_renderer.rs#L948-L1023`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/wrappers/entry_renderer.rs#L948-L1023)。

### 3.2 横向几何是稳定契约

`HorizontalLayout` 明确固定:

```text
| accent: 1 | left padding: 2(default) | content: flex | right padding: 2(default) |
```

来源:[`scrollback/layout.rs#L5-L55`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/layout.rs#L5-L55) 与 [`appearance/config.rs#L211-L219`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager-render/src/appearance/config.rs#L211-L219)。`layout.rs` 的示意注释仍写 right padding default `1`,但同一固定版本的运行时 `LayoutConfig::default()` 明确为 `2`;本报告以运行时值为准。所有列与 entry 等高;即便当前类型没有 accent,列仍保留。`EntryRenderer` 会:

- 在整个可见 entry 高度填充 background,不只给文字本身着色。
- 在整个高度画静态或 animated rail。
- pending user input 时冻结动画,表达“等你”,而不是继续假装运行。
- 给 user/assistant timestamp 预留固定 gutter,正文先按更窄宽度换行。
- 给 diff/code row 保留自己的语义 background。

这套稳定几何正是截图中“每块内容像同一个系统”的来源。

### 3.3 display mode 是 block 自己的语义

统一状态只有 `Collapsed / Truncated / Expanded`,但每类 block 决定它们分别显示什么:

- thinking 的 truncated 行数独立配置。
- execute 保留首尾,错误和 test summary 不会因为只截开头而消失。
- edit 使用 typed hunk renderer,不是 execute output 的换色版本。
- running、complete、failed 会影响 summary、accent 和默认模式。
- `display_mode_pinned` / `respect_manual_folds` 保证 streaming update 不覆盖用户的手动折叠。

当前 myh 的 `FoldState` 已正确保存 `defaultDisplayMode`、`currentDisplayMode` 和 `manualOverride`;这部分应保留,不需要重写成上游同名字段。缺的是把它接到统一 entry shell 和稳定高度/scroll anchor 上。

### 3.4 timestamp 是 layout 输入,不是事后贴字

上游只给 user/assistant message 显示 timestamp,thinking/tool 不显示。启用时先从 content width 中减掉 10 列,正文按剩余宽度 wrap,最后 overlay timestamp;窄到放不下则完整隐藏,不会显示半个时间。来源:[`entry_renderer.rs#L334-L353`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/wrappers/entry_renderer.rs#L334-L353)、[`entry_renderer.rs#L749-L845`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/wrappers/entry_renderer.rs#L749-L845) 和窄屏测试 [`entry_renderer.rs#L1293-L1310`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/wrappers/entry_renderer.rs#L1293-L1310)。

### 3.5 先计算 row budget,再 paint

`AgentViewLayout::compute` 是纯布局计算。它先接收所有区域的 desired height,再一次性得出 rects。关键约束:

- `scrollback` 是唯一 `Min`,基线最少 5 行。
- prompt、status line、shortcuts 有明确顺序和预算。
- terminal 高度 `<=16` 时移除 bottom padding、CTA 和 follow-ups。
- terminal 高度 `<=20` 时自动进入 compact rendering,但不修改用户配置。
- status line 只拿其他必需区域和 scrollback floor 之后的剩余行。
- prompt 自己有 cap,不能无限吃掉 scrollback。

来源:[`views/agent.rs#L79-L130`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/agent.rs#L79-L130)、[`views/agent.rs#L168-L429`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/agent.rs#L168-L429)。短终端和 status/prompt 竞争也有直接回归测试,例如 [`views/agent.rs#L2027-L2178`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/agent.rs#L2027-L2178)。

### 3.6 card 替换 composer slot,不继续向下堆

permission/question/cancel/elicitation 出现时,上游用 card 的 desired height 替换 `layout.prompt` 的 base prompt height;normal composer 不再同时占一块固定区域。permission follow-up/free-text input 复用 prompt widget,但以 inline style 画在 card 内。来源:[`render.rs#L1172-L1268`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/render.rs#L1172-L1268)、[`render.rs#L2554-L2634`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/render.rs#L2554-L2634)。

这比当前 myh 的 `blockingCards + workingIndicator + statusLine + shortcutsBar + editor` 全部叠加更稳定,也能明确回答“现在键盘属于谁”。

### 3.7 key owner 与 visible hints 来自同一状态

上游先计算 `KeyOwner`,再路由输入。`EscStep` 是纯状态结果,shortcuts bar 和 handler 都读取它。`ParkFocus` 只把键盘交给 scrollback,card 仍显示、request 仍 pending;`Tab/Space` 是回去的 pinned route。

来源:[`key_owner.rs#L9-L98`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L9-L98)、[`key_owner.rs#L101-L285`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L101-L285)。`permission_esc_parks_focus_without_answering` 等回归测试在 [`key_owner_tests.rs#L116-L228`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner_tests.rs#L116-L228)。

shortcuts bar 接收结构化 `HintItem`,分别绘制 key/action,按宽度只保留能完整放下的 item;窄屏 compact mode 可固定关键 hint,最后保留 help route。来源:[`shortcuts_bar.rs#L198-L340`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/shortcuts_bar.rs#L198-L340)。

### 3.8 prompt 和 status 是同一个 bottom surface

`PromptStyle` 明确持有 prefix、vertical padding、chrome padding、background、border、focus 和 compact state;prompt 的 height 与 paint 使用同一 style。来源:[`prompt_widget/mod.rs#L132-L281`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/prompt_widget/mod.rs#L132-L281)。

status line 使用结构化 segments,分隔符是 ` │ `;cost `<0.005` 隐藏,缺失字段不生成 segment。`StatusLineFrame::Off / Reserved / On` 又保证 height 与 paint 对“这一行是否存在”达成一致。来源:[`segments.rs#L9-L18`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/status_line/segments.rs#L9-L18)、[`segments.rs#L67-L120`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/status_line/segments.rs#L67-L120)、[`status_line/mod.rs#L104-L161`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/status_line/mod.rs#L104-L161)。

## 4. 当前 myh 的具体差距

### 4.1 差距矩阵

| 面 | grok-build | 当前 myh | 判断 |
|---|---|---|---|
| header | cwd/context 简洁单行 | 已有 cwd/context 左右布局 | 基本保留,只需纳入 compact policy |
| user message | full-width surface、可换行、timestamp gutter | 有 surface 和 `❯`,但逐行 `truncateToWidth` | 高优先级:窄屏会丢 prompt 原文 |
| assistant message | 共享 entry geometry,正文有稳定 inset | 直接 `Markdown` 后事后贴 timestamp | 高优先级:与其他 block 横向不对齐 |
| streaming | typed entry 原位更新 | 所有 active blocks 合并为 `Text`,结束后换组件 | 最高优先级:视觉跳变且 block identity 暂时消失 |
| thinking | 摘要、body、rail、fold 是一个 entry | summary 已有,但只是 `FoldBlock` 字符串 | 中高:语义已有,缺完整 shell |
| execute/edit | kind-specific body + shared chrome | body 策略已有,header/body 是裸行 | 中高:输出层级弱,success/failure/running 不成体系 |
| fallback tool | typed compact summary | `name(JSON.stringify(arguments))` | 中:长 JSON 污染 transcript |
| spacing | block 自己声明 vpad | timeline entry 之间无条件 `Spacer(1)` | 中:空 stdout/尾换行会叠成双空行 |
| timestamp | 先 reserve,放不下完整隐藏 | user 先拼接后整体截断;assistant 放不下就不贴 | 高:user 可显示半个 timestamp并截断正文 |
| blocking card | 替换 prompt slot,可 park | card 在 editor 上方叠加;`Esc` dismiss/deny | 最高:交互语义与 grok 不同 |
| shortcuts | typed hint、key/action 分色、width-fit、pinned | `string[]` 后拼成单行再整体截断 | 中高:可能截掉唯一逃生路径 |
| vertical layout | pure row budget + short-terminal cuts | alt 用固定 `VStack`,main 仅减 footer 总行数 | 高:缺少可测试的优先级和降级契约 |
| status | structured segments,诚实省略 | 真相和 cost 阈值已正确,但仍是独立文本行 | 低到中:保留语义,重做 dock projection |
| host | Fullscreen/Inline/Minimal 是顶层策略 | `main` / `alt` 已由 `host.ts` 隔离 | 保留,本轮不扩 mode |

### 4.2 源码证据

当前 `StreamRenderer` 的 active message 只要存在 streamed blocks,就走 `streamedMessageText()` + `Text`;到 `message_end` 才改用 `Markdown`、`ThinkingBlock` 和 rich components。见 [`stream-renderer.ts`](../../packages/tui/src/stream-renderer.ts) 的 `addMessageChildren()`。

当前 `FoldBlock.render()` 只返回 `header + body` 字符串数组。它无法表达跨整个 block 高度的 rail、padding fill、background band 或 timestamp gutter。见 [`fold.ts`](../../packages/tui/src/blocks/fold.ts)。

当前 `UserMessageCard` 给单行 prompt 拼 timestamp 后再截整行;它不 wrap 原文,也不先 reserve timestamp。见 [`message.ts`](../../packages/tui/src/blocks/message.ts)。

当前 `App` 的 fixed footer 是五个独立组件顺序叠加;alt host 使用静态 `VStack`,main host 只用 `terminal.rows - header - footer` 算 transcript 高度。见 [`app.ts`](../../packages/tui/src/app.ts)。

当前 `FocusStack.handleInput(Esc)` 直接 `pop`,`App.dismissCard()` 随即向 request bus 发 deny/cancel/reject。见 [`focus-stack.ts`](../../packages/tui/src/focus-stack.ts)、[`app.ts`](../../packages/tui/src/app.ts) 和 [`request-card.ts`](../../packages/tui/src/request-card.ts)。因此现有注释“remain available as transcript records”表示已终结后的历史记录,不是 grok-build 的 pending parked card。

### 4.3 本地 render probe

用同一事件序列渲染 user + thinking + assistant + execute + edit + turn footer,去掉 ANSI 后得到:

| width | 总行数 | 观察 |
|---:|---:|---|
| 40 | 24 | user prompt 被截成 `Inspect the repository and explain th`;timestamp 消失 |
| 60 | 23 | user prompt 后只剩半个 timestamp `8:` |
| 80 | 22 | timestamp 完整;assistant wrap 成 2 行 |
| 120 | 22 | 横向留白增大,tool/edit 仍从第 0 列起,与 message inset 不一致 |

同一 probe 还出现 execute body 后连续两个空行:一个来自 stdout 尾换行,一个来自全局 entry spacer。它说明 spacing 不能继续由“每两个 timeline entry 中间固定插一行”单独决定。

这些数字只作为改写前 baseline。工作区现有两张截图也不能直接做 pixel diff:`grokbuild.png` 是 `2493x619`,`myh.png` 是 `2560x1390`,窗口像素尺寸和终端 rows 均不一致。它们只证明当前观感存在显著差距;真正验收必须先锁定参考环境,再在相同像素尺寸、columns/rows 和状态下重新采集 grok-build reference 与 myh candidate。

## 5. Rust 概念到 TypeScript 的转译

| Rust / ratatui | TypeScript / pi-tui 表达 | 处理 |
|---|---|---|
| `ScreenMode` | 现有 `TuiHostMode` (`main` / `alt`) | 保留;不加 `minimal` |
| `RenderBlock` + `ScrollbackEntry` | UI-local `TranscriptEntry` discriminated union | 新增;不把 chrome 写进 protocol |
| `BlockOutput` / `BlockLine` | `EntryPresentation` + `EntryRow[]` | 新增;保留已渲染 ANSI text 与可选 row background intent |
| `HorizontalLayout` | pure `computeEntryLayout(width, chrome)` | 新增;固定 rail/padding/content/timestamp widths |
| `EntryRenderer` | `EntryShell implements Component` | 新增;唯一负责 full-height chrome |
| `DisplayMode` / pinned fold | 现有 `FoldState` | 保留并接入 entry identity |
| kind-specific Rust blocks | `ThinkingBody` / `ExecuteBody` / `EditBody` | 改写现有 block,只负责 header/body presentation |
| `AgentViewLayout::compute` | pure `computeScreenLayout(rows, desiredHeights)` | 新增;两个 host adapter 共用结果 |
| `PromptWidget` | 现有 `Editor` + `ComposerDock` shell | 包装,不重写文本编辑器 |
| `StatusLineFrame` | 三态 `DockRowState` | 新增小状态,保留现有 status truth |
| `HintItem` | typed `ShortcutHint { keys, label, pinned }` | 新增;按 item fit,不截半条 |
| `KeyOwner` / `EscStep` | pure `resolveKeyOwner()` / `nextEscStep()` | 新增;handler 只执行结果 |
| `ratatui::Buffer` cell frame | 优先由 `pi-tui` row renderer 产出可检查的 `TerminalFrame`;若无法零差异则引入窄范围 deterministic cell/frame compositor | 条件采用;pixel parity 高于保留当前 string-only paint path |
| full layout/height cache | 可见 transcript 简单重测 | 暂缓;profiling 证明需要后再做 |

建议的数据流:

```text
SessionEvent / RequestEnvelope / status truth
                  |
                  v
        TranscriptProjector + AppViewState
                  |
          +-------+--------+
          |                |
          v                v
  EntryPresentation   ScreenLayoutPlan
          |                |
          v                v
      EntryShell       Dock / host adapter
          +-------+--------+
                  v
      pi-tui rows or deterministic frame
```

`protocol` 继续只描述跨客户端事实:`BlockEnvelope`、tool result、request outcome。`TranscriptEntry`、rail、padding、timestamp reserve、selection 等都是 TUI projection,不应反向污染 `packages/protocol`。

## 6. Pixel parity 规格

### 6.1 严格定义

“像素级完完全全还原”在本项目中定义为:对同一个 canonical scenario,在同一个 locked reference environment 中,grok-build reference 与 myh candidate 同时满足下面两层零差异。

| 层 | 比较对象 | 通过标准 |
|---|---|---|
| terminal cell | 每个 row/column 的 grapheme、占用宽度/continuation cell、foreground、background、bold、dim、italic、underline、reverse 等 attributes | diff cell 数为 `0` |
| raster pixel | 同尺寸 PNG 的每个 RGBA pixel | differing pixel 数为 `0`,最大 channel delta 为 `0`,不设 tolerance |

参考环境 manifest 必须固定并随 reference artifact 保存:

- terminal emulator 名称、版本、完整相关配置与渲染 backend。
- 字体文件及 hash、字号、line height、字重、hinting/antialiasing 设置。
- OS/发行版、display server、DPI 与 scale factor。
- terminal theme、ANSI 16/256 色与 truecolor profile、默认 foreground/background。
- 窗口 content area 像素宽高、terminal columns/rows、cell 像素宽高。
- `TERM`、`COLORTERM`、locale、Unicode width policy 和 shell 环境。
- cursor 的 visibility、shape、blink phase 与位置。
- 固定时间、timezone、animation frame、spinner phase、random seed 和 scenario 输入数据。

任何 manifest 字段不一致时,结果只能标记为“环境不可比”,不能以 tolerance、人工观感或更新 reference 的方式通过。跨环境像素一致性不是承诺;locked environment 内零差异是硬验收。

### 6.2 Canonical scenarios

至少固定以下 reference states,每个 state 同时保存 event fixture、terminal cell dump、ANSI stream、PNG 和 artifact hash:

1. idle empty transcript + focused composer。
2. user band + multi-line assistant markdown + timestamp。
3. thinking streaming / truncated / expanded。
4. execute running / success / failure,含首尾裁剪。
5. edit single hunk / multi-hunk,含 add/remove/context rows。
6. status running / completed + composer focus/cursor。
7. permission、question、elicitation、cancel、file-search card focused 与 parked。
8. resize 后的 `40/60/80/120` columns 与 `8/12/16/20/24/40` rows。
9. `main` 与 `alt` host 各自可比的稳定 frame;host control sequence 不进入截图内容。

动态场景按离散稳定 frame 验收。时间、cursor blink、rail wave、spinner 等无法冻结的状态必须在 reference capture 中关闭或固定 phase;不能对两个任意时刻的动画截图做零差异要求。

### 6.3 逐区域 visual spec

下表定义必须从 grok-build reference 测量并固化的字段。B0 不允许凭当前不同尺寸截图估值;准确 glyph、cell 坐标、RGB 和 attributes 要写入机器可读 `VisualSpec` fixture。

| 区域 | 必须精确复刻的输出 | 状态/响应式规格 |
|---|---|---|
| header | 起始 row、左右 inset、cwd/context 文本、分隔 glyph、foreground/background、attributes、右对齐坐标与整行 fill | normal/compact/hidden 三态与切换阈值;内容过长时的裁剪方向和保留字段 |
| user band | full-width surface 的起止 column、rail 保留列、左右/上下 padding、prompt prefix glyph、正文 wrap、timestamp gutter、所有空白 cell 的 background | single/multi-line、timestamp show/hide、40/60/80/120 cols;禁止正文截断和 timestamp 残片 |
| thinking | header glyph/label、activity rail、summary、duration、body inset、truncation marker、surface/background 和空行 | streaming/pending/complete、collapsed/truncated/expanded、manual fold 后 update;每态单独 reference |
| assistant | content start column、Markdown heading/list/code/link styles、paragraph spacing、timestamp gutter、rail/surface 与 trailing fill | streaming/complete、single/multi-line、fold/scroll/resize;完成时不得改变 entry identity 或横向几何 |
| execute | lifecycle icon、command/header、rail/accent RGB、stdout/stderr rows、首尾省略 glyph、success/failure/test summary、每行 background | running/success/failure、empty/long output、collapsed/truncated/expanded;ANSI output 的继承与 reset 必须一致 |
| edit | file header、collapsed 状态的 `+N/-M` summary、single line-number gutter、add/remove/context rows、逐 cell foreground/background | single/multi-file、single/multi-hunk、collapsed/truncated/expanded; expanded diff 不显示 unified `@@ ... @@` hunk header,不得退化成 execute 配色 |
| status | row 坐标、左右 inset、segment 顺序、` │ ` separator、activity glyph、token/context/cost 文本、foreground/background 和尾部 fill | off/reserved/on、running/complete、unknown omission、`<$0.005` omission;同输入必须稳定 |
| composer | slot 高度、outer/inner padding、prefix、border/surface、placeholder/input colors、cursor cell/style、focus chrome 和文本 wrap | empty/typed/multi-line/focused/unfocused/compact;cursor blink 固定 phase |
| shortcuts | bottom row 坐标、key/action 的独立 attributes、item 间距与 separator、pinned route、尾部 fill | 按完整 item fit,不得截半条;各 `KeyOwner`、40/60/80/120 cols 单独 reference |
| blocking card | 替换 composer 的 exact rect、border/surface、title/body/actions、selected/disabled styles、inline input、focus indicator | 五类 request 的 focused/parked/sub-input 状态;park 不改变 card 像素内容之外的 pending truth,显式 action 才终结 request |

这份 visual spec 是最终输出契约,不是“设计灵感”。若上游同一状态依赖当前未纳入的能力,必须二选一:把该能力纳入本轮以完成 parity,或由 operator 明确缩小 canonical scope;不能以“语义等价”替代零差异。

### 6.4 目标画面不变量

```text
 cwd                                                      context

 [ ][  ]assistant/user/thinking/tool content          timestamp[ ]
 [rail]wrapped body line                                        [ ]
 [rail]wrapped body line                                        [ ]

                         scrollback viewport

 [blocking card OR composer: one owner, one bounded slot]
 status segments
 key:action  |  key:action                         pinned escape route
```

必须满足:

1. 所有 transcript entry 使用同一 content start column;无 rail 时也不横跳。
2. user 原文必须 wrap,不能因为 timestamp 或 width 被静默截断。
3. timestamp 要么完整显示,要么完整隐藏;不能出现 `8:` 这种残片。
4. active streaming block 原位更新;完成时允许 tone/lifecycle 改变,不允许从纯文本整体重排成另一种结构。
5. collapsed entry 是一行稳定 summary;展开只增加纵向内容,不改变横向起点。
6. execute 用首尾裁剪,edit 用 typed hunks,thinking 有自己的 summary;不退回通用 JSON/text dump。
7. normal composer 与 blocking card 共用一个 interactive slot;同一帧只有一个 key owner。
8. terminal 变矮时先移除装饰/重复信息,最后才压缩 transcript;可提交输入和逃生快捷键不能被挤掉。
9. status 不重复 transcript 内容,未知字段省略,cost 阈值保持 `$0.005`。
10. `main` 与 `alt` 使用同一个 view state 和 layout policy;host 只处理终端占用方式。

## 7. 采用、暂缓与拒绝

| 决策 | 项目 | 理由 |
|---|---|---|
| 现在采用 | locked visual spec、cell/PNG zero-diff harness、typed transcript entry、shared entry shell、row budget、composer/card slot、key owner、park、typed shortcuts | 同时约束输出结果、状态机和可回归性 |
| 条件保留 | `pi-tui`、`TuiHostController`、request bus、protocol block data、`FoldState`、`Editor`、status truth | 非渲染契约继续保留;`pi-tui` 只有在能产出零差异 frame 时保留现有 paint path |
| 必要时采用 | TUI-local deterministic cell/frame compositor | 当 `string[]` 无法精确表达 background fill、continuation cell、attributes 或 overlay 时,用最小底层补齐,不降低 AC |
| 暂缓 | `Minimal`、selection/timeline、animated wave、group folding、media、custom status script | 不属于当前 UX 缺口或需要新的 terminal capability |
| Phase 2.5 | dashboard、peek、stable team row、subagent supervision | 不与单-agent transcript refresh 混批 |
| 明确拒绝 | 不经边界判断的全量逐行翻译、连同无关 dashboard/media 状态一起复制、用 tolerance 或肉眼近似冒充通过 | TypeScript 可以独立实现同一 frame,无需复制上游全部内部结构;视觉出口仍是零差异 |

## 8. 许可证边界

上游为 Apache-2.0。当前建议是依据公开源码做行为和架构层的独立 TypeScript 实现,不复制大段 Rust。若施工中决定直接翻译可识别的上游函数或测试,必须在合入前补齐 Apache-2.0 要求的 license/notice 与变更说明;不能把“换了一种语言”当成没有派生关系。

## 9. 待 operator 确认

施工前需要确认五点:

1. 提供或确认 canonical reference environment;在该环境内接受 cell/PNG 零差异作为硬出口,跨环境不作像素承诺。
2. 允许在证据证明 `pi-tui string[]` 无法零差异时,引入 TUI-local deterministic cell/frame compositor。
3. blocking card 的 `Esc` 从当前 dismiss/deny 改为 park;另设明确 deny/cancel action。
4. 本轮包含 transcript + bottom dock + key router,但不包含 dashboard、Minimal、mouse selection;动画只在能够固定 phase 并进入 reference 时纳入。
5. `ui.host` 保持灰度开关;pixel parity 和人工交互验收通过前不借本轮顺手翻默认值。

具体批次、验收和回退见 [Phase 2.1 施工图](../phases/phase-2.1.md)。
