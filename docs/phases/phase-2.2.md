---
doc_kind: plan
created: 2026-09-04
---

# Phase 2.2 施工图 — 自有 TerminalFrame TUI

> 状态:已批准,实现中(2026-09-04 operator 批准;批准前审查补入两条:B0 前置安全快照、B4 前 interim request 策略)。同日:[ADR-006](../decisions/006-tui-cell-parity.md) 把视觉出口升级为锁定环境逐 cell 零差异,新增 B6 与 AC-48/49/50。B0 已合入(`6bac43d`)。Owner:operator。
> 决策:[ADR-005](../decisions/005-tui-own-compositor.md)(决策 1 由 ADR-006 修订)。
> [phase-2.md](./phase-2.md) 仍是 M1-M6 历史施工图;[phase-2.1.md](./phase-2.1.md) 已中止,本文接手 TUI 重写。

---

## Why

在 `pi-tui` 的 `Component.render(): string[]` 上改造 grok 式 UX,效果不好。行导向 widget 树无法干净表达 typed entry、整块 chrome、预先算好的 row budget,以及 card 替换 composer slot。继续打补丁只会让 projector / FrameComposer / Component 三套模型并存。

本轮删掉现有 TUI 实现,按 grok 的信息架构自写 cell compositor。视觉出口按 [ADR-006](../decisions/006-tui-cell-parity.md):锁定参考环境内逐 cell 零差异,PNG 为辅证。`protocol`、request bus、permission、tools、`pi-ai` / `pi-agent-core` 不动。

对应 [plan.md](../plan.md) §0 决策 2 的推翻与 §2 Phase 2 的 TUI 返工。

## Entry Criteria

| # | 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| E1 | operator 批准 ADR-005 与本文 Key Decisions | 状态行改为「已批准 / 实现中」 | 继续改方案,不删代码 |
| E2 | 删前 baseline | `bun run check` fresh run 全绿;记下当前 focused TUI tests 数量 | 先分清既有失败与方案问题 |
| E3 | 工作区边界 | 开工前记录 `git status`;不覆盖 operator 未提交的非 TUI 改动 | 有重叠先局部协调 |
| E4 | headless 逃生口 | `myh --json -p …` 不依赖 `@myh/tui` 的 paint 路径 | 先修 cli/headless,再删 TUI |

豁免:Phase 2 AC-14(OSC 52 / 滚轮 / truecolor 真实终端)仍未实测,本轮不把它改写成已通过。B5 只重新记录结论。

## What

```text
SessionEvent / RequestEnvelope
        |
        v
   AppViewState          projector + fold + cards + composer draft
        |
        v
   ScreenLayoutPlan      纯函数 row budget
        |
        v
   paint(...)            写入 TerminalFrame
        |
        v
   Host                  alt-screen + 差分 paint + stdin + resize
```

没有 `Component` 接口。区域是纯函数:`view + rect + theme → cells`。

### CLI 契约(冻结)

`packages/cli/src/main.ts` 当前只用:

```ts
import { App, scanFiles } from "@myh/tui";

const app = new App({
  port, host, requestBus, completionSource,
  getStatus, cwd, homeDir, showWelcome: true,
});
await app.start();
await app.waitUntilStopped();
```

本轮保持上述导出与 option 名。内部实现可以全换。`createInputCompletionSource` 仍在 `@myh/core`。

目标形状(施工约束,不是要求逐字同名):

```ts
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
  cells: TerminalCell[][];
  cursor?: { x: number; y: number; visible: boolean; shape: "block" | "underline" | "bar" };
}

type TranscriptEntry =
  | { id: string; kind: "user"; text: string; timestamp: number }
  | { id: string; kind: "assistant"; markdown: string; timestamp: number; lifecycle: BlockLifecycle }
  | { id: string; kind: "thinking"; block: BlockEnvelope<"thinking">; durationMs?: number }
  | { id: string; kind: "execute"; block: BlockEnvelope<"execute"> }
  | { id: string; kind: "edit"; block: BlockEnvelope<"edit"> }
  | { id: string; kind: "notice"; text: string; tone: "muted" | "error" | "success" };

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

### B0 — 清空 + 契约 stub

**路径**:`packages/tui/**`、`scripts/tui-frame.ts`、`scripts/tui-frame.test.ts`、`scripts/check-deps.ts`、根 `package.json`、`packages/cli/src/main.ts`(只许改 import 若导出路径变,默认不改)

**内容**:

- 前置(批准审查补充):开工前把当前工作区整体提交为安全快照(已落实为 commit `580943e`),否则删除不可逆、下方回退行的 revert 无从谈起。
- 删除 `packages/tui/src` 与 `packages/tui/test` 里全部现有实现和测试。
- 删除 pixel-parity harness:`scripts/tui-frame.ts`、对应 test、`tui:frame` script。
- 去掉 `@earendil-works/pi-tui` 依赖(根与 `packages/tui`)。
- `check-deps.ts`:tui 允许集 = `@myh/protocol` + `node:`。
- 重建最小导出:`App`(CLI 用到的 options)、`scanFiles`(从 `input/file-picker.ts` 抽取到不 import pi-tui 的模块;保留 Bun.Glob 同步扫描)。
- stub `App.start()`:进入 raw mode + alt-screen,Ctrl+C / `q` 调用 `stop()` 并恢复终端。不跑 turn,不画 grok chrome。
- `host` / `showWelcome` 等 option 接受但不实现。
- interim request 策略(批准审查补充):stub 订阅 `requestBus.requests()`,对五种 kind 一律返回保守结果(permission→deny、question/oauth/cancel_confirm→cancel、plan_approval→reject),直到 B4 由 card 接管。消灭 B0-B3 无 UI 响应导致的 request 悬挂;与 Rollback 表「UI 异常时 deny/cancel」同一保守侧。

**tradeoff**:交互模式在 B0-B2 期间几乎不能用。换来的是依赖图立刻干净,后续批次不再跟旧 Component 共存。headless 不受影响。

**验收**:`bun run check` 全绿;`grep -r pi-tui packages/tui` 为空;CLI `--json` 用例通过;构造 `App` 再 `start`/`stop` 能恢复终端。

**回退**:revert B0 即回到 pi-tui 树。不可回退面(删代码)单独本批且先合。

### B1 — Host + TerminalFrame compositor

**路径**:`packages/tui/src/{host.ts,frame.ts,ansi.ts,width.ts,theme.ts,keys.ts}`

**内容**:

- alt-screen、raw stdin、SIGWINCH、进程退出/信号时恢复终端(含异常路径)。
- `TerminalFrame` 的分配、写入、wide grapheme / continuation cell。
- 差分 paint:只输出变化的 cell 或行;可选 `CSI ?2026` 同步输出。
- 自有 `visibleWidth` / `truncateToWidth`(CJK、emoji、combining)。
- 按键解码到结构化 `Key`(字符、Enter、Esc、Tab、Ctrl+C、箭头、Ctrl+Enter)。不支持 kitty keyboard protocol。
- 语义色槽沿用现有槽名与 GrokNight RGB 数据;theme 产出 cell color,不再包一层 ANSI 字符串函数作为唯一 API。
- 256-color 降级:检测 `COLORTERM` / truecolor,量化写在 theme 边界。

**tradeoff**:第一版不做 main/inline host、不做鼠标选区。滚轮可在 B3 再接。放弃第三方 `string-width` 一类依赖,宽度策略由本仓库测试锁定。

**验收**:表驱动 frame 写入(含宽字符);人为改 1 cell 的 diff 测试变红;host 单测用 fake stdout 断言进入/退出序列;崩溃路径仍发出恢复序列。

**回退**:只影响 tui host;B0 stub 可暂时接回。

### B2 — Screen layout + composer

**路径**:`packages/tui/src/{layout.ts,header.ts,status-line.ts,composer.ts,editor.ts,dock.ts,app.ts}`

**内容**:

- 纯函数 `computeScreenLayout()`。优先级与 Phase 2.1 §2.6 相同:interactive ≥3、shortcuts=1、transcript 保底、status 0/1、header 可藏、`rows<=20` compact、`rows<=16` 去装饰。
- 自写 editor:grapheme 缓冲、换行、光标、Backspace、左右、Enter 提交。第一版不做 undo 栈与多光标。
- composer chrome 靠齐 grok PromptWidget 几何(圆角边框、底栏 model caption),不要求 PNG 零差异。
- header / status 诚实性沿用 Phase 2 M6:未知省略、`cost < $0.005` 隐藏、running 只活在 status。
- shortcuts 从 `KeyOwner` 生成,窄屏保 pinned 退出路径。
- `App` 接上 layout:空 transcript 时仍可输入。`port.runTurn` 尚未投影到 typed entry,B2 可以把 turn 事件忽略或先做成 notice 行。
- turn 产生的 request 仍由 B0 的保守应答兜底;B2 不实现 card。

**tradeoff**:editor 从零写,行为不会等于 pi-tui `Editor`。换来的是光标与 wrap 直接落在 cell 上,不再绕 `CURSOR_MARKER`。欢迎页推迟到 B5。

**验收**:layout 表驱动覆盖 8/12/16/20/24/40 行,高度非负且总和不超过 viewport;CJK 输入不拆 grapheme;Enter 提交、Ctrl+C 退出。

**回退**:保留 B1 host,composer 可降级成单行 readline。

### B3 — Transcript projection + EntryShell

**路径**:`packages/tui/src/transcript/*`、`packages/tui/src/blocks/*`、`packages/tui/src/scroll.ts`

**内容**:

- `TranscriptProjector`:UI-local `messageSeq + contentIndex` 与 `toolCallId` 稳定 identity;streaming 原位 upsert;`message_end` 为最终 truth,不追加第二份。
- `EntryShell` 独占 rail / padding / surface / timestamp reserve / vpad / clipping。kind renderer 只出 header/body/summary。
- 保留 FoldState 语义:`default/current/manual`;thinking truncated lines;execute first/last;edit 用 core hunks 的 `+N/-M`。
- 应用内滚动 + follow/anchor。折叠快捷键 `Ctrl+O`(或与 grok 对齐的等价键)在施工时写进 shortcuts,不新发明一套。
- assistant 正文 B3 先做 wrap + 代码块;完整 markdown 放到 B5。

**tradeoff**:不引入 height cache。不移植 animated rail。不把 protocol 补 message id;不够再单独 ADR。

**验收**:继承并重测 AC-24..AC-30、AC-15、AC-17。禁止 streaming 阶段出现临时 `thinking:` / `tool:` dump。

**回退**:projector 只在 TUI 内;可回到 B2 的 notice 行。

### B4 — Request cards + input router

**路径**:`packages/tui/src/{input-router.ts,focus-stack.ts,esc.ts,request-card.ts,app.ts}`

**内容**:

- 五种 request kind 共用 card 几何;blocking card 替换 interactive slot,不与 composer 同时 paint。
- `resolveKeyOwner()`:`card → scrollback(parked) → composer → global`。
- `Esc` 在 card 上的最后一阶是 park,不是 deny。显式 action 才 `respond()`。
- parked 后 `Tab` / `Space` 返回 card;此时 `Esc` 不穿透 abort。
- 迟到 / 总线终态仍归档卡片,走保守侧 deny/cancel。
- 移除 B0 的保守应答循环,card 成为 request 的唯一响应者。

**tradeoff**:放弃「Esc 永远等于否决」。这是本轮唯一用户可感知的交互相对 Phase 2 默认 dismiss 的变化,单独成批。

**验收**:继承并重测 AC-33、AC-34、AC-11、AC-12。park 不得调用 `respond()`。

**回退**:revert B4,临时把 Esc 映射回 deny;不回退 B1-B3。

### B5 — 输入面恢复 + 终端能力记录

**路径**:`packages/tui/src/input/*`、markdown 绘制、welcome(可选)、`packages/core/src/config.ts`(默认 `ui.host`)

**内容**:

- `/` 菜单与 `@` file picker:解析仍在 core,交互 UI 在 tui。`scanFiles` 继续给 CLI completionSource。
- `Enter` 排队,`Ctrl+Enter` cancel-and-send。
- assistant markdown 的最小可用集:heading、fence、bold/italic、list。不是完整 CommonMark。
- welcome 页:CLI 已传 `showWelcome: true`;本批补上,不阻塞日常对话路径。
- 默认 `ui.host` 改为 `"alt"`。`"main"` 若未实现 inline,则 alias 到 alt 并在 config 注释/文档标明暂缓。
- 真实终端记录 OSC 52、滚轮、truecolor,回填 Phase 2 AC-14。不支持就写降级,不写「视为通过」。

**tradeoff**:markdown 保真度低于 pi-tui `Markdown`。file picker 仍同步扫描。inline/main host 明确不做。

**验收**:AC-19、AC-20、AC-21..AC-23、AC-14 结论落盘;`bun run check` 全绿。

**回退**:功能开关或 revert 本批文件;host 默认值可单独改回。

### B6 — reference capture + cell parity 门禁

> 开工时机:reference capture 的 spike 与 B1 并行;harness 紧随 B1 的 `TerminalFrame`;parity 门禁自 B2 起对每个视觉区域增量生效。

**路径**:`scripts/tui-frame.ts`(按新 compositor 重写)、`packages/tui/test/fixtures/reference/**`、`packages/tui/src/frame.ts`(序列化 / diff 出口)

**内容**:

- spike:确认 reference 获取路径——直接 PTY 驱动 grok-build 进入 canonical states,或借其内部渲染测试产 cell dump;结论回填本批后再全面施工。
- locked reference environment manifest:终端/版本/字体+hash/尺寸/TERM/COLORTERM/locale/固定时钟;不一致返回 `environment-mismatch`。
- canonical scenarios 的 reference cell dump + ANSI 流 + PNG(辅证)落盘为不可变 fixture,带 artifact hash;同一 fixture 重跑 hash 一致才可入库。
- parity harness:myh `TerminalFrame` 序列化后与 reference dump 逐 cell diff;B2-B5 每个视觉批次新增区域时同步补 scenario。
- 时间、cursor blink、动画 phase、随机输入在 capture 中关闭或固定。

**tradeoff**:环境工程与 fixture 维护是长期成本;换来视觉验收脱离观感循环。B0 删掉的旧 harness 不恢复,仅作 git 历史参考。

**验收**:AC-48、AC-49、AC-50。

**回退**:harness 与 fixture 独立成目录,revert 不影响 B1-B5 功能;若 grok-build 无法被干净驱动,回 spike 结论找次优 capture 路径,不放宽 AC 字段。

## Acceptance Criteria

出口条件:

- 下方 AC 全部为 ✅
- Phase 2 bug bar:P0/P1 为 0(定义见 [phase-2.md](./phase-2.md) §3.1)
- 从新 TUI 起重新计 5 天 dogfooding,期间不因 UX 回退到已删除的 pi-tui 树
- headless `--json` 全程绿

明确**不**作为出口条件:

- 跨 terminal/font/DPI 环境的像素一致(环境不一致标 `environment-mismatch`)
- PNG/RGBA 零差异作硬门禁(ADR-006:PNG 为辅证落盘)
- `ui.host = "main"` 的独立 inline 实现
- dashboard / peek / team / Minimal / mouse selection / vim / animated rail
- 完整 CommonMark、undo 栈、kitty keyboard

### 新 AC

- [ ] AC-43:`packages/tui` 的 `package.json` 与 `src/**/*.ts` 不出现 `@earendil-works/pi-tui`;`check-deps` 对违规变红。
- [ ] AC-44:所有可见输出只来自 `TerminalFrame`;测试禁止再断言 `Component.render(): string[]`。
- [ ] AC-45:editor 在 40/80 列对 ASCII 与 CJK 提交原文、光标不落在宽字符中央。
- [ ] AC-46:`start` 后正常退出、Ctrl+C、以及 host 绘制函数抛错时,终端都离开 alt-screen 并恢复 raw mode。
- [ ] AC-47:B0 起根依赖不再包含 `@earendil-works/pi-tui`;`pi-ai` / `pi-agent-core` 仍 exact pin。
- [ ] AC-48:每个 canonical scenario 有不可变 reference environment/artifact manifest;manifest 不一致时 harness 明确返回 `environment-mismatch`;同一 fixture 重跑 frame hash 一致(时间、cursor blink、动画 phase、随机性已固定)。
- [ ] AC-49:locked reference environment 中,myh `TerminalFrame` 与 grok-build reference cell dump 逐 cell 零差异(grapheme、width/continuation、foreground、background、全部 attributes、cursor);覆盖 gap 调研 §6.2 canonical scenarios 与 §6.3 逐区域字段。
- [ ] AC-50:parity 反向验证——人为改 1 个 cell,对应 scenario 测试必须变红;不得以跳过区域、后处理或放宽比较字段通过。

### 继承并必须在新测试下重测

来自 Phase 2.1 的信息架构(非像素):AC-24..AC-35。

来自 Phase 2 的 TUI 行为:AC-11、AC-12、AC-15、AC-17、AC-19、AC-20、AC-21、AC-22、AC-23;AC-14 只要求重新记录,不要求本轮实测通过。

退役:Phase 2 AC-13(同一 Component 树在两种 pi-tui 宿主下);Phase 2.1 AC-39(PNG 硬门禁,降为辅证)与 AC-42(以 pi-tui 为前提的 compositor 条件条款,底座已自有)。Phase 2.1 AC-37/38/40/41 的语义由 AC-48/49/50 在自有 compositor 上接手。

## Test plan

| 层 | 覆盖什么 | 跑在哪 |
|---|---|---|
| unit | width、frame diff、layout 表、projector identity、key owner、scanFiles | `bun test packages/tui/test`;CI |
| 契约 | `App` options / `scanFiles` 仍能被 cli typecheck | `bun run --filter @myh/cli typecheck` |
| 反向 | 人为加 `pi-tui` import;park 时 `respond()`;layout 让 card 与 composer 同时占 slot;改 1 cell | 各 batch 本地注入后撤销 |
| 人工 | 真实终端:输入、滚动、折叠、permission park 循环、退出恢复 | B5;一张截图不算 |
| parity | canonical scenario 的 reference cell dump 与 myh frame 逐 cell diff;`environment-mismatch` 路径;改 1 cell 变红 | B6 起,`bun test packages/tui/test` + `scripts/tui-frame.ts` |

每个 batch 至少:

```bash
bun test packages/tui/test
bun run --filter @myh/tui typecheck
bun run check
```

交付报告固定写 Ran / Not run / Why / Risk。

## 明确不做

- pixel parity harness 与 `scripts/tui-frame.ts` → 随 B0 删除,不再维护
- 逐行 port grok-build Rust → 借契约,不借代码
- 继续使用 `pi-tui` Editor / Markdown / ScrollView / TuiAltScreen
- 引入第二个 TUI 框架
- Phase 2.5 dashboard、team peek
- 本轮翻转 inline/main 为完整第二宿主

## Rollback

| 风险 | 回退 | 保守侧 |
|---|---|---|
| B0 清空后交互不可用 | revert B0 | headless 继续工作 |
| host 退出后终端损坏 | 修恢复序列;必要时提供 `reset` 说明 | 失败时离开 alt-screen,不留 raw mode |
| editor 不可用 | revert B2,临时单行输入 | 必须能 Ctrl+C 退出 |
| projector 丢内容 | revert B3 | 允许旧视觉,不允许丢事件 |
| park 卡住 request | revert B4 | UI 异常时 deny/cancel,绝不默认 allow |
| 真实终端能力不足 | 记入 AC-14 降级 | 不把未测写成通过 |
| grok-build 无法被干净驱动出 canonical states | B6 spike 先行,找次优 capture 路径 | 不放宽 cell 比较字段,不拿观感冒充通过 |

各 batch 不改 session schema。B0 是唯一大删,必须单独先合。

## Key Decisions

已由 operator 2026-09-04 选定,细节见 [ADR-005](../decisions/005-tui-own-compositor.md):

1. 产品目标 = grok 信息架构 + 交互,不是 pixel parity。
2. 渲染底座 = 自有 `TerminalFrame` compositor,移除 `pi-tui`。
3. 施工 = 批准后清空重写,只留 `App` / `scanFiles`。

本施工图补充、仍待 E1 一并确认:

4. 第一版只做 alt-screen;`ui.host = "main"` 暂缓,允许临时 alias 到 alt。
5. editor / 宽度 / 按键 / markdown 均自写,不新增 npm TUI 依赖。
6. B4 才改变 Esc=park;B0-B3 无 card 时不涉及该行为变更。
7. welcome 与完整 markdown 放 B5,不阻塞 B2 日常输入骨架。
8. B4 之前 request 由保守应答兜底(permission→deny 等),不因 UI 未就位而悬挂;B0 开工前先提交安全快照。(2026-09-04 批准审查后补入,operator 确认)
9. 视觉出口 = 锁定参考环境内逐 cell 零差异,PNG 为辅证,跨终端不承诺像素一致。(2026-09-04 operator 指示,见 [ADR-006](../decisions/006-tui-cell-parity.md))

## Dependencies

- Phase 2 M1 request 总线、M2 permission、M4 的 protocol block/hunk 与 core `digest()` 已在,不重做。
- slash / mention 解析已在 `packages/core/src/input/`,B5 只重做 TUI 交互。
- 不依赖 Phase 2.1 的 reference environment 或 golden PNG。

## Risk

| 风险 | 缓解 |
|---|---|
| 自写 editor 行为缺口(IME、宽字符、wrap) | B2 把 CJK/光标列为 AC-45;IME 异常记 P2,不扩第一版范围 |
| 退出未恢复终端 | B1 用 try/finally + 信号 + `exit` 钩子;AC-46 反向测抛错路径 |
| 清空后长时间没有能用的交互 TUI | B0 stub 可退出;B2 即恢复输入骨架;headless 始终可用 |
| 语义色槽/chrome 与 grok 观感差很远 | 槽名与 GrokNight RGB 作为数据保留;不以 PNG diff 关门 |
| 误改 protocol/core | 批次路径限制在 `packages/tui` 与 deps 门禁;cli 只许契约兼容 |
