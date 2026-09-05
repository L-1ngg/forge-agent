# 设计论证 — 综合分析与探测证据

> [plan.md](./plan.md) 的支撑材料。行动项不在这里。2026-09-05 起当前定位以 [ADR-008](decisions/008-general-agent-positioning.md) 为准:单 Agent 内核与 SDK、独立应用、派生定制并存;本文旧 Team 与阶段安排仅作历史论证。

---

## A. pi-agent-core 四层实读

> 本节基于 `pi-agent-core@0.84.4` 的 `.d.ts` / `dist` 实读(2026-08-31),不是文档推测。
> 采用方向已由 [ADR-009](decisions/009-self-owned-agent-core.md) 修订:当前使用自研 ExecutionCore 并保留 pi-ai。下文上游事实与旧采用判断保留为历史依据,不代表当前仍依赖 pi-agent-core。

`pi-agent-core` 不是「极简内核」,是四层,成熟度差一个量级。整包吞或整包拒都是错的。

| 层 | 内容 | 状态 | 判定 |
|---|---|---|---|
| **1** | `pi-ai`(独立包):9 种 wire 协议、6 家具名 OAuth(`anthropic` / `github-copilot` / `kimi-coding` / `openai-codex` / `openrouter` / `xai`)+ `radius`、事件归一化 | 成熟 | 永久依赖,永不自研 |
| **2** | `agentLoop()` / `agentLoopContinue()` / `runAgentLoop*()` / `Agent` 类 | 真实现 [^1] | Phase 1 用;Phase 3 可换 |
| **3** | `harness/` 积木:`tools/`(read 109 行 / bash 131 / edit 107)、`session/`(656K)、`compaction/`(569 行)、`skills.js`(322 行)、`system-prompt.js`(29 行) | 真实现,全部从 `index.d.ts` 再导出 | 按需单取,不整套吞 |
| **4** | `AgentHarness` 编排器 | ⚠️ **空壳** | 不碰 |

[^1]: Phase 0 已运行 `pi-coding-agent@0.84.4`,本轮又实读固定 commit 的启动与 extension 路径;它使用 `Agent`/loop 与 extension 机制,不经过 `AgentHarness`。详见 [research/pi.md](./research/pi.md) §3.6。

### 第 4 层是空壳的证据

`harness/agent-harness.js` 251 行:

```js
static async create(options) {
    const [record] = await options.session.findRecords({ limit: 1 });
    if (record !== undefined)
        throw new HarnessNotImplemented("create.restore");   // 连恢复已有会话都不行
    return { harness: new AgentHarness(options), suspended: [] };
}
unavailable(operation) {
    return Promise.reject(this.closed ? new HarnessClosed() : new HarnessNotImplemented(operation));
}
async prompt(_input, _images) { return this.unavailable("prompt"); }
```

`prompt` / `steer` / `abort` / `compact` / `lanes` / `watch` 等 22 个方法全部 `return this.unavailable(op)`;只有 `getLeafId()` 是真的;整个 npm 包内无第二处 import 它。

对比之下 `.d.ts` 有 461 行完整签名、14 个 tagged error 类,看起来比第 2 层成熟得多。**按文档完备度选层会正好选中唯一不能用的那层。**(→ E)

### 骨架泄露的 pi 方向

第 4 层虽是空壳,接口本身说明了 pi 要去哪:

- `AgentLane` / `createLane()` / `lanes()` —— 同 session 多 lane
- `RunOutcome` 的 `kind: "suspended"` 带 `DeferredHandle` —— **真检查点挂起**,不是协作式停止
- 11 个命名 hook 点:`before_run` / `before_resume` / `before_run_end` / `transform_context` / `before_request` / `before_payload` / `after_response` / `before_tool` / `after_tool` / `before_compaction` / `before_navigation`
- 第三个队列 `nextRun`(除 steer / followUp 之外)
- `HarnessTool` 加了 `replay?: "never" | "safe"`
- 默认值:`compaction = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`,`steeringMode` / `followUpMode` 默认 `"one-at-a-time"`

多 lane 会撞上 C.3 的 team 设计。→ E

### hook 能力的实测边界

| 需求 | pi 给了吗 | 落地位置 |
|---|---|---|
| 拦下工具调用 + 给理由 | ✅ `beforeToolCall → { block, reason, terminate }` | 直接用 |
| **改写工具入参** | ❌ 无 `updatedInput` | 自己的工具包装层 |
| 替换工具输出(脱敏) | ✅ `afterToolCall` 可换 `content` / `details` / `isError` / `usage` | 直接用 |
| turn 间换 model / context | ✅ `prepareNextTurn → { context, model, thinkingLevel }` | team 调度用 |
| 打断 / 排队 | ✅ `getSteeringMessages` / `getFollowUpMessages` + `QueueMode` | 键位映射 |
| context 装配单一入口 | ✅ `transformContext` | 直接用 |

改写入参这条要自己解决,但不阻塞:`packages/tools` 本来就自己写,在工具外包一层 decorator、进 `execute()` 前查策略引擎即可。pi 另给的 `AgentTool.prepareArguments?: (args) => Static<TParameters>` 在 schema 校验前跑,但拿不到 `context`,做不了策略判断,只适合兼容性修补。

结论:permission 流水线的 **deny 半边**挂 `beforeToolCall`,**rewrite 半边**归自己的工具包装层。

### 其他实读要点

- `agentLoopContinue()` 硬约束:**context 最后一条消息必须能经 `convertToLlm` 转成 `user` 或 `toolResult`**,否则供应商直接拒。pi 自己校验不了(`convertToLlm` 每轮只调一次)。写 team 调度时会撞上。
- 所有 hook 契约都写着 "must not throw or reject";`convertToLlm` 是必填。
- `ToolExecutionMode` 默认 `"parallel"`。
- `ThinkingLevel` 七值,含 `"off"`。
- `AgentEvent` 是 10 个变体(agent / turn / message / tool_execution 的生命周期),与 `pi-ai` 层归一化后的 12 个 **stream** 事件是两套东西。
- `CustomAgentMessages` 可用 declaration merging 扩展,但文档示例还写着旧包名 `@mariozechner/agent`。
- `exports` map 里有 `./session/testing` → `dist/harness/session/testing/`,写测试前先看。

---

## B. 借用矩阵

> 历史选型矩阵:下文「取用」指立项建议。当前只保留 pi-ai 模型适配,自有 TUI 与 ExecutionCore 分别由 ADR-005/009 落地;Team 边界按 ADR-008。实际包职责见 [README 架构](../README.md#架构)。

### 可复用性判定

| | 许可 | 能直接用代码吗 | 判定 |
|---|---|---|---|
| pi | MIT | ✅ npm 已发布多个包,v0.84.4,ESM + `.d.ts`;`exports` map 并非每个包都有(`pi-tui` 就没有) | 作为依赖库 |
| grok-build | Apache-2.0 | ⚠️ monorepo 单向导出,拒收外部贡献;Rust | 只借设计 |
| clowder-ai | MIT | ⚠️ 强耦合 API 进程 + Redis + web UI | 只借机制 |

pi 的 `pi-ai` / `pi-agent-core` / `pi-tui` / `pi-coding-agent` 各 43 个版本,同步发布 0.84.4。目录名与包名不一致:`packages/agent/` 的发布名是 `@earendil-works/pi-agent-core`。

**不要基于 `pi-coding-agent` 做扩展,要平级替换它。** 它本身是个 shell,而 pi 官方明确不做的清单——subagent、permission popup、plan mode、todo、background bash、MCP——几乎正好等于本项目要从 clowder 和 grok 拿的东西;寄生在它上面是持续对抗。但**可以照抄它的格式**(session JSONL v3 树形、config 分层路径、SKILL.md 标准):格式免费,代码自己写。

它的 `packages/coding-agent/examples/extensions/` 有 73 个示例,含 `subagent/`、`plan-mode/`、`permission-gate.ts`、`todo.ts`、`git-checkpoint.ts`、`sandbox/`,值得逐个读。

### 从 pi 取(代码 + 格式)

- `pi-ai`:供应商抽象、OAuth、`~/.pi/agent/models.json` 式自定义 provider。**`"!cmd"` 取密钥的设计直接抄**(`"!op read 'op://vault/item/credential'"`,`"$VAR"` 插值,否则字面量)
- `pi-agent-core`:分层取用,见 A
- `pi-tui`:差分渲染、alt-screen、overlay、`Editor`、自动补全
- 格式:
  - session JSONL —— `id` / `parentId` 树形(8-char hex),**原地分支不用新文件**
  - `AGENTS.md` 向上查找
  - SKILL.md 兼容 agentskills.io —— 免费复用已为 Claude Code 写的 skill
  - config 分层路径
- 纪律:「核心极简,其余是扩展」

### 从 grok 取(纯设计,按性价比排序)

**🥇 第一优先**

- **blocking card 一致性契约**:permission / cancel / question / elicitation 四种卡片共享同一套焦点规则——`Tab` 环绕不越界、`Esc` 只退一级并把焦点「停放」到 scrollback(卡片留屏可读)、shortcuts bar 永远显示当前真正收键的那张卡
- **排队与打断分两个键**:`Enter` = 排队,`Ctrl+Enter` = cancel-and-send。「它读起来就是『停下你在做的事,接这个』」
- **dashboard + peek panel**:选中一行,dispatch 框就地变 peek(上次响应类型 + 约 3 行 + 活的 `❯ reply`);model 与 always-approve badge 放 panel 下边框而非列表行。两个防误操作:dispatch 框永远只创建新 session;reply 非空时 `↑↓` 切 agent 不清草稿

**🥈 第二优先**

- **block 是一等公民**:每种类型独立配置(thinking 折叠 `truncated_lines=3`;edit block 是 inline diff 带 `+N/-M`;execute block 首尾裁剪 `first_lines=2/last_lines=3`);`respect_manual_folds` 解决流式更新与手动折叠的冲突
- **permission 提示的诚实性**:确认前就显示「究竟会记住什么」;危险清单(`rm` `chmod` `kill` `git push`)从不认记住的前缀;**当没有任何可记住的规则能阻止再次提示时,干脆不提供 Always allow 行**,而不是存一条不起作用的规则
- **status line 的诚实性**:`cost` 低于 $0.005 直接隐藏(避免误导的 `$0.00`);算不出的字段省略而非发占位符;运行计数只活在 status line 上,transcript 永不重述

**🥉 第三优先**

- `/rewind`:每个 user prompt 一个点,明说「不恢复磁盘文件」
- plan mode:只读,除 `plan.md`;plan 审批的行级评论 + `a/s/c/y/q` 五动作
- Esc 分层语义 + 800ms 双击 + 取消后约 1 秒抑制 rewind
- session 目录分工:`summary.json` / `updates.jsonl` / `chat_history.jsonl` / `plan.json` / `rewind_points.jsonl` / `signals.json`,ID 用 UUIDv7(可按时间排序)
- config 分层:行为(`config.toml`)与深度样式(`pager.toml`)分文件

### 从 clowder 取(机制,全部纯文件)

- **team 四机制** —— 见 C.3
- **skill 描述纪律**:`Use when: / Not for: / Output: / Side effects:`(无副作用写 `none (read-only)`)。这是模型选对 skill 的原因(它自己的 parser 只读 4 个字段,`manifest.yaml` 别抄)。`Side effects:` 是 cat-cafe 补的那一槽 —— description 写「分析财报」、正文顺手给 CEO 发邮件就是这么发生的(→ F.3)
  - 边界要写进 description,因为**正文可能根本没被加载**:description 写给路由,正文写给执行
  - 反例出现两次(description + 正文);每个 skill ≥2 正例 + 2 反例 + 1 灰例(可触发但要先问一个澄清问题)
  - 迭代顺序:先补反例 → 再补话术 → 最后才调 workflow
  - 合并有上限:合并后 description 若变成「什么都能做」就拆回去。**路由精度 > skill 数量**
- **pre-compact → 状态文件 → SessionStart 重注入**的六段载荷。两句抄进去,其中第一句已按 F.1 ③ 改写:
  - 「**任何授权必须连同它的对象一起被验证**」—— 原措辞是「除非在当前 context 里找到明确证据」,但 cat-cafe 的 F24 恰好是它的反例:摘要里「可以合入」是真的,只是它说的是另一个 PR。丢的是作用域,不是授权
  - 「压缩会削弱你对项目规则的遵守,现在重读 CLAUDE.md」
  - 载荷里**任何需要模型自述或判断的段落一律挪到读取时做** —— 90% context 的模型记不清早期细节(「濒死猫写不好遗书」)。确定性 digest 正是这个批判的规避方式
  - 用户**原始请求的原文**单独占一个 slot(→ F.1 ①)
- **身份放 system prompt slot,不放 transcript** —— 整个「抗压缩身份」故事就这一句,且免费
- **SQLite + FTS5 记忆**:单表 + `kind` 列(lesson / ADR / decision 不分表);FTS 只索引 `title/summary/keywords`,不索引正文;`bm25(fts, 5.0, 1.0, 2.0)` 加权;`superseded_by` 退役而非删除。三条来自 F.3:
  - **「何时写」是错问题,该问准入。**7 槽格式(坑 / 根因 / 触发条件 / 修复 / 防护 / 来源锚点 / 原理)+ 三门禁:≥1 个可追溯锚点(`commit:sha` | `file#Lx` | doc 链接)、「防护」必须是**可执行机制**(「be careful」不合格)、「原理」需有真实失败案例。写不出锚点和可执行防护的就不许写
  - `superseded_by` **默认查询就要排除**,不是「可以过滤」;另加活跃条目数的压力指标
  - `kind` 单表合规,但**属于「一组」的生命周期状态不要下沉到每一行**(→ F.3 的 ADR-011「蜘蛛网 2.0」)。`superseded_by` 是行级事实,以后想加 `status: active|obsolete` 就踩线
- **确定性 session digest**(`filesTouched` / `toolNames` / `errors` / 最近 N 条),LLM 摘要作 best-effort 第二个文件,不进关键路径
- **单一 cold-context assembler,两个入口**:压缩后恢复走的是「一次全新冷启动会收到什么」,不另开恢复路径。防恢复路径腐烂最便宜的手段

### 从 cat-cafe 取(工具设计规则,→ F.5)

历史 coding 场景下未采用 MCP;按 ADR-008,外部工具接入应按场景重新评估,本轮不实现 MCP,但那份研究报告里**与协议无关**的部分是纯收益,直接进 `packages/tools`:

- 能 `enum` 就别自由文本;能分类型就别混 `string`;`additionalProperties: false`;必填字段尽量少,但一旦必填就别留模糊空间
- 自测法:「把 schema 字段描述删掉只留类型,如果工具立刻变难用,说明描述本来就不够结构化」
- 错误返回统一含 `error_code`(稳定枚举)/ `message` / `field` / `expected` / `example` / `retryable`

> 「工具错误不是报错就完事,是模型下一次能不能改对的教材。」

---

## C. 子系统设计

### C.1 内核:pi 的生成器层 + 自持状态

> 历史代码按 [Phase 1 ④](./phases/phase-1.md) 使用 `Agent` 类并镜像事件到自有 session store。现已按 [ADR-009](decisions/009-self-owned-agent-core.md) 切换自研执行内核。下文生成器选择与“何时才自研”的门槛保留为被取代的历史论证;首版以保持已有能力为准,验证见 [施工图](phases/owned-core.md)。

采用 A 表的第 2 层,而且是生成器那一层。三个理由:

1. **最难写对、又最不差异化。** 流式重组必须按 `contentIndex` 归组(block 不保证连续到达)、abort 后 tool 的收尾、tool_call 与 text 交错、steering 插入时机、`StopReason` 六态——每条都是 bug 农场,写对了也换不来产品区分度。
2. **有逃生口,且已确认公开。** `index.d.ts` 里 `export * from "./agent-loop.ts"`,四个函数签名齐全。若 `Agent` 类的状态假设与 team 调度冲突,直接掉到 `agentLoop()` 自己排,不必 fork pi。这是敢押的主要原因。
3. **状态自持。** 走生成器层 + 自己的 session store,不让 `Agent` 替我拿着 messages。team 要 N 份独立状态,自持比借用便宜。

#### 什么时候才自研 loop

不是「以后有空」,是出现下面任一条:

| 触发条件 | 先试什么 |
|---|---|
| steering 语义表达不了 team 的打断 | 先试 `prepareNextTurn` 替换 context |
| 需要跨进程 / 跨天恢复一个进行中的 turn | 先看第 4 层是否已实现 |
| 只是缺 hook 点 | 先试 `transformContext`,几乎万能 |
| 以上都不行 | 才动手 |

**自研的正确时机是知道需求之后,不是之前。**

#### 一致性测试套件(Phase 1 就写)

四条不变量,**先跑在 pi 的实现上**,锁住行为契约。Phase 3 若要换成自研,是 drop-in 替换而非重写;同时消掉「用久了就不敢换」的惯性风险:

1. **abort 语义**——见下,配对性只是其中一条
2. steering 消息插入后消息序列仍合法(满足 `agentLoopContinue` 的末条消息约束)
3. 并行 tool 其中一个 throw,其余结果不丢、context 不破
4. `StopReason` 六态各自的后续动作

#### abort 写成纯函数状态机 + 属性测试(→ F.2)

原先这里只写了「每个 `toolCall` 都有配对 `toolResult`」。**配对性 ≠ 唯一性 / 顺序 / 终态吸收** —— 双写一个 `toolResult`、先 result 后 call、abort 后仍有新事件进来,三者都能通过配对检查。可借的形状来自 cat-cafe 的 F25(注意:F25 抽成纯函数的是 **InvocationRecord 生命周期**,63 行、5 状态、8 转换、2 终态,不是 abort 本身——借的是方法论:合法性检查收拢到单一规格文件 + fast-check 500 runs,他们的测试数 984 → 1327);我们把同一方法应用到 abort 语义,是我们自己的设计(→ F.2、F.9)。

要测的性质:

- 每个 `toolCall` 恰好一个 `toolResult`(在飞的调用合成结果),**且不早于它的 call**
- 终态吸收:进入 `aborted` 后任何输入都不改变状态
- **abort 必须按 turn 原子写** —— 留下半个 turn(`tool_use` 无 `tool_result`)供应商会直接拒。这一条与 `agentLoopContinue` 的末条消息约束是同一个约束的两面

#### 界限

**loop 之上的编排是自己的。** pi 没有 team 概念,`Agent` 就是一个 agent。「N 个 teammate、谁收到消息、谁被 review 挡住、任务板怎么变」这一层完全自写,pi 也不该管。

### C.2 TUI:pi-tui 原语 + grok 的 UX 概念

> 2026-09-04:operator 选择推翻本节「建在 pi-tui 上」的结论,见 [ADR-005](./decisions/005-tui-own-compositor.md)。下文保留为历史论证,不再作为施工约束。产品目标仍是 grok 的信息架构与交互;渲染底座改为自有 `TerminalFrame` compositor。

`pi-tui` 里没有 UX,只有渲染原语。它给的全部东西:

```ts
interface Component {
  render(width: number): string[]    // 返回若干行,超宽直接报错
  handleInput?(data: string): void   // 只有 focused 时收到,是原始字节
  invalidate?(): void
}
```

外加差分渲染器(只重画变化的行 + `\x1b[?2026h` 同步输出防闪)、`TuiMainScreen`(保留 scrollback)/ `TuiAltScreen`(全屏 viewport)两种宿主、容器、overlay(9 锚点)、`ScrollView`、`Editor`、`CombinedAutocompleteProvider`。

它不知道什么是 tool block、什么是 permission card、Esc 该退到哪。这些全是 grok 的设计,也全是要写的 Component。

| grok 的设计 | 落地成什么 |
|---|---|
| block 是一等公民 + 每类型独立折叠配置 | `ThinkingBlock` / `EditBlock` / `ExecuteBlock` 各一个 Component,`render()` 里实现 `truncated_lines`、`first_lines/last_lines` |
| blocking card 焦点契约 | `FocusStack`:Tab 在栈顶卡片内环绕不越界,Esc 只 pop 一层,pop 后卡片留在 scrollback 可读 |
| shortcuts bar 永远显示真正收键的那张卡 | bar 从 `FocusStack.top()` 取,而非各卡自己上报 |
| 四种渲染模式热切 | `TuiMainScreen` ↔ `TuiAltScreen` 换宿主,Component 树不变——pi 把两者接口做成一样,正好为此 |
| 语义色槽 `accent_thinking` / `accent_plan` | 一张 theme 表,Component 只查槽名不写颜色 |
| Enter 排队 / Ctrl+Enter 打断 | pi 底层已有 steer / followUp 两个队列,只做键位→队列的映射 |

#### 已验证的布局约束与剩余验收

`pi-tui` 是**行导向**的(`render → string[]`),ratatui 是**单元格导向**的(切 Rect 画二维)。

grok 大部分设计天然行导向——block、card 都是流式往下堆,直接对得上。dashboard 的「左列表 + 右 peek panel」是真二维分栏,但它的**基础表达能力已经核实**:`pi-tui@0.84.4` 有 `HStack`/`VStack` 的 flex 约束与 `ScrollView`;上游测试覆盖两个并排 scroll view 的独立 pointer 命中;本机 WSL2 的 40 列 `HStack` 探针也同时渲染了左右区域。源码与探针见 [research/pi.md](./research/pi.md) §3.4、[research/peer-agent-team-tui.md](./research/peer-agent-team-tui.md) §3.2。

尚未验收的是完整 dashboard 在真实 WSL2/tmux 中的多滚动区焦点、滚轮、resize、OSC 52、truecolor 与持续 streaming 交互。响应式退路仍保留:中宽度把 peek 放到列表下方,窄屏改成单 pane drill-in,不把两栏硬压在一起。

### C.3 Team:clowder 的语义,文件的实现

> 历史方案:内置 Team 方向由 ADR-008 取代。下文不再是本项目行动项,也不约束外部 multi-agent 项目的部署与实现;单 Agent 实例隔离仍需 SDK 验证。

#### subagent ≠ teammate

| | subagent(pi / Claude Code 模型) | teammate(clowder 模型) |
|---|---|---|
| 生命周期 | 一次调用,用完即弃 | 长期存在,跨天跨会话 |
| context | 全新隔离,返回一条摘要 | 自己的历史,持续累积 |
| 身份 | 无,就是个工具调用 | 有名字、角色、偏好模型 |
| 寻址 | 父 agent 调用它 | `@name` 主动喊,也能互相喊 |
| 状态 | 无 | 共享任务板上有 owner 列 |

本项目要第二种。而「team 这个概念」与「clowder 实现它用的 Redis / A2A / Hub」可以完全分开——协作要的东西全部能用文件做。

#### 最小实现

```
.harness/team/<name>/
  IDENTITY.md          # 塞进 system prompt slot(不进 transcript,所以压缩不掉)
  config.toml          # 偏好模型、工具白名单、reasoning 级别
  session.jsonl        # 自己的历史,pi 的树形格式
  inbox/*.json         # 收件箱
.harness/board.jsonl   # 共享任务板
```

四个机制,全部来自 clowder:

1. **`@mention` 行首路由** —— 打 `@reviewer 看下这个 diff`,消息投进那个 teammate 的 inbox;teammate 之间也走同一条路。**路由逻辑归 `core`**,不能在 TUI 里,否则以后 web UI 要重实现。源码事实修正:固定 commit 的 Clowder 还支持显式 `targetCats`,所以“唯一通信原语”的旧表述不成立;本项目是否采用 structured target first 仍待 Phase 2.5 ADR/operator 定案,见 [research/clowder-ai.md](./research/clowder-ai.md) §4。
2. **`rename()` 抢锁** —— 收件箱取信用原子 rename 拿租约。同文件系统下这是真原子操作,不需要 Redis 的 Lua CAS。clowder 自己的 file outbox 才是可保留的那部分。
3. **task board 的 `TaskItem` 形状** —— `{ id, title, why, owner, status: todo|doing|blocked|done, subjectKey }`。`subjectKey` 是去重键(同一件事别开两张卡),`why` 强制写动机。类型定义直接搬,只是存 JSONL 而非 Redis。
4. **`requireDifferentFamily`** —— 「评审者不能是作者」两行配置就成立,两个模型也能跑。(⚠️ 名字是本项目起的;概念证据在 cat-cafe 12 课「review 必须跨家族」+ F088 三个 P1,→ F.2、F.9)

#### 运行方式:in-process

一个进程里 N 个 `Agent` 实例,靠 async 并发。clowder 每个 agent 是独立 CLI 进程,因为它有 API server + web UI 要伺候;这里只有一个 TUI。

dashboard 因此白拿——它监督的不是远端进程,就是内存里那几个对象。真需要隔离(teammate 跑在 sandbox 里)再降级成 subprocess,单独处理。

这是三者的融合点:clowder 的 team 语义 + grok 的 dashboard/peek panel 作为它的界面 + pi 的 `Agent` 作为每个 teammate 的引擎。

**in-process 是他们的终态,不是妥协** `[明述]`:「Cat Café 是单进程,不需要跨进程通信。」但它**交出了 OS 隔离**——共享可变基底从「不同进程」变成 `process.cwd()` / `process.env` / 退出码 / 信号处理器 / 模块单例 / Bun module cache。对策:工具一律取**显式 cwd**(不读 `process.cwd()`),env 走 per-agent context,不设模块级可变单例。同时丢掉了「一个 teammate 崩了不影响别人」,而他们的事故证明这条靠纪律守不住。→ E

#### 终止与调度(C.3 原先缺的那半边,→ F.2)

**① 单一执行入口(P0)。** `inbox/*.json` 与 `@mention` 解析必须不是两个执行入口——那正好重建他们的 Path A / Path B 事故。**mention 解析的唯一输出是「写 inbox + 入队」,消费者只有一个。**(他们 F27 的修法:回调只 `enqueueA2ATargets()` 进父 worklist。)

**② 三个硬上限** `[明述]`(数值已核实,→ F.9):

- 深度 `MAX_A2A_DEPTH=15` —— 失控时的自动兜底硬停(不是唯一硬停:人工 Stop 走 AbortController 是另一条路,职责不同)
- fan-out ≤2,且串行
- 入队去重 + 「目标已被父调用覆盖」短路

`TaskItem.subjectKey` 与这三条**正交,不能替代**它们。

**③ 故意不做的三样**(自有决策,原稿误标 `[明述]`,源文档无此声明 → F.9):无环检测、无限速、无收敛检测 —— 因为 A↔B 交替本身是合法的 review 循环,而 depth cap + 入队去重已兜底失控。

**④ ping-pong 与断链是同一根因的两极。** 码上限和 prompt 引导必须同时修:光有上限会断链,光有 prompt 会 ping-pong。他们的实际教训是一个三重否定的自检门 + 一份「2 条正面 vs 8 行抑制」的失衡 prompt。

**⑤ 「能否停止」不能由「是否在流式输出」推导** —— 要一个独立的 `hasActiveInvocation`。

**⑥ 人 / agent 输入不对称** `[明述]`:agent 输出用严格行首匹配,人类输入用宽松 `indexOf`;两者都先剥掉代码块。

**⑦ inbox 背压他们没解** `[空白]` —— 自己想,别指望有先例。

### C.4 协议边界与未来演进

> 当前状态(2026-09-06):自研内核与宿主可装配的 SDK 已提交,CLI 消费同一接入层,见 [SDK 指南](sdk.md)。协议隔离继续有效,服务 API 后续另定;下文是早期设计论证,不代表已实现或冻结的传输方案。

立项时的出发点:先交付 CLI/TUI,保留向 web UI / 客户端演进的边界。

因此**现在只做一件事**:让 `core` 完全不知道 UI 存在,让 UI 只消费一条事件流。成本几乎为零,以后补则是重写。**除此之外所有为 web 做的准备一律不做。**

理由:任何试图同时满足两端的 UI 抽象,一定是照着终端的形状捏出来的,web 上去只会打架。正确做法不是共享 UI 代码,是共享协议,两端各自原生渲染。

三个项目都印证这条路:grok 的 `updates.jsonl` 明确标注是 "ACP session update stream — **authoritative log**",TUI 只是消费者之一(它已有 `headless` 模式);pi 有独立的 `packages/{client,server,protocol}`;clowder 是反例——一上来就 server + web UI,代价是 Redis、daemon、一个没有存储层的 Mission Hub。

#### 现在就要做的三件事

**① `protocol` 包 + 单向依赖 + CI 检查** —— 当前结构见 [README 架构](../README.md#架构)。

**② 阻塞式交互必须是带 id 的 request/response —— 最高风险项**

permission card、cancel 确认、plan 审批、question 卡片、**OAuth 登录**,若写成「core 直接调 `ui.confirm()` 拿 Promise」,web UI 永远接不上。必须是:

```
core → { type: 'request',  id: 'r7', kind: 'permission', payload: {...} }
UI   → { type: 'response', id: 'r7', result: { decision: 'allow_always', scope: ... } }
```

pi 的 `ctx.ui.confirm()` 就是前一种形态。所以要在 `core` 里自己做一层 request 总线,pi 的 hook 只是触发点。

OAuth 是最容易漏的第五种:`pi-ai` 用 `http.createServer` 起本地回调端口等浏览器跳转,同样是阻塞式交互,不能让 `core` 直接往 stdout 打一行「请打开这个 URL」。

> ⚠️ **这一条 Phase 2 写错,Phase N 就是把整个 permission 流水线拆一遍。** 唯一「现在不做、以后一定后悔」的项。

**③ `--json` headless 从 Phase 1 就存在**

不是为了以后,是为了现在就能持续证明边界没腐烂。与 clowder 那条「单一 cold-context assembler,两个入口」同理:第二条路必须一直有人走,否则它一定烂。headless 跑得通就说明 core 里没有 UI 泄漏。顺手还给出脚本化能力。

#### 切分线:core 给数据,UI 给像素

这条线画错,web UI 就得把 TUI 的渲染逻辑重写一遍。

| core 输出(进协议) | UI 各自负责 |
|---|---|
| diff hunk 结构(`+N/-M`、行号、内容) | 渲染成 ANSI inline diff / HTML `<ins>` |
| markdown **源文本** + block 元数据 | 渲染成 ANSI / DOM |
| `{ lang, code }` | 语法高亮(syntect / Shiki) |
| block 类型 + 折叠状态 + `truncated_lines` 配置 | 怎么画折叠指示器 |
| 语义色槽名(`accent_thinking`) | 映射成 ANSI 色 / CSS 变量 |
| slash command 与 `@mention` 的**解析结果** | 自动补全的交互 UI |

grok 的语义色槽在这里是隐藏价值:`accent_thinking` 能直接对到 CSS 变量,而「第 3 行第 5 列用蓝色」这种元素式主题不能。

**反方向也要切一次** `[明述]`:上表管「同一份数据怎么显示」,但还有一类数据是**给人看的富态、给模型看的摘要**——两者不该是同一个串。cat-cafe 的 `digestRichBlocks()` 是这个思路,它同样适用于 `board.jsonl`、inbox、review 列表:TUI 里 task board 可以带颜色、图标、时间轴,进模型 context 时是压过的一行。落法是给这类结构配一个 `digest()`,协议里两个字段分开走,**别让「UI 好看」把 context 撑爆**。→ F.2

#### 协议形状:借 ACP 的形状,不追求合规

形状借来了,以后要真接 ACP 是机械映射而非重构。ACP 真做完的额外收益是 Zed 之类的编辑器能直接当客户端,近期就能兑现。但 ACP 完整规范未核实,现在追合规会拖慢 Phase 1。

**Phase 1 定形状;ACP 合规是独立的、可选的后续项。**

#### 演进路径

```
今天:  cli 进程 = core + tui,事件走内存 bus
以后:  core 包一层 server(Unix socket / WebSocket,JSON lines)
       TUI 变成同一协议的远程客户端(它本来就只认协议)
       web UI 是第二个客户端
```

TUI 那一步的改动量是把 bus 的实现从函数调用换成 socket,协议层和 Component 全不用动。

因为是 TypeScript,web UI 和桌面客户端基本是同一个目标(Tauri / Electron 就是给 web UI 套壳),不用当两件事规划。

---

## D. 明确不做

本节记录立项时的排除项。SDK 已交付,服务 API 与通用扩展按 [plan.md](plan.md) 单独设计;下文针对单人 CLI 的「永远不需要」不能约束外部宿主或后续已批准方向。

### 来自 clowder

- **SOP YAML predicate DSL** —— 它的 predicate 是**建议性**的:trace 由 agent 自述、仓库里零个 `PreToolUse`、`pnpm gate` 根本不读 SOP catalog;真正的强制力在一个 21KB 的 `.githooks/pre-commit` 里(约 20 个 `exit 1`)。同一条规则被表达三次而没有任何东西保持同步。
  > **教训:一条规则一个家,且选那个能说「不」的家。**

  这条现在有对方阵营的施工记录作证,不只是我方推理(→ F.6):他们的 `03-meta-rules.md` 声称 Skill 提供「强制执行」`[明述]`,而 `09` 的三层防御表自己写着「全是文字指令,无强制执行」/「完全空白」`[自证]`;期间发生过两次真实未授权合入(F11 自判改对了就合、F24 压缩后误读授权——注意 F11 时间上先于 merge-approval-gate 的建立,「gate 在场仍失守」的说法已被审核证伪,过硬的证据是 09 的自证,→ F.9)。事后补的是三层 hooks——**说「不」的家在 hook 里,不在 prompt 里。**

  **但他们有一处比这份规划好,值得单独拿走**:`03` 把「放行」写成了**可机检的输出契约**而非模糊规则——有效放行白名单(`可以放行了` / `LGTM` / `通过`)、显式无效形式(`整体 OK,但 XXX 需要改` 这类条件放行不算)、一份「禁止表演性同意」的词面黑名单(`You're absolutely right!` / `Great point!` / `Thanks for catching that!`)、P1/P2/P3 分级 + 「P1/P2 修完才能放行」。这些二十行 hook 就能执行,而 clowder 的 predicate 不能。
  > **借契约的形状,不借它的住处。**
- A2A 消息总线、Redis、daemon、web UI、Mission Hub —— 单人单写者,Lua CAS 防的并发不存在
- skill mount / sync 机制 —— 直接写在 harness 会读的地方就行(且它的 sync hash 是「排序后名字的 SHA-256」,**检测不到 SKILL.md 内容修改**)
- embedding 检索 —— 直到 lexical 被证明不够用;clowder 自己的默认模式就是 lexical(`EMBED_MODE=off/shadow/on` + fail-open),且 embedding 要单独的 Python 服务
  - 补强来自 F.4,但**不是「embedding 不必要」的证据**(他们语料仅 707 文档、检索单位是整篇文档、从没压测过)。可用的是他们对 recall 失败的诊断:三条里没有一条是排序问题,真问题是**没生命周期**——文档只增不减,信噪比持续下降到没人看(`docs/discussions/` 30 个讨论 25 个已收敛,信噪比 17%)
  - 所以先做的是**策展,不是排序**:按月归档,「归档 ≠ 删除,历史有价值,但它不该出现在你日常浏览的活跃目录里」。这与记忆层的 `superseded_by` 默认排除是同一条思路的两个层级

### 为 web UI 提前做的

任何跨端 UI 抽象层 / renderer 接口 / 组件复用 · server 进程 / WebSocket / HTTP API · 认证 / 多用户 / 多租户(单人本地工具,永远不需要)· 前端框架选型 · ACP 完整合规

### 自己重写别人的

- 供应商 wire 协议(`pi-ai` 那一层)
- TUI 差分渲染器
  - 2026-09-04 例外:[ADR-005](./decisions/005-tui-own-compositor.md) 决定本仓库自写 `packages/tui` 的 cell compositor(含差分 paint)。本条其余含义不变:不重写 `pi-ai`,不把 compositor 做成可复用框架。
- Rust 重写
- **`AgentHarness` 那一层的编排器接口** —— 不实现别人的空壳;自己的编排照自己的形状写

> agent loop 的旧延后判断已由 [ADR-009](decisions/009-self-owned-agent-core.md) 取代,自研 ExecutionCore 的实现与验证见 [owned-core.md](phases/owned-core.md)。

---

## E. 风险与未核实项

> 以下为立项时风险清单,上游版本、旧 Phase 2.5 与 pi-tui 相关项不代表当前待办。当前内核/SDK 未测项分别见 [owned-core.md](phases/owned-core.md) 与 [sdk.md](phases/sdk.md);长期任务与通用能力评估见 [plan.md](plan.md)。

| 风险 | 处置 |
|---|---|
| **完整 dashboard 的真实终端交互未验收** | 二维基础能力已由源码、上游测试与本机 WSL2 探针确认;Phase 2.5 仍需验多滚动区焦点/滚轮、resize、tmux、OSC 52、truecolor 与 streaming 稳定性(C.2) |
| `pi-tui` 在 Linux/WSL2 的加载风险 | `0.84.4` Linux 发布物无 Linux native `.node`;本机实际 ESM import 与 `HStack` render 已通过。风险已从“能否加载”收敛为上一行的真实终端行为 |
| **request/response 边界写错的代价** | Phase 2 必须一次做对;本规划唯一「以后一定后悔」项(C.4 ②) |
| **`pi-agent-core` 已发布的接口不等于已实现** | `AgentHarness` 251 行全是 `HarnessNotImplemented`(A)。**纪律:用 pi 任何一层之前先 grep `dist/` 里的 `NotImplemented` / `unavailable`,不信 `.d.ts`。** 这次差点押错 |
| **pi 正在往多 lane + 可挂起走,可能与自建 team 撞车** | 观察项非阻塞项。team 照 C.3 自己实现;`AgentLane` / `DeferredHandle` 一旦落地则评估 rebase。代价可控的前提是 **team 的调度逻辑不渗进 `packages/tui`** |
| pi 处于 v0.84.x,12 个月 43 个版本,churn 大 | 全部 exact pin;`pi-tui` 没有 `exports` map,深引用不受约束,必要时 vendor |
| pi 文档要求去读 `node_modules/*/dist/` 的类型 | 接受;`core` 里包窄接口隔离 |
| pi 无内置权限系统,扩展全权运行(以启动用户身份) | 自己实现 permission 流水线(Phase 2);隔离靠 Gondolin / Docker,不靠 pi |
| **in-process 交出了 OS 隔离** —— 共享可变基底变成 `process.cwd()` / `process.env` / 退出码 / 信号处理器 / 模块单例 / Bun module cache(C.3) | 工具一律取显式 cwd、env 走 per-agent context、不设模块级可变单例。**这三条要在 Phase 2.5 第一行代码之前定,不是事后收拾** —— cat-cafe 的 HOME 隔离方案 6 个 commit 全部回退,而根因修复只有两行。真需要 OS 隔离再降级成 subprocess |
| **压缩恢复机制可能一次也跑不起来** | 阈值留余量(0.80 / 0.88),且用量在真相点算。cat-cafe 的 seal 阈值 0.90 贴着 CLI 自动压缩的 ~0.95,「布偶猫从未成功在 CLI 压缩前完成交接」`[明述]`。本项目自己拥有压缩调用点,这一条比他们容易,但**必须留余量**(→ F.1 ②) |
| **多轮 review 的错误是关联的,加轮数不能修方向偏差** | `requireDifferentFamily` + 原始需求原文进 slot。cat-cafe 的 F041 是 12 AC 全绿 / 76 测试 / 14 轮 review 合入 main,用户 5 秒发现四个问题——全链路没人回去读原始需求 `[明述]`(→ F.1 ①) |
| **记忆库会退化成没人看的目录** | 写入准入三门禁 + 默认排除 `superseded_by` + 活跃条目数压力指标。cat-cafe 的诊断是「没生命周期 → 信噪比 17%」,不是排序不好(→ F.4) |
| 单维护者主导(badlogic 3540 commits) | MIT + 已发布 npm 包 = 最坏情况可 fork |
| pi 的 99.5k star 与 138 open issues / 319 watchers 不成比例 | 调研明确标注「未验证是否自然增长」。不影响技术判断,但别拿 star 数当质量证据 |

### 未核实项清单

- 完整 dashboard 在 WSL2/tmux 的多滚动区焦点/滚轮、resize、OSC 52、truecolor 与 streaming 稳定性
- **第 3 层积木是否适合本项目** —— 已确认 session/tools/compaction 等有真实实现,但仍坚持单件引入前逐个审查,不按目录批量采用
- **`./session/testing` 导出里有什么** —— 写一致性测试套件前先看,可能有现成夹具
- `@earendil-works/pi-session-backend-sqlite-node` 是否已发布
- ACP 完整规范
