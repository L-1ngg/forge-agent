---
doc_kind: plan
created: 2026-09-02
---

# Phase 2.1 施工图 — grok-build TUI pixel parity

> 状态:已中止(2026-09-04)。operator 选择 1A/2A/3A:放弃 pi-tui 改造路径,改由 [phase-2.2.md](./phase-2.2.md) 接手。本文保留为历史施工图,AC-38/AC-39 未关闭不得改写成通过。同日 [ADR-006](../decisions/006-tui-cell-parity.md):AC-37/38/40/41 的 cell 口径语义由 phase-2.2 AC-48/49/50 接手;AC-39 的 PNG 硬门禁不恢复。[phase-2.md](./phase-2.md) 仍是 M1-M6 历史施工图。
> 输入:[grok-build TUI 差距调研](../research/grok-build-tui-gap.md);通用设计背景见 [grok-build.md](../research/grok-build.md) 和 [design-rationale.md](../design-rationale.md)。

---

## 一句话说完

不重写 runtime,也不机械逐行翻译 Rust。保留当前正确的 protocol、request bus、host、editor、fold 和 status truth,把 TUI 的最后一公里改成:

```text
stable typed entries -> shared entry chrome -> one screen row budget -> one key owner
                     -> deterministic terminal frame -> zero-diff PNG
```

完成标准不是“颜色更像”或“信息架构一致”,而是相同事件序列在 locked reference environment 中,对 canonical scenarios 同时达到 terminal cell diff `0` 和 PNG/RGBA pixel diff `0`,并在 streaming、完成、折叠、resize、pending card 和两个 host 下保持可操作性。

## 0. 开工门禁

以下任一项未满足,不得修改 `packages/tui`:

| # | 门禁 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| E1 | operator 认可范围 | 明确确认本文件 §1 的目标/范围与 §8 的六项决策 | 继续改方案,不写代码 |
| E2 | 当前 baseline 可复现 | `bun run check` fresh run 全绿;保存 focused TUI tests 数量和输出 | 先判断是既有失败还是方案问题 |
| E3 | canonical reference environment 锁定 | terminal/字体/hash/字号/DPI/scale/theme/color profile/locale/columns/rows/cursor/time/animation 配置写入 manifest,并能重建 | 环境不可比,B0 不得声称 reference 有效 |
| E4 | reference artifacts 固定 | 每个 canonical scenario 重新采集同环境、同尺寸的 grok-build cell dump、ANSI stream 和 PNG,记录 hash;当前 `2493x619` / `2560x1390` 截图只作定性证据 | B1 不开工 |
| E5 | zero-diff harness 可证伪 | harness 能分别报告 cell、glyph/style、PNG RGBA diff;对 reference 人为改 1 cell/1 pixel 时必定失败 | 不得用肉眼或 tolerance 替代 |
| E6 | terminal 风险继续诚实记录 | [phase-2.md](./phase-2.md) AC-14 仍标未实测;不得写成通过 | 保留 `main` 逃生口和 256-color 降级 |
| E7 | 工作区改动边界清楚 | 开工前记录 `git status`;不覆盖 operator 未提交改动 | 有重叠时先局部协调 |

本轮不要求先完成 5 天 dogfooding,因为这次改写正是当前 UX 验收暴露出的返工。但本轮完成后要重新开始 Phase 2 的人工 UX 验收与 dogfooding 计时,不能沿用改写前的天数。

## 1. 目标与非目标

### 1.1 目标

1. user、assistant、thinking、execute、edit、notice 都成为有稳定 identity 的 `TranscriptEntry`。
2. 所有 entry 由一个 `EntryShell` 统一 rail、padding、background、timestamp 和 clipping。
3. streaming delta 原位更新 typed entry,完成时不做“纯文本 -> rich block”的整体替换。
4. 一个 pure `computeScreenLayout()` 决定 transcript、interactive slot、status、shortcuts 的行预算和短终端降级。
5. blocking card 替换 normal composer slot;card 可以 park 到 scrollback,request 仍 pending。
6. shortcuts 从当前 `KeyOwner`/`EscStep` 生成,窄屏永远保留返回/退出路径。
7. `main|alt` 共用 view state、entry projection 和 layout policy。
8. 在 locked reference environment 中,header、user、thinking、assistant、execute、edit、status、composer、shortcuts 和 blocking card 的 cell frame 与 PNG 均与 grok-build reference 零差异。
9. reference、candidate 和 diff artifact 可重复生成;任何 reference 变更都必须说明上游 commit、环境或 scenario 变化,不能通过盲目更新截图消除失败。

### 1.2 非目标

- 不改 `packages/core` agent loop、permission 决策链、request bus 契约和 tools。
- 不扩 `packages/protocol` 的业务事实;只有发现现有事件缺少无法本地生成的稳定 identity 时才另开 ADR,不能在 B2 顺手加字段。
- 不实现 dashboard、peek、team、subagent、`Minimal`、timeline、mouse selection、media、voice。
- 不预设必须替换 `pi-tui` 或重写 `Editor`;但若现有 string-only paint path 无法表达 reference frame,允许引入最小范围的 deterministic cell/frame compositor。
- 不做全量 layout cache;先以 correctness 为目标,profiling 证明 O(history) 成为问题后再立项。
- 不在本轮翻转 `ui.host` 默认值。
- 不承诺不同 terminal emulator、字体、DPI、theme、locale 或窗口尺寸之间的像素相同;这些变量由 reference environment manifest 固定。locked environment 内的零差异是 AC,不是非目标。

## 2. 设计

### 2.0 Locked reference environment 与 frame contract

pixel parity 只对一份可复现的环境 manifest 生效。B0 必须产出 `reference-environment.json` 和每个 scenario 的 artifact manifest,至少包括:

- terminal emulator、版本、配置、渲染 backend、OS/display server。
- 字体文件 hash、字号、line height、字重、hinting/antialiasing、DPI/scale。
- terminal theme、ANSI 16/256 色、truecolor profile、默认 foreground/background。
- window content pixel size、terminal `columns/rows`、cell pixel size、`TERM`、`COLORTERM`、locale 与 Unicode width policy。
- cursor visibility/shape/blink phase/position、固定 clock/timezone、animation/spinner phase、random seed、输入 fixture。

每个 canonical scenario 必须同时保存:

```text
scenario fixture + reference cell frame + reference ANSI stream + reference PNG + SHA-256 manifest
```

比较分两层执行且都不设 tolerance:

1. cell diff 比较每个 cell 的 grapheme、width/continuation、foreground、background 和 attributes,要求 differing cells `0`。
2. PNG diff 比较同尺寸 PNG 的每个 RGBA channel,要求 differing pixels `0`、最大 channel delta `0`。

窗口像素尺寸、columns/rows、字体或任一 manifest 字段不一致时,结果记为 `environment-mismatch`,不允许更新 reference 或放宽 diff 继续通过。动态效果必须关闭或固定到已记录 frame;不能比较两个任意动画时刻。

逐区域的 exact visual spec 由 B0 从 grok-build reference 测量并写入机器可读 fixture,覆盖 header、user band、thinking、assistant、execute、edit、status、composer、shortcuts 和 blocking card。每个区域至少锁定 rect、glyph、空白 cell、foreground/background、attributes、padding、wrap/clipping 和 compact/resize 状态。

### 2.1 分层与所有权

```text
packages/protocol
  SessionEvent / BlockEnvelope / RequestEnvelope
             |
             v
packages/tui/view-state
  TranscriptProjector + AppViewState
             |
      +------+------+
      |             |
      v             v
 EntryPresentation  ScreenLayoutPlan
      |             |
      v             v
 EntryShell       AgentScreen/Dock
      +------+------+
             v
          pi-tui
```

所有权规则:

- protocol 拥有跨客户端事实:lifecycle、tool data、request outcome。
- projector 拥有 UI-local identity、message contentIndex 映射、tool anchoring、turn footer 顺序。
- kind renderer 拥有 header/body/summary/default display mode。
- `EntryShell` 独占 chrome;kind renderer 不自己补 rail/padding/timestamp。
- `computeScreenLayout()` 独占行预算;component 不通过“我再多返回一行”争抢 viewport。
- `resolveKeyOwner()` 独占输入优先级;component 不私自注册同一全局 key。

### 2.2 TypeScript 目标形状

以下是施工约束,不是要求逐字使用的最终 API:

```ts
type TranscriptEntry =
  | { id: string; kind: "user"; text: string; timestamp: number }
  | { id: string; kind: "assistant"; markdown: string; timestamp: number; lifecycle: BlockLifecycle }
  | { id: string; kind: "thinking"; block: BlockEnvelope<"thinking">; durationMs?: number }
  | { id: string; kind: "execute"; block: BlockEnvelope<"execute"> }
  | { id: string; kind: "edit"; block: BlockEnvelope<"edit"> }
  | { id: string; kind: "notice"; text: string; tone: "muted" | "error" | "success" };

interface EntryRow {
  text: string;
  background?: ThemeSlot;
  /** Row-local column in the final content row, including any first-row bullet/prefix. */
  backgroundStart?: number;
}

interface TerminalCell {
  grapheme: string;
  width: 0 | 1 | 2;
  foreground: Color;
  background: Color;
  attributes: CellAttributes;
}

interface TerminalFrame {
  columns: number;
  rows: number;
  cells: readonly TerminalCell[][];
  cursor?: { x: number; y: number; visible: boolean; shape: CursorShape };
}

interface EntryChrome {
  rail?: ThemeSlot;
  surface?: ThemeSlot;
  timestamp?: string;
  contentPrefix?: string;
  contentPrefixTone?: ThemeSlot;
  vpadTop: 0 | 1;
  vpadBottom: 0 | 1;
}

interface EntryPresentation {
  rows: readonly EntryRow[];
  chrome: EntryChrome;
}

interface EntryLayout {
  railWidth: 1;
  leftPadding: number;
  contentWidth: number;
  timestampWidth: number;
  rightPadding: number;
}

interface ScreenLayoutPlan {
  header: { height: number };
  transcript: { height: number };
  interactive: { height: number; owner: "composer" | "card" };
  status: { height: 0 | 1 };
  shortcuts: { height: 1 };
  compact: boolean;
}

type KeyOwner = "card" | "scrollback" | "composer" | "global";
type EscStep = "leave_input" | "park_card" | "abort_turn" | "arm_rewind" | "rewind" | "noop";
```

这里故意不设计通用 widget framework。`TranscriptEntry`、`EntryPresentation`、`ScreenLayoutPlan` 和两组纯函数足以解决当前问题;没有第三个真实使用者前不抽象 renderer plugin API。`TerminalFrame` 是 parity harness 的窄接口,不是把上游 `ratatui` 内部整套搬进来。

### 2.3 entry 横向布局

默认参数向 grok-build 靠齐:

```text
rail=1, leftPadding=2, content=remaining, rightPadding=2
timestampReserve=10 only for user/assistant and only when width permits
```

规则:

- collapsed 时 rail 不画,但 1 列仍保留。
- user surface 覆盖整条 entry,包含 padding;assistant 默认透明。
- user text 和 assistant markdown 使用 `contentWidth - timestampReserve` wrap。
- 放不下 timestamp 时设 `timestampWidth=0`,不显示残片。
- specialized row background 可以覆盖 content 区,但不能改变 entry geometry。
- spacing 改为 presentation 的 `vpadTop/vpadBottom`,移除 timeline 的 unconditional shared `Spacer(1)`。
- ANSI 截断一律使用 `visibleWidth` / `truncateToWidth`;测试含 CJK、emoji 和 combining characters。

### 2.4 streaming projection

`TranscriptProjector` 以 UI-local `messageSeq + contentIndex` 为 message block identity,以 `toolCallId` 为 tool identity:

```text
message_start       -> create message group
message_delta       -> upsert one typed text/thinking/tool placeholder entry
tool_execution_*    -> upsert tool entry by toolCallId at placeholder anchor
message_end         -> reconcile content,mark complete,do not replace identity
turn_end            -> append one typed notice/footer
```

必须删除当前 `streamedMessageText()` 路径和 `hasAssistantToolCall()` 的全历史扫描。tool result 的去重规则保留,但由 projector 在 identity 层决定,不由 paint 阶段扫描文字/children 猜。

如果 `message_end` 与 streamed deltas 内容不一致,以 `message_end` 为最终 truth,在同一 entry 原位 reconcile;不能追加第二份。

### 2.5 block renderer

保留现有语义:

- `FoldState` 的 `default/current/manual` 优先级。
- thinking 的 duration summary 和独立 `truncatedLines`。
- execute 的 `firstLines/lastLines`。
- edit 的 core-computed typed hunks 和 `+N/-M`。
- execute projection 对重复 tool result 的抑制。

改写点:

- 现有 `FoldBlock` 不再自己拼最终 full-width line,改为产出 `EntryPresentation`。
- lifecycle 映射为静态 tone:`streaming -> activity`,`complete -> normal/success`,`failed -> error`。
- 第一版不移植 animated wave;animation 不应阻塞结构正确性。
- fallback tool call 使用 bounded compact summary,禁止完整 raw JSON 占据多行 transcript。

### 2.6 screen layout 与 bottom dock

建议优先级从高到低:

1. interactive slot 至少 3 行,owner 是 `composer` 或 `card`,二者不同时出现。
2. shortcuts 固定 1 行,且至少有当前 owner 的 escape/return route。
3. transcript 在正常终端保底 5 行;极短终端允许降到 1 行,但不能变为负数或把 dock 挤出 viewport。
4. status 0/1 行;无已知 segment 时隐藏,但 running 状态可占该行。
5. header 0/1 行;极短终端可隐藏,因为 cwd/context 不是完成当前交互的前提。
6. working indicator 合并进 status,不再单占一行。
7. decoration/gap 最先删除。

建议 compact threshold:

- `rows <= 20`:缩小 outer vpad、entry vpad、composer max height。
- `rows <= 16`:去掉所有可选 gap,隐藏 header,只保留 transcript + interactive + status(如有) + shortcuts。

`computeScreenLayout()` 必须是无组件、无 ANSI 的纯函数。`main` 和 `alt` host adapter 都消费同一个 plan;不能再分别维护一套优先级。

### 2.7 blocking card 与输入路由

card 出现时:

- normal editor 保留 draft 但不 paint,card 替换 interactive slot。
- `resolveKeyOwner()` 按 `card -> scrollback(parked) -> composer -> global` 决定路由。
- card 内 free-text/file search 先走自己的 `EscStep`;最后一阶是 `park_card`,不是 answer。
- parked 后 card 仍 paint、request 仍 pending;`Tab/Space` 返回 card。
- deny/cancel/reject 只能由明确 action 触发,或 request bus 自己进入 timeout/cancelled 终态。
- parked card 后的 `Esc` 不得穿透为 turn abort。

这会改变现有 `Esc dismiss => conservative deny/cancel/reject` 行为,所以单独放在 B4,可独立 review 和 revert。

### 2.8 shortcuts 与 status

shortcuts 改用结构化 item:

```ts
interface ShortcutHint {
  keys: readonly string[];
  label: string;
  pinned?: boolean;
}
```

renderer 按 item 逐个 fit,不截断半个 item。pinned route 先占预算;其余按当前 owner 的优先级填充。key 与 label 使用不同 emphasis,separator 与上游一致为 `  │  `,item 格式为 `Key:label`。

status 保留当前 truth 和 `$0.005` 阈值。只改成 typed segments + dock row,并将 `WorkingIndicator` 合并成 activity segment。未知值继续省略,不引入 `N/A`。

### 2.9 string rows 与 deterministic frame 的边界

`pi-tui` 的 `Component.render(): string[]` 可以继续作为高层组件 API,但不能预先假设它足以保证 pixel parity。B1/B3 期间必须用同一 candidate frame 同时验证:

- ANSI parser 是否保留 wide grapheme、continuation cell、reset、background fill 与 overlay 顺序。
- string row 在整行空白区域、cursor、timestamp gutter、diff background 和 clipping 上是否能表达 reference。
- host 的刷新/清屏/光标控制序列是否会改变 capture 到的 frame。

如果任一 canonical scenario 在这些边界上无法达到 cell diff `0`,则增加 TUI-local `FrameComposer`/`TerminalFrame` adapter,由 entry/layout 继续提供高层语义,底层在最终 paint 前写入 deterministic cells。该 fallback 只解决表达能力,不复制 grok-build 的无关 cell engine、dashboard 或 terminal feature。

## 3. 施工批次

每个 batch 可独立合入和回退;不得把 B4 的行为变更混进 B1/B2 的视觉重构。

### B0 — baseline 与 test harness

**路径**:`packages/tui/test/render-scenarios.ts`、`packages/tui/test/render-golden.test.ts`、现有 focused tests。

**内容**:

- 建立 canonical event/state 序列:user、streaming thinking、assistant markdown、execute success/failure、edit、permission pending、turn footer、各 card focus/park 状态。
- 在已锁定的 reference environment 中,以同一 `columns/rows` 采集 grok-build 与 current candidate 的 cell frame、ANSI stream 和 PNG;记录环境与 artifact SHA-256。
- 保存 40/60/80/120 列、8/12/16/20/24/40 行的 reference artifacts 和逐区域 `VisualSpec` fixture。
- 给每个 scenario 同时写 semantic assertion、cell diff 和 RGBA diff;人为删一段文本、改一个 attribute、改一个 pixel 时测试必须变红。
- 当前缺陷另存为 diagnostic fixture,不能把当前输出直接升级成 reference,也不能用更新 snapshot 消除失败。

**Tradeoff**:reference 只对 locked environment 有效,但该环境内使用严格零差异而非人工截图判断。若 `pi-tui string[]` 无法表达 reference frame,B0 必须阻止 B1 视觉 parity gate 关闭并触发 `FrameComposer` 评估。operator 已指示在 E3/E4 完成前推进 deterministic candidate,但这不构成 batch 完成证据。

**回退**:只删新增测试 helper/snapshot,不影响 runtime。

### B1 — `TranscriptEntry` + `EntryShell`

**路径**:`packages/tui/src/transcript/{types.ts,entry-shell.ts,present.ts}`、`packages/tui/src/theme.ts`、`packages/tui/src/blocks/*`。

**内容**:

- 落地 UI-local entry/presentation 类型和 pure entry geometry。
- `EntryShell` 统一 rail、padding、surface、timestamp reserve、vpad 和 clipping。
- 先让现有 finalized user/assistant/thinking/execute/edit/notice 走新 shell。
- `FoldState` 不改 public behavior。
- 对每个 B0 canonical scenario 产出 candidate frame;区域 cell diff 与 PNG diff 必须为 `0`,否则不得宣称 B1 完成。

**Tradeoff**:第一版每次 render 重算当前 entry lines,不引入 height cache。先证明 frame 结构和 cell/RGBA parity 正确。

**回退**:恢复 `componentForBlock()` 直接返回旧 components;protocol/core 不受影响。

### B2 — stable streaming projector

**路径**:`packages/tui/src/transcript/projector.ts`、`packages/tui/src/stream-renderer.ts`。

**内容**:

- 用 stable UI-local id 原位 upsert contentIndex/toolCallId entries。
- 删除 `streamedMessageText()`、paint-time history scan 和 duplicate anchoring heuristic。
- reconcile `message_end`,保留 manual fold 和 scroll follow/anchor。
- 异常顺序继续容忍:delta-before-start、tool update-before-end、重复 end。

**Tradeoff**:不修改 protocol 增加 message id;当前单 active message 约束下 `messageSeq + contentIndex` 已足够。若测试证明不够,停止 B2 并单独提 ADR。

**回退**:projector 只在 TUI 内,可恢复旧 timeline reducer。

### B3 — pure `ScreenLayout` + dock

**路径**:`packages/tui/src/layout.ts`、`packages/tui/src/dock.ts`、`packages/tui/src/app.ts`、`packages/tui/src/status-line.ts`、`packages/tui/src/host.ts`(仅接线)。

**内容**:

- 新增 pure row budget 和 compact policy。
- normal composer / blocking card 共用 interactive slot。
- working state 合入 status;shortcuts 成为 dock 最后一行。
- main/alt adapter 消费同一 plan;保留 `TuiHostController` 和 host config。
- 对同一 view state 在 locked environment 生成相同区域 rect、cell frame 和 PNG 内容;允许的 host 差异仅限不进入 frame 的 control sequence。

**Tradeoff**:保留两个 host paint adapter,不强迫 `TuiMainScreen` 模拟 cell viewport;但 parity harness 必须能从两者得到可比较的 deterministic frame。共享的是 plan/state,不是底层刷新算法。

**回退**:恢复现有 `MainScreenLayout` / `VStack` 接线;entry rewrite 仍可单独存在。

### B4 — `KeyOwner` / `EscStep` / parked card

**路径**:`packages/tui/src/input-router.ts`、`packages/tui/src/focus-stack.ts`、`packages/tui/src/esc.ts`、`packages/tui/src/request-card.ts`、`packages/tui/src/app.ts`。

**内容**:

- 先以纯函数求 `KeyOwner` 和 `EscStep`,再由 `App` 执行。
- `FocusStack` 区分 pending/drawn、focused、parked、terminal;不再把 `pop` 同时表示 park 和 resolve。
- `Esc` 从 card 的最终一阶改为 park;显式 action 才响应 request。
- `Tab/Space` 从 scrollback 返回 parked card。
- shortcuts 与 input handler 使用同一 owner/step。

**Tradeoff**:这是唯一用户可感知的行为变更,单批次合入。放弃“Esc 永远等于否决”以换取回看上下文而不误答 request。

**回退**:revert B4 即恢复旧 dismiss policy;不回退 B1-B3 的视觉结构。

### B5 — width/height hardening 与视觉收口

**路径**:focused TUI tests、必要的 `packages/tui/src/*` 小修;不扩功能面。

**内容**:

- 覆盖 CJK/emoji/ANSI、40/60/80/120 cols、8/12/16/24 rows。
- 覆盖 resize 前后 active streaming、manual fold、scroll follow 和 parked card。
- 使用真实 PTY 分别运行 `main`/`alt`,对照 `grokbuild.png` 与目标不变量。
- 核对 OSC 52、滚轮、truecolor;结论回填 [phase-2.md](./phase-2.md) AC-14。
- 不在本批新增动画、dashboard 或其他 polish。

**Tradeoff**:视觉验收按 locked environment 的 cell/PNG 零差异和场景,不是“看起来差不多”的单截图结论。跨环境不比较 pixel,环境不一致标记为 `environment-mismatch`。

**回退**:保留 `ui.host = "main"` 逃生口;任一 host 出现 P1 时不翻默认值并回退对应 batch。

### B1-B5 视觉 parity gate

每个 batch 的功能测试全绿不等于视觉完成。下表是该 batch 的局部出口;局部出口未通过,不得进入下一批。局部 diff 必须在完整 frame 上运行,不能把未改区域裁掉后隐藏整体坐标漂移。

| Batch | 必须达到零差异的区域/场景 | 额外阻断条件 |
|---|---|---|
| B1 | header、user band、assistant、thinking、execute、edit、notice 的 rect、rail、surface、padding、wrap、timestamp、fold states | string rows 无法表达空白 fill、wide/continuation cell、attributes 时,立即转 `FrameComposer` 方案 |
| B2 | streaming 与 `message_end` 的每个 canonical frame;entry identity、scroll anchor、tool placeholder 原位更新 | 任一 delta frame 出现临时 text dump、整段重排、重复 tool result 或 pixel flash |
| B3 | status、composer、shortcuts、card slot、8/12/16/20/24/40 rows 的完整 bottom dock | card/editor 同时 paint、dock 溢出 viewport、pinned escape route 不可见或任一 cell/PNG diff 非零 |
| B4 | card focused/sub-input/parked、五种 request kind、`Esc`/`Tab`/`Space` 可达路径的 frame 与 cursor | park 改变 request terminal state、shortcuts 与实际 owner 不一致、cursor/selection frame 漂移 |
| B5 | 40/60/80/120 cols、main/alt、CJK/emoji/combining/ANSI、resize 前后和完整区域 visual spec | artifact 缺 manifest/hash、任一 canonical scenario 非零差异、PTY 能力结论未回填 AC-14 |

## 4. 验收标准

### 4.1 自动化 AC

- [ ] AC-24:同一 active message 从首个 delta 到 `message_end` 始终保持相同 entry ids;输出中不再出现临时 `thinking:` / `tool:` dump。
- [ ] AC-25:user、assistant、thinking、execute、edit 在 40/60/80/120 列的 content start column 相同;collapsed/expanded 切换不改变该列。
- [ ] AC-26:user prompt 在窄屏完整 wrap;timestamp 要么完整出现,要么完整隐藏,测试禁止半截 timestamp。
- [ ] AC-27:rail/background/padding 覆盖 entry 的每一可见行;ANSI-stripped visible width 不超过 viewport。
- [ ] AC-28:thinking/execute/edit 保持各自 fold/truncate 规则;manual fold 后的 streaming update 不重开 block。
- [ ] AC-29:tool execution 在 placeholder 位置原位更新;execute output 不与 toolResult 重复;fallback args 有硬宽度/行数上限。
- [ ] AC-30:spacing 由 entry presentation 决定;空输出、尾换行、相邻 tool block 不产生意外双空行。
- [ ] AC-31:`computeScreenLayout()` 表驱动覆盖 8/12/16/20/24/40 行;任何输入下高度非负、总和不超 viewport、interactive slot 和 shortcuts 可见。
- [ ] AC-32:`main` 与 `alt` 对同一 view state 得到相同区域高度和内容顺序;只允许 host escape/control sequence 不同。
- [ ] AC-33:五种 request kind 共用 key-owner contract;park 不产生 response、不改变 request terminal state,明确 action 恰好响应一次。
- [ ] AC-34:parked card 下 `Tab/Space` 可返回;`Esc` 不穿透 abort;shortcuts 始终展示与实际下一步一致的 route。
- [ ] AC-35:status 继续省略 unknown 和 `<$0.005`;working 合入 status 后 transcript 不重复运行计数。
- [ ] AC-36:现有 Phase 2 自动化 AC 对应 tests 全部继续通过;`bun run check` fresh run 全绿。
- [ ] AC-37:每个 canonical scenario 都有不可变的 reference environment/artifact manifest;manifest 不一致时 harness 明确返回 `environment-mismatch`。
- [ ] AC-38:locked reference environment 中 candidate 与 grok-build 的 terminal cell frame diff 为 `0`;比较包含 grapheme、wide/continuation cell、foreground、background 和全部 attributes。
- [ ] AC-39:locked reference environment 中 candidate 与 grok-build 的同尺寸 PNG RGBA diff 为 `0`;differing pixels、最大 channel delta 均为 `0`,无 tolerance。
- [ ] AC-40:header、user band、thinking、assistant、execute、edit、status、composer、shortcuts、blocking card 的 rect、glyph、空白 fill、颜色、attributes、padding、wrap/clipping 和 compact/responsive states 都被 canonical scenario 覆盖。
- [ ] AC-41:时间、cursor blink、spinner/rail animation、randomness 和输入数据在 capture 中被关闭或固定;同一 fixture 重跑得到相同 frame/hash。
- [ ] AC-42:若 `pi-tui string[]` 无法达到 AC-38/39,已采用并测试 TUI-local deterministic `FrameComposer`;不得以跳过区域、截图后处理或放宽 tolerance 通过。

### 4.2 反向验证

每批至少做一次会变红的故障注入,注入只在本地验证后撤销:

| Batch | 注入 | 必须变红的保护 |
|---|---|---|
| B0 | 删除 user 文本尾部 | semantic golden assertion |
| B1 | collapsed 时回收 rail 列 | content-column alignment test |
| B2 | `message_end` 追加新 entry | stable identity/duplicate test |
| B3 | 让 card 与 editor 同时占 slot | layout invariant test |
| B4 | park 时调用 `respond()` | request terminal-state test |
| B5 | 在 40 列强画 timestamp 或改动一个 reference PNG pixel | narrow-width test + exact RGBA diff |

### 4.3 人工 UX checklist

- [ ] 真实 streaming 中 thinking/tool 原位生长,结束时没有整段闪跳。
- [ ] 40/60/80/120 列 resize 后文字不丢、timestamp 无残片、rail 对齐。
- [ ] 8/12/16/24 行下 composer/card 和退出路径始终可操作。
- [ ] execute success/failure、edit diff、thinking summary 在一屏内层级清楚。
- [ ] permission card `Esc -> scrollback -> Tab/Space -> card` 循环可理解,且 request 未被误答。
- [ ] `Enter` queue 与 `Ctrl+Enter` cancel-and-send 行为无回归。
- [ ] `main` 和 `alt` 均可输入、滚动、折叠、复制/降级、退出。
- [ ] OSC 52、滚轮、truecolor 的真实终端结论写回 AC-14。
- [ ] locked reference environment 中逐区域对照 header、user band、thinking、assistant、execute、edit、status、composer、shortcuts、card;cell diff 与 RGBA diff 均为 `0`。
- [ ] 同一 scenario 连续 capture 两次 hash 一致;若不一致,先处理 cursor/time/animation/PTY nondeterminism,不更新 reference。
- [ ] `grokbuild.png` 与 `myh.png` 仅作为历史定性证据;由于当前尺寸分别为 `2493x619` 与 `2560x1390`,不把它们当作 pixel baseline。

## 5. Release 与 bug bar

Phase 2.1 关闭需要同时满足:

1. AC-24~AC-42 全部通过。
2. 人工 UX checklist 全部有明确结论;能力不支持时记录降级,不能写成“视为通过”。
3. P0/P1 为 0。P0/P1 定义沿用 [phase-2.md](./phase-2.md) §3.1。
4. `ui.host = "main"` 逃生口未腐烂。
5. 从新版 TUI 开始重新完成 5 天 dogfooding;期间不因 UX 问题回退 host。

明确不作为出口条件:

- 在未锁定的跨 terminal/font/theme/DPI/window 环境之间保持像素相同;此类结果必须标记 `environment-mismatch`。
- 不属于 canonical scope 的 animated rail、mouse hover timestamp、group folding;若 operator 把它们纳入 scope,必须先固定其 frame 并新增 reference。
- 长历史 O(history) 优化;只要本轮没有可感知卡顿且未出现 correctness 问题。

## 6. Rollback

| 风险 | 回退方式 | 保守侧 |
|---|---|---|
| entry shell ANSI/background 异常 | revert B1,回旧 components | 内容可读优先于 chrome |
| `pi-tui` string rows 无法表达 reference frame | 保留高层 `pi-tui` API,回退到/启用 TUI-local `FrameComposer` adapter | 允许增加底层表达能力,不允许降低 zero-diff AC |
| projector 丢序/重复 | revert B2,回旧 timeline reducer | 允许旧视觉跳变,不允许丢内容 |
| 短终端 dock 不可操作 | revert B3 或强制 `main` host | composer/deny/exit 必须可达 |
| park 导致 request 卡死 | revert B4,恢复显式 dismiss policy | 不允许隐式 allow |
| alt capability 不足 | config 切回 `ui.host = "main"` | 保留同一 entry/layout state |

各 batch 不改 session/schema,无数据迁移回滚。任何 request 异常都向 deny/cancel 保守侧收敛,绝不因为 UI 改写默认 allow。

## 7. 验证命令

开工后每个 batch 至少运行:

```bash
bun test packages/tui/test
bun run --filter @myh/tui typecheck
bun run check
```

B5 另运行真实 CLI/PTY 场景,记录 terminal、host、columns/rows 和观察结果。只贴一张截图不算验证。

pixel parity harness 在实现后应提供等价的可重复命令(具体脚本路径由 B0 落地),至少能输出:

```text
capture reference/candidate --scenario <id> --columns <n> --rows <n>
diff cell <reference> <candidate>       # differing cells must be 0
diff png <reference> <candidate>        # differing pixels and max delta must be 0
verify manifest <reference> <candidate> # mismatch is a hard failure
```

每次交付报告固定写:

```text
Ran:
Not run:
Why:
Risk:
```

## 8. operator 决策门

推荐批准以下组合:

| 决策 | 推荐 | 另一选择及代价 |
|---|---|---|
| 移植粒度 | 独立 TypeScript projection/render 实现,以 locked reference 下 cell/PNG zero-diff 为出口 | 逐行 port 会复制无关功能,且与 `pi-tui` render model 冲突;“语义接近”不再是合格出口 |
| reference | 先确认 terminal/font/DPI/theme/locale/window/columns/rows/cursor/time/animation manifest 与 canonical scenarios | 不锁环境就无法定义 pixel diff,只能继续调研不能开工 |
| 底层 renderer | 先验证 `pi-tui` rows;能力不足时采用窄范围 deterministic `FrameComposer` | 强行保留 string-only path 会让 background/cell/PNG parity 无法达成 |
| card `Esc` | park,pending 不变 | 保持 dismiss 较简单,但无法安全回看上下文,也继续偏离 grok UX |
| 本轮范围 | transcript + dock + key router + exact visual spec/harness | 只换颜色/组件外观无法解决 streaming 重排、短终端布局和零差异验收 |
| host 默认值 | 验收前保持现状 | 立即翻 `alt` 会把 AC-14 未实测风险和 UI 重写风险绑在一起 |

operator 确认上述六项后,下一步是 B0,不是直接重写 `app.ts`。当前已按 operator 后续指示推进 candidate 实现;在 reference environment 和 upstream reference artifacts 未锁定前,任何 `packages/tui` 实现都不得被视为已完成 pixel parity。
