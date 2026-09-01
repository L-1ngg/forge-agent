---
doc_kind: plan
created: 2026-09-01
---

# Phase 2 施工图 — TUI 升到 grok 水准 + permission 流水线

> 状态:草稿(2026-09-01),**待 operator 确认后才写码**。Owner:operator。
> 对应 [plan.md](../plan.md) §2 Phase 2;设计论证见 [design-rationale.md](../design-rationale.md) A / C.2 / C.4,失效模式出处见 [cat-cafe.md](../cat-cafe.md)。
> 本文档是 Phase 2 的唯一施工图。工作项格式延续 [phase-1.md](./phase-1.md):**路径 / tradeoff / 验收**;流程骨架(entry criteria → milestone → test plan → release criteria → rollback)见 §5 的映射说明。

---

## 一句话说完

Phase 1 做出了「能用」,Phase 2 做「敢放手用」。

两件事:**问过你再动手**(permission 流水线 —— 工具执行前按规则判断,该问的问、该拦的拦、记住的授权作用域清晰),以及**看得清它在干什么**(全屏 TUI:输出按 block 折叠、改文件显示 inline diff、卡片焦点行为一致、状态栏诚实)。

底下垫着一件工程上更重要的事:**阻塞式交互全部走带 id 的 request/response 总线**,不是 `await ui.confirm()`。这条是整份规划里唯一「现在写错、以后一定重写」的地方([design-rationale C.4 ②](../design-rationale.md)),所以它是 Phase 2 的第一个里程碑,不是顺手做的。

---

## 0. 前置门禁(Entry Criteria)

开工前必须全部为 ✅。**这一节是硬门禁,不是清单**:任一项未过,对应里程碑不许开工。

| # | 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| E1 | Phase 1 整体验收关闭 | [phase-1.md](./phase-1.md) §3 五条全绿,状态行改为 `已完成` | 先关 Phase 1;Phase 2 不许并行开工 |
| E2 | Phase 1 真实使用 issue 清单成形 | 3 天使用中「想用回别的工具」的瞬间已逐条记录并分类(Phase 2 / 2.5 / 3 / 不做) | 门禁不过。**这份清单是 Phase 2 范围的第一顺位输入**,优先级高于本文档的预设排序 |
| E3 | **alt-screen 下的终端能力实测**(Phase 0 遗留人工项) | 真实终端 + WSL2 下目测:鼠标滚轮、**OSC 52 剪贴板**、truecolor 三项在 `TuiAltScreen` 里可用 | OSC 52 不通 → M3 降级(见 M3 tradeoff);滚轮不通 → 应用内滚动只走键盘;truecolor 不通 → 色槽降级到 256 色 |
| E4 | pi 的 `beforeToolCall` 契约复核 | grep `dist/` 确认 `block` / `reason` / `terminate` 已实现(非 `NotImplemented`),且确认仍无 `updatedInput` | 有 `updatedInput` → M2 的 rewrite 层可简化;`beforeToolCall` 是空壳 → deny 半边也落到自有包装层 |

E3 是 Phase 0 留下的唯一真门禁项。Phase 1 用 `TuiMainScreen` 时它无关紧要,**切 alt-screen 后它决定「能不能复制粘贴」**——所以现在升级为阻断项。

---

## 1. 里程碑与依赖顺序

```
M1 request 总线(协议地基,最高风险)
   └─→ M2 permission 流水线(总线的第一个真实使用者)
M3 TUI 宿主升级(alt-screen + FocusStack + 应用内滚动)
   ├─→ M4 block 模型(折叠 / inline diff / 输出裁剪 + digest)
   ├─→ M5 输入与导航(/ 菜单、@ picker、Ctrl+Enter、Esc 分层)
   └─→ M6 status line + 语义色槽主题
M2 × M3 汇合 ─→ blocking card(permission 卡片是第一张真卡)
```

- **M1 必须最先,且单独合入。** 它是唯一「写错等于重写」的项,不能和 UI 改动混在一个批次里评审。
- M3 与 M1/M2 可并行(两侧只通过 protocol 相见)。
- blocking card 是 M2 与 M3 的汇合点:M2 提供 payload 与决策语义,M3 提供焦点契约,卡片本身在两者都绿之后写。
- M4/M5/M6 依赖 M3 的宿主,彼此独立,可任意顺序。

**每个里程碑是一个可独立合入、可独立回退的批次**(见 §6 rollback)。不追求同时落地。

---

## 2. 工作项

### M1 — request 总线

**路径**:`packages/protocol/src/requests.ts`(扩展 kind union)、`packages/core/src/request-bus.ts`、`packages/cli/src/headless.ts`(非交互应答策略)、`tests/request-bus/`

**内容**:

- **五种 kind 一次定全**,不留「以后再加」:`permission` / `cancel_confirm` / `question` / `plan_approval` / `oauth`。plan_approval 的**消费者**在 Phase 3,但**形状现在定**——理由同 Phase 1 对 envelope 的处理:形状晚定就是协议 breaking change。
  - `oauth` 是最容易漏的第五种([design-rationale C.4 ②](../design-rationale.md)):`pi-ai` 用本地回调端口等浏览器跳转,同样是阻塞式交互,不许 `core` 直接往 stdout 打 URL。
- **总线契约**(这是 M1 的真正交付物,不是那几十行实现):
  - id 由 core 分配,全局唯一,不复用。
  - 每个 request 恰好一个终态:`response` | `cancelled` | `timeout`。
  - 迟到 / 重复 / 未知 id 的 response 一律**丢弃并记录**,不报错、不生效第二次。
  - turn 被 abort 时,在飞的 request 自动 `cancelled`——决策语义是 **deny**,不是「继续等」。
  - UI 是唯一响应者;core 不持有任何 UI 引用。
- **headless 的非交互策略**:五种 kind 各有确定行为,**默认全部 deny + 稳定退出码**,不做隐式降级(延续 Phase 1 ⑥ 的立场:让边界问题暴露而非被吞掉)。

**Tradeoff**:总线实现成**双向事件流**(request 出、response 入,两条 async iterable),**放弃** `Promise<Decision>` 风格的直接调用。理由:Promise 风格在 in-process 下更短,但它把「谁是响应者」编译期绑死,以后换 socket 是重写而非替换实现([design-rationale C.4](../design-rationale.md) 演进路径)。代价:core 内部要自己维护 pending map + 超时,约多 50 行,且调用点从 `await confirm()` 变成 `await bus.ask(...)`——形状仍是 await,可读性损失有限。

**放弃的另一条**:不引入通用 RPC 库。五种 kind、单进程、单响应者,引一个库来传五个信封是过度工程(同 Phase 1 对 dependency-cruiser 的判断)。

已定决策:[ADR-002](../decisions/002-request-bus-shape.md)。

**验收**:见 AC-1 ~ AC-5。

### M2 — permission 流水线

**路径**:`packages/core/src/permission/{decide.ts, rules.ts, memory.ts, danger-list.ts}`、`packages/tools/src/wrap.ts`(rewrite 层)、`packages/core/src/pi-port.ts`(挂 `beforeToolCall`)

**内容**:

- **决策链写成纯函数**:`decide(toolCall, ctx) → allow | deny(reason) | ask(payload)`。层序照 plan.md:hooks → rules → 记住的授权 → 内置自动批准 → mode。纯函数的意义是可表驱动测试、可解释给用户看、可属性测试——与 Phase 1 把 abort 抽成纯函数状态机是同一手法。
- **两个半边分开落**([design-rationale A](../design-rationale.md) 实读结论,pi 无 `updatedInput`):
  - **deny 半边**挂 pi 的 `beforeToolCall`(`{ block, reason, terminate }`)。
  - **rewrite 半边**归自有工具包装层:decorator 在进 `execute()` 前查策略引擎。
- **「记住」的诚实性三条**(grok 第二优先,[design-rationale](../design-rationale.md) 明确要借):
  1. 确认前就显示**究竟会记住什么**(规则原文,不是「记住此选择」)。
  2. 危险清单(`rm` / `chmod` / `kill` / `git push`)**从不认记住的前缀**——即使存在匹配的 always-allow 规则,仍然提示。
  3. **当没有任何可记住的规则能阻止再次提示时,不提供 Always allow 行**,而不是存一条不起作用的规则。
- **授权作用域随对象验证**([cat-cafe.md](../cat-cafe.md) F.1 ③ 教训):记住的授权键必须含被授权的**对象**(工具 + 具体参数模式),不能只记工具名。丢作用域正是 F24 事故的形状——「可以合入」是真的,只是说的是另一个 PR。
- **mode 只做 Phase 2 需要的**:`default` / `accept-edits` / `deny-all`。`plan` mode 是 Phase 3,枚举里**不预留**——预留一个没有实现的模式值比以后加一个更贵。

**Tradeoff**:规则匹配用**显式前缀 / glob 规则表**,**放弃**正则与自定义 DSL。理由:clowder 的 predicate DSL 是本项目 D 节明确不做的东西——「一条规则一个家,且选那个能说『不』的家」;可执行的家在 `decide()` 这个纯函数里,不在配置语言里。代价:表达力有上限,复杂策略要改代码。触发重估:出现第三个「规则表写不出来」的真实需求。

已定决策:[ADR-003](../decisions/003-permission-rule-matching.md)。

**验收**:见 AC-6 ~ AC-10。

### M3 — TUI 宿主升级

**路径**:`packages/tui/src/{host.ts, focus-stack.ts, scroll.ts, app.ts}`、`packages/core/src/config.ts`(`ui.host` 开关)

**内容**:

- 宿主换 `TuiAltScreen`,`ui.host = "alt" | "main"` 是 config 开关,**默认值在 Phase 2 收尾前保持 `main`**(灰度开关,见 §6)。
- `FocusStack`:`Tab` 在栈顶卡片内环绕**不越界**;`Esc` 只 pop 一层,pop 后卡片**留在 scrollback 可读**;shortcuts bar 从 `FocusStack.top()` 取,而非各卡自己上报。
- **应用内滚动**(Phase 1 已知粗糙点还债):alt-screen 拿走了终端 scrollback,滚动必须自己实现(`ScrollView` + 键盘 + 滚轮)。
- Esc 分层语义 + 800ms 双击 + 取消后约 1 秒抑制 rewind(grok 第三优先里唯一现在就要的一条——因为它与 FocusStack 是同一套焦点语义,分开做会做两遍)。

**Tradeoff**:切 alt-screen **放弃**终端原生 scrollback 与原生选区复制。这是真实代价:复制依赖 **OSC 52**,而 OSC 52 至今未在本机实测(E3)。三条路已排序:
1. E3 通过 → 正常切换。
2. OSC 52 不通 → alt-screen 保留,但提供 `ui.host = "main"` 常驻逃生口 + 「导出当前 block 到文件」作为复制替代。
3. 滚轮 + OSC 52 都不通 → **推迟切换**,M4/M5/M6 全部可以在 `TuiMainScreen` 上做(它们依赖的是 Component 树,不是宿主)。pi 把两种宿主接口做成一样,正是为此([design-rationale C.2](../design-rationale.md))。

**验收**:见 AC-11 ~ AC-14。

### M4 — block 模型

**路径**:`packages/tui/src/blocks/{thinking.ts, edit.ts, execute.ts, fold.ts}`、`packages/protocol/src/blocks.ts`(block 元数据 + diff hunk 结构)、`packages/core/src/digest.ts`

**内容**:

- 每类型独立折叠配置:thinking `truncated_lines=3`;edit block 是 **inline diff 带 `+N/-M`**;execute block 首尾裁剪 `first_lines=2 / last_lines=3`。
- `respect_manual_folds`:解决流式更新与手动折叠的冲突——手动折叠过的 block,后续 delta 不许把它弹开。
- **切分线守住**([design-rationale C.4](../design-rationale.md)「core 给数据,UI 给像素」):core 出 diff hunk 结构 / markdown **源文本** / `{ lang, code }` / 折叠配置 / 色槽名;UI 出 ANSI、语法高亮、折叠指示器。
- **反方向切一次:`digest()`** —— 这里是 Phase 1「bash 输出硬截断」的真正还债处。给人看的是首尾裁剪 + 可展开的富态,**给模型看的是压过的一行**。协议里两个字段分开走,别让「UI 好看」把 context 撑爆。

**Tradeoff**:diff 结构在 core 算,**放弃**在 UI 层 diff。理由:web UI 迟早是第二个客户端,diff 算两遍必然漂移。代价:core 要带一个 diff 实现(用成熟库,不自写)。

**验收**:见 AC-15 ~ AC-18。

### M5 — 输入与导航

**路径**:`packages/core/src/input/{slash.ts, mention.ts}`(解析)、`packages/tui/src/input/{menu.ts, file-picker.ts}`(交互)

**内容**:

- `/` 菜单 + `@` file picker。**解析归 core,交互 UI 归 tui**——切分线原文:进协议的是「解析结果」,不是补全的交互([design-rationale C.4](../design-rationale.md))。这一条也是 Phase 2.5 `@mention` 路由的前置:同一个解析器,不许写两份。
- `Ctrl+Enter` cancel-and-send(Phase 1 推来的):「停下你在做的事,接这个」。`Enter` 仍是排队。两个键,两种语义,不合并。

**Tradeoff**:file picker 用**同步目录扫描 + 前缀过滤**,放弃索引与模糊匹配。理由同 Phase 1 的 session-search:单仓库量级够用。触发重估:在真实仓库上可感知卡顿。

**验收**:见 AC-19 ~ AC-20。

### M6 — status line + 语义色槽

**路径**:`packages/tui/src/status-line.ts`、`packages/tui/src/theme.ts`、`packages/core/src/usage.ts`

**内容**:

- **context 用量在真相点计算**([cat-cafe.md](../cat-cafe.md) F.1 ②):展示的必须是当前 context 的实际装配结果,**不是上一次 API 调用返回的缓存快照**。这条不是打磨,它是 Phase 3 压缩阈值(0.80 / 0.88)能不能起作用的前提——用量算错,压缩机制一次也跑不起来。
- **诚实性三条**(grok 第二优先):`cost` 低于 $0.005 直接隐藏(避免误导的 `$0.00`);算不出的字段**省略而非发占位符**;运行计数**只活在 status line**,transcript 永不重述。
- 语义色槽表:Component 只查槽名(`accent_thinking` / `accent_plan`),不写颜色。

**Tradeoff**:色槽表用 TS 常量,**放弃** `pager.toml` 式样式外置文件。理由:主题可配置对单人工具是零收益,而槽名是编译期检查的收益。触发重估:出现第二个使用者或明确的主题需求。

**验收**:见 AC-21 ~ AC-23。

---

## 3. 验收标准(Release Criteria)

### 3.1 出口条件

Phase 2 关闭需要**同时**满足:

1. 下方 AC 全部为 ✅。
2. **Bug bar 清零**:P0 / P1 为 0。分级定义——P0:数据丢失 / 未经批准执行了工具 / 无法退出;P1:核心链路(打断、批准、滚动、复制)不可用或行为不一致;P2:渲染瑕疵、文案、边缘键位(可带入 Phase 2.5)。
3. **Dogfooding 5 天**:`ui.host = "alt"` 且 permission 开启的日常使用,期间不回退开关。新记录的「想用回别的」瞬间归入 Phase 2.5 / 3 清单。
4. `ui.host = "main"` 逃生口仍可用(不许因为切了 alt 就让老路腐烂——延续 headless 的同一条纪律)。

明确**不**作为出口条件:渲染美观度、token 成本、启动耗时。Phase 2 验证的是「一致 + 诚实」,不是「快」或「漂亮」。

### 3.2 AC 清单

**M1 request 总线**

- [ ] AC-1:五种 kind 的类型在 `protocol` 定稿;`core` 里不存在第二条阻塞式交互路径(grep 断言:`core` 无 `ui.` 调用、无 `prompt(`/`confirm(` 直调)。
- [ ] AC-2:属性测试(fast-check,≥500 轮)覆盖总线四条不变量:每个 request 恰好一个终态;重复 response 只生效一次;未知 / 迟到 id 被丢弃且不改变状态;终态吸收(终态后任何输入不改变状态)。
- [ ] AC-3:turn abort 时在飞 request 自动 `cancelled`,且决策落到 **deny**;session JSONL 中不留半个 turn(与 Phase 1 ⑦ 的 abort 原子性同一条约束)。
- [ ] AC-4:headless 下五种 kind 各有确定行为与稳定退出码;CI 用例逐 kind 断言退出码。
- [ ] AC-5:**反向验证**——人为往 `core` 里加一处直调 UI 的代码 → CI 变红(依赖检查扩一条规则)。

**M2 permission**

- [ ] AC-6:`decide()` 表驱动测试:五个层级各能单独否决与放行,层序可被测试证明(交换两层顺序 → 有用例变红)。
- [ ] AC-7:危险清单命令即使存在匹配的 always-allow 规则**仍然提示**(逐条断言 `rm` / `chmod` / `kill` / `git push`)。
- [ ] AC-8:「没有任何可记住的规则能阻止再次提示」的场景下,卡片**不出现** Always allow 行(反向用例:构造一个不可记住的调用,断言选项集合)。
- [ ] AC-9:记住的授权键含被授权对象;仅工具名相同、对象不同的第二次调用**仍然提示**(F.1 ③ 作用域回归测试)。
- [ ] AC-10:rewrite 层端到端跑通一个入参改写用例(如路径规范化或敏感值脱敏),且 `beforeToolCall` 的 deny 半边独立可测。

**M3 宿主**

- [ ] AC-11:焦点契约测试——录制键序回放,断言 `FocusStack` 状态:`Tab` 不越界、`Esc` 只 pop 一层、pop 后卡片仍在可读区。
- [ ] AC-12:**四种卡片跑同一套焦点测试**(同一测试参数化四遍全绿),而非各写一套。
- [ ] AC-13:`ui.host` 在 `alt` / `main` 间切换,Component 树不变(同一棵树在两种宿主下渲染均无异常)。
- [ ] AC-14:E3 三项在 alt-screen 下的实测结论记录进本文档 §7;若走降级路径,降级方案与代价一并落盘。

**M4 block**

- [ ] AC-15:同一份 block 数据经 TUI 与 headless JSON 两条路输出,语义一致(字段与折叠状态可对齐比较)。
- [ ] AC-16:`digest()` 满足:输出不含 ANSI、有硬上限、对同一输入幂等;bash 长输出的 digest 与富态展示分别断言。
- [ ] AC-17:手动折叠后继续流式更新,block **不弹开**(回放录制事件流)。
- [ ] AC-18:edit block 的 `+N/-M` 与 diff hunk 由 core 给出;UI 侧 grep 不到 diff 计算逻辑。

**M5 输入**

- [ ] AC-19:`/` 与 `@` 的解析在 `core` 有单测;`tui` 侧不含解析逻辑(grep 断言)。
- [ ] AC-20:`Enter` 排队与 `Ctrl+Enter` cancel-and-send 行为分别可测,且 cancel-and-send 后草稿被消费、旧 turn 原子终止。

**M6 status line**

- [ ] AC-21:用量数字来自真相点——构造「上一次调用用量与当前 context 不同」的场景,断言 status line 显示当前值。
- [ ] AC-22:`cost < $0.005` 时字段隐藏;不可计算字段省略而非显示占位符(逐条断言)。
- [ ] AC-23:Component 里 grep 不到裸 ANSI 颜色码 / 十六进制色值(色槽表是唯一出处)。

### 3.3 测试计划分层

| 层 | 覆盖什么 | 跑在哪 |
|---|---|---|
| unit | `decide()` 决策链、`digest()`、diff 计算、解析器 | CI 每次 push |
| contract(属性测试) | 总线四不变量、abort 原子性、焦点契约 | CI 每次 push,fast-check ≥500 轮 |
| integration | headless 五 kind × 退出码;录制事件流回放渲染 | CI 每次 push |
| manual UX checklist | E3 三项、卡片焦点手感、滚动与复制、状态栏诚实性 | 里程碑收尾各一次,结论落 §7 |

**每个里程碑都要带一次反向验证**(人为注入 bug → 对应测试变红)。Phase 1 ⑦ 已证明这条值钱:只证明「测试绿」不等于证明「测试有效」。

---

## 4. 明确不做

写下是为了不手软(全部有去处):

- team / `@mention` 路由 / inbox / dashboard / peek panel → Phase 2.5(M5 的解析器是它的前置,但路由逻辑不在 Phase 2)
- plan mode / SKILL.md / `/rewind` / todo / compaction / 记忆层 → Phase 3(M1 只定 `plan_approval` 的形状)
- subagent / `requireDifferentFamily` / ACP 完整合规 / server 层 / web UI → Phase 4
- 主题外置配置文件、图片与富媒体渲染、性能优化 → 无期限,等真实需求
- 规则 DSL / predicate 语言 → 明确不做([design-rationale D](../design-rationale.md))

---

## 5. 大厂流程的采用与裁剪

参考的是流程**骨架**,不是流程**编制**。单人项目照搬多团队机制只会产出没人读的仪式文档。逐条落法:

| 大厂环节 | 本项目怎么做 | 裁剪掉什么、为什么 |
|---|---|---|
| Design doc + cross-team review | 本文件;重大取舍进 ADR([SOP.md](../SOP.md) 改动分级「大」) | 不开评审会、不做多方签字。operator 是唯一 reviewer |
| Entry criteria gate | §0 四条硬门禁,未过不许开工 | 不做立项审批 / 资源评审 |
| Milestone + DoD | §1 六个里程碑,每个的 DoD 是 §3.2 对应 AC 全绿 | 不做工时估算与 velocity——单人无排期博弈,估点是纯开销 |
| 小批次 + code review | 一里程碑一批 PR,PR 描述带 `Ran / Not run / Why / Risk` | 不做 CODEOWNERS / 强制双人 review |
| Feature flag + 灰度 | `ui.host` 开关;alt-screen 默认值到收尾才翻 | 不做百分比灰度 / 分环境发布——单用户本地工具,「灰度」就是开关 + dogfooding |
| Test plan 分层 | §3.3 四层 | 不做性能压测 / 负载测试(Phase 2 不验性能) |
| Bug bar + release criteria | §3.1:P0/P1 清零,P2 可带走 | 不做 SLA / 可用性指标 |
| Dogfooding / canary | 5 天真实使用不回退开关(延续 Phase 1 的方式) | 不做外部 beta——没有外部用户 |
| Observability | 事件流录制回放 + 结构化日志(录制样本同时是测试夹具) | 不接 APM / 遥测上报:本地工具,且不外传数据 |
| Rollback plan | §6 | 不做数据迁移回滚——无 schema 变更 |
| Post-mortem | [lessons.md](../lessons.md) LL-XXX 三门禁 | 已有机制,不另立流程 |

一句话总结裁剪原则:**保留能说「不」的环节(门禁、AC、CI、flag),裁掉只能说「记录在案」的环节(估点、签字、指标看板)。** 与 [design-rationale D](../design-rationale.md) 对 clowder predicate DSL 的判断同源——一条规则一个家,且选那个能说「不」的家。

---

## 6. Rollback 与批次纪律

- **每个里程碑独立可 revert**:一里程碑的改动不与其他里程碑混在同一 commit 范围;M1 单独合入且先合。
- **UI 侧有开关级回退**:`ui.host = "main"` 覆盖 M3 的全部风险面;M4/M5/M6 在两种宿主下都能跑,所以它们不依赖开关翻转。
- **permission 有降级路径**:`decide()` 出问题时的降级是 **deny-all + 提示**,不是 allow-all。降级方向必须是保守侧。
- **协议是唯一不可回退面**:M1 定的五个 kind 一旦合入,后续只许加字段不许改形状。这是把风险集中到一个批次的代价,也是它先做的理由。

---

## 7. 假设与风险

| 风险 | 缓解 |
|---|---|
| **request 总线形状写错 = Phase N 拆整条 permission 流水线** | 唯一「以后一定后悔」项([design-rationale C.4 ②](../design-rationale.md))。缓解:M1 先做、单独合入、五 kind 一次定全、四条不变量属性测试 + headless 双入口持续证明边界 |
| **OSC 52 未实测,alt-screen 可能拿走「复制」** | E3 是硬门禁;三条降级路径已排序(M3 tradeoff);最坏情况推迟切换,M4/M5/M6 不受影响 |
| Phase 2 与 Phase 2.5 并行导致 protocol 抢改 | 约定:Phase 2.5 不动 protocol 与 `FocusStack`;dashboard 依赖的二维分栏另有 Phase 0 遗留验证 |
| pi 无 `updatedInput`,rewrite 半边只能自持 | 已在 M2 设计里绕开(E4 复核);工具包装层本来就是自有代码([design-rationale A](../design-rationale.md)) |
| **范围膨胀**:grok 的设计有三个优先级,容易一路吃到底 | Phase 2 只吃第一 + 第二优先,第三优先里只取 Esc 分层(理由已写在 M3);其余进 §4 |
| Phase 1 的 issue 清单可能推翻本文档的排序 | E2 明说清单优先级高于预设排序;真实使用的证据 > 规划时的推测 |
| 里程碑 6 个,单人容易半途悬停 | 每个里程碑自带 DoD 与独立回退;允许 Phase 2 关闭时 M6 只完成用量真相点一条(其余降 P2) |

**假设**:pi 三包仍 pin 在 0.84.4;运行环境 WSL2;Phase 1 的 `pi-port.ts` 单点隔离仍成立(M2 挂 hook 不许在第二个文件 import pi)。

---

## 8. 实证记录

> 施工期间在此追加:E3 三项的实测结论、E4 的 grep 结果、各里程碑的反向验证证据、manual UX checklist 的逐次结论。格式照 [phase-1.md](./phase-1.md) §6——写可复现的观察,不写信心。
