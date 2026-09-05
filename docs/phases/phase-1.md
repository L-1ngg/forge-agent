---
doc_kind: plan
created: 2026-08-31
---

# Phase 1 实现方案 — 每天能用

> 状态:已完成(2026-09-01,operator 将未执行的人工验收暂缓并按豁免处理,不代表实测通过)。本文保留 Phase 1 历史施工与测试记录;后续内核、SDK 与输入边界分别见 [ADR-009](../decisions/009-self-owned-agent-core.md)、[SDK 施工图](sdk.md)、[ADR-010](../decisions/010-input-ownership-and-interruption.md)。
> 本文档是 Phase 1 的唯一施工图:每个工作项带**路径**(要创建的文件)、**tradeoff**(选了什么、放弃了什么)、**验收**(可验证的检查)。plan.md 只保留行动项,细节以本文为准。

---

## 一句话说完

Phase 1 做了一个能在终端里跟 AI 对话写代码的工具（`myh`）。

你在终端打开它，输入一句话（比如"帮我读一下这个文件"、"改一下这行代码"、"跑个测试"），它会调 AI 模型理解你的意思，然后自动帮你读文件、写文件、改文件、执行命令。AI 的回复一边生成一边显示，不用等全部想完。

- **打断和排队**：AI 正在回复时按 Esc 打断，之前打的字不会丢；也可以在它没说完时直接输入下一条消息排队。
- **对话记录**：每次对话存下来，下次打开能接着聊，也能搜之前说过什么。对话是树形的，可以从中间分叉出新的对话线。
- **配置灵活**：支持换不同的 AI 供应商和模型，密钥可以从环境变量或密码管理器里取，不用明文写在配置里。
- **两种用法**：交互模式（终端一问一答）和脚本模式（`myh -p "你的问题" --json`，输出结构化结果）。
- **工程底子**：代码分五个模块，依赖方向有自动检查防止写乱。AI 引擎被隔离在一个文件里，以后换引擎只改一处。32 个测试全部通过，CI 配好了推代码自动跑检查。

---

## 0. 前置门禁:Phase 0 出口标准

Phase 1 开工前必须全部为 ✅(对应 plan.md Phase 0):

| 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|
| 三包 exact pin 可安装 | `bun add` 后 30 行 demo 跑通一次流式对话 | 版本降到最近可用版,记录 pin 理由 |
| `pi-tui` native binding 在本机(WSL2)加载 | demo 里 `TuiMainScreen` 渲染无异常 | 走 Plan B:只用 `pi-ai`,TUI 自写 |
| alt-screen 下鼠标滚轮 / OSC 52 / truecolor | 手动目测通过 | 记录缺陷,Phase 2 再评估影响 |
| 读 `packages/{client,server,protocol}` + `pi-coding-agent` 的 `examples/extensions/` | 在本文档 §7 留下三行以内笔记 | 无 |

**注意:Phase 1 不依赖 Phase 0 的头号风险项**(pi-tui 二维分栏)。那是 Phase 2.5 dashboard 的前置;Phase 1 用 `TuiMainScreen` 纵向流式渲染,天然行导向。二维分栏的验证可以和 Phase 1 并行,不阻塞。

**开工第一件事:`git init`。**

---

## 1. 构建顺序与依赖

```
① 脚手架(ws + pin + CI 依赖检查)
   └─→ ② protocol(零依赖,先定形状)
          └─→ ③ tools(只依赖 protocol)
                 └─→ ④ core(依赖 protocol + tools + pi)
                        ├─→ ⑤ tui(依赖 protocol + pi-tui)
                        └─→ ⑥ cli(唯一接线处,依赖全部)
⑦ 一致性测试套件(依赖 ④,跑在 pi 的实现上)
```

② 必须最先定稿,③④⑤ 可并行,⑥ 最后接线,⑦ 与 ④ 同期开始写(先写测试锁契约,再让实现满足它)。

全部路径基于 Bun workspaces  monorepo:

```
my-coding-harness/
├── package.json                 # workspaces + 全局脚本
├── tsconfig.base.json
├── packages/
│   ├── protocol/                # 零依赖
│   ├── core/
│   ├── tools/
│   ├── tui/
│   └── cli/
├── scripts/
│   └── check-deps.ts            # 依赖方向 CI 检查
└── tests/
    └── loop-contract/           # 一致性测试套件
```

---

## 2. 工作项

### ① 脚手架与依赖方向检查

**路径**:`package.json`、`tsconfig.base.json`、`scripts/check-deps.ts`、`.github/workflows/ci.yml`(或本地 `pre-push`,二选一)

**内容**:
- Bun workspaces 挂载五个包;pi 三包(`@earendil-works/pi-ai` / `pi-agent-core` / `pi-tui`)**exact pin**,不用 `^`。
- `check-deps.ts`:扫描各包 `package.json` 依赖表 + `import` 语句,强制 plan.md §1 的三条铁律——`core` 不出现 `tui`;`tui` 只 import `protocol` 与 `pi-tui`;`tools` 不 import `core`。

**Tradeoff**:自写 30 行检查脚本,**放弃** dependency-cruiser。理由:规则只有三条、方向图只有五个节点,引入一个工具链来执行三条 grep 是过度工程;规则变复杂时再换,脚本留着做对照。风险:自写脚本对 `import type` / 动态 import 的覆盖要当场验证(用一例故意违规的提交测试 CI 会变红)。

**验收**:CI 跑一次全绿;手工在 `core/package.json` 加一行 `tui` 依赖 → CI 变红 →  revert。

### ② protocol 包

**路径**:`packages/protocol/src/events.ts`、`requests.ts`、`index.ts`

**内容**:
- `SessionEvent` union:覆盖流式(message start/delta/end,带 `contentIndex`)、tool_execution(start/end)、turn、agent 生命周期。形状借 ACP,字段名向 ACP 靠,不追求合规。
- `RequestEnvelope` / `ResponseEnvelope` 类型(`{ type: 'request', id, kind, payload }` / `{ type: 'response', id, result }`)。**Phase 1 只定类型,不实现总线**——permission 等真实使用者 Phase 2 才进来,但形状现在定死,避免 Phase 2 改协议。
- 零依赖,纯类型 + 窄的构造函数。

**Tradeoff**:借 ACP 形状**放弃**完全自定义。理由:design-rationale C.4——以后真接 ACP 是机械映射而非重构;代价是现在要忍受少量用不上的字段。边界:ACP 未核实的部分一律不猜,只定我们用到的子集。

**验收**:`bun run --filter protocol build`(或 `tsc --noEmit`)通过;`core` 与 `tui` 各能只凭 `protocol` 类型完成一次事件收发(编译期检查,不写 mock 实现)。

### ③ tools 包

**路径**:`packages/tools/src/{read,write,edit,bash}.ts`、`errors.ts`、`index.ts`

**内容**:4 个工具,纪律来自 cat-cafe F.5(已审,锚点 `res:knowledge-engineering-skills-mcp.md:300-321`):
- 入参 schema:能 `enum` 不用自由文本、`additionalProperties: false`、必填字段最小化但必填即无歧义。
- 错误统一形状:`{ error_code(稳定枚举), message, field, expected, example, retryable }`。
- 自测法:删掉 schema 字段描述只留类型,工具应变难用——变难用说明描述本来就不够结构化(留给模型自己判断的部分过多)。

**Tradeoff**:**自己写,放弃**直接依赖 pi 第 3 层积木(`harness/tools/`,read 109 行 / bash 131 / edit 107)。理由:(a) 错误形状纪律是我们的差异化要求,pi 的不长这样;(b) 工具包装层是 permission「rewrite 半边」的家(design-rationale A),这层必须自己持有;(c) pi 的积木作为**参考实现**读,错误分支比我们的要求粗。代价:约 400 行自有代码 + pi 升级时没有免费的修复。缓解:四个工具的语义面很窄,维护量可控。

pi 接缝说明:工具以 pi `AgentTool` 形状暴露给 loop(`prepareArguments` 只做兼容性修补,策略判断留给 Phase 2 的包装层)。

**验收**:
- 每个工具:happy path 单测 + 至少 3 个结构化错误用例(断言 `error_code` 枚举值与 `retryable` 正确)。
- `bash` 工具有超时与输出截断(首 2 行 / 末 3 行的裁剪策略可以 Phase 2 再做,Phase 1 只做硬截断 + 字节上限,记录为已知粗糙点)。
- 用 schema 自测法人工过一遍四个工具,结论写进 PR 描述。

### ④ core 包

**路径**:`packages/core/src/{agent-runner.ts, pi-port.ts, session-store.ts, session-search.ts, config.ts, index.ts}`

**内容**:
- `pi-port.ts`:**窄接口隔离层**(几十行)。pi 的类型不出这个文件;对内只暴露 `runTurn(input) → AsyncIterable<SessionEvent>`、`steer()`、`followUp()`、`abort()`。pi 的 breaking change 只砸这一个文件。
- `agent-runner.ts`:编排一次 turn——驱动 pi loop、把事件转成 protocol 的 `SessionEvent`、写 session store。
- `session-store.ts`:JSONL 树形持久化,**格式照抄 pi session v3**(`id` / `parentId`,8-char hex,原地分支不开新文件)。格式免费,代码自己写。
- `session-search.ts`:本地检索(cat-cafe F.1 ⑤):`search(query) → 命中 entry id 列表`,`readEntry(id) → 只读那一处`。grep 式扫描,不建索引。
- `config.ts`:分层路径 + `"!cmd"` 取密钥设计直接抄 pi(`"!op read 'op://vault/item/credential'"`、`"$VAR"` 插值)。

**Tradeoff 1(重要,对 plan 的收窄决策)**:plan.md §1 的接缝画的是 `new Agent(...)`,design-rationale C.1 的文字写的是「生成器层 + 状态自持」。Phase 1 决策:**先用 `Agent` 类**(接缝简单,steering/队列白拿),**状态通过事件订阅镜像到自己的 session store**,不让 `Agent` 的内存状态成为权威。这与 C.1 不矛盾:C.1 的要点是「状态自持 + 有逃生口」,`Agent` 类当引擎用、事件流当事实源,两条都满足。掉到 `agentLoop()` 自己排的真正时点是 Phase 2.5(team 要 N 份独立状态、调度假设可能冲突),届时 ⑦ 的一致性测试套件保证 drop-in 替换。**放弃**的是 C.1 字面意义上的「第一天就走生成器层」——理由是 Phase 1 只有一个 agent,`Agent` 的状态假设尚未构成冲突,提前掉层是纯成本。

**Tradeoff 2**:`session-search` 用线性扫描 JSONL,**放弃**建索引。理由:Phase 1 单 session 量级(千行级),grep 式扫描足够;FTS5 是 Phase 3 记忆层的事,提前建索引是投机。触发重估的条件:单文件 >1MB 且搜索可感知变慢。

**验收**:
- 一次完整 turn 后,session JSONL 里每个 entry 有合法 `id`/`parentId`;人为构造分支(从中间 entry 续跑)后树结构正确。
- `session-search` 对一个 1000 行 JSONL 的查询 <100ms。
- `pi-port.ts` 是唯一直接 import pi 的文件(grep 验证)。
- config 里 `"!cmd echo test-secret"` 能正确解析出 `test-secret`。

### ⑤ tui 包

**路径**:`packages/tui/src/{app.ts, stream-renderer.ts, editor.ts, index.ts}`

**内容**:
- 宿主用 `TuiMainScreen`(保留 scrollback),**不切 alt-screen**(Phase 2)。
- `stream-renderer.ts`:流式渲染**按 `contentIndex` 归组**——block 不保证连续到达,这是 design-rationale C.1 点名的 bug 农场,Phase 1 就必须对。
- 键位:`Esc` 取消当前 turn **保留草稿**;`Enter` 排队(映射到 pi 的 followUp 队列)。`Ctrl+Enter` cancel-and-send 是 Phase 2 的事。
- 不渲染花哨 block 类型:thinking / diff 一律按纯文本段落显示,block 模型是 Phase 2 的一等公民。

**Tradeoff**:用 `TuiMainScreen` 纵向流式,**放弃** alt-screen 全屏 viewport。理由:plan.md 已判定「比 alt-screen 便宜」;alt-screen 带来 viewport 管理、折叠、焦点栈一整套成本,Phase 1 的价值是验证 core 而不是 UI 华丽度。已知代价:长输出靠终端 scrollback,没有应用内滚动——单人使用可接受。

**验收**:
- 流式输出中人为乱序 `contentIndex`(在测试里重放录制的乱序事件流),渲染结果不错乱。
- 流式中途按 `Esc`:turn 终止、草稿保留、session JSONL 里无半个 turn(tool_use 必有配对 tool_result——由 ⑦ 的属性测试兜底)。
- 流式中途按 `Enter` 输入新消息:当前 turn 结束后新消息被消费。

### ⑥ cli 包

**路径**:`packages/cli/src/{main.ts, headless.ts}`

**内容**:
- `myh`(占位名):默认进 interactive(接 ⑤)。
- `myh -p "..." --json`:headless,把 `SessionEvent` 流以 JSON lines 打到 stdout。
- **headless 是边界腐烂探测器**(design-rationale C.4 ③):headless 跑得通 ⟺ core 没有 UI 泄漏。它必须进 CI,不是手动测。

**Tradeoff**:无实质分支。唯一注意:headless 模式遇到需要阻塞输入的情形(Phase 1 没有 permission,但工具错误重试不算阻塞)直接报错退出,不做隐式降级——让边界问题暴露而非被吞掉。

**验收**:CI 里跑 `myh -p "read package.json 并总结" --json`(用录制回放或廉价模型),退出码 0 且输出每行是合法 JSON;在 `core` 里故意 import `tui` → headless 的 CI 依赖检查(①)变红。

### ⑦ loop 一致性测试套件

**路径**:`tests/loop-contract/{abort-machine.ts, abort.property.test.ts, steering.test.ts, parallel-tools.test.ts, stop-reason.test.ts}`

**内容**(design-rationale C.1 + cat-cafe F.2,已审):
- `abort-machine.ts`:**纯函数状态机**,输入事件序列,输出状态;不变量——每个 `toolCall` 恰好一个 `toolResult` 且不早于它的 call、进入 `aborted` 后任何输入不改变状态、**abort 按 turn 原子写**(不留半个 turn,与 `agentLoopContinue` 末条消息约束同一件事的两面)。
- `abort.property.test.ts`:fast-check 跑 ≥500 轮随机事件序列,验证上述不变量。⚠️ 注意 cat-cafe F.9 的审核结论:F25 是 InvocationRecord 生命周期状态机,我们借的是**方法论**(单一规格文件 + 属性测试),abort 语义是我们自己的设计。
- 其余三条不变量:steering 插入后消息序列合法(满足 `agentLoopContinue` 末条约束)、并行 tool 一个 throw 其余不丢、`StopReason` 六态各有后续动作。
- **先跑在 pi 的实现上**——测试目标是锁住行为契约,不是证明 pi 正确;Phase 3 换自研 loop 时同一套测试直接跑。

**Tradeoff**:属性测试用 fast-check,**放弃**手写枚举用例。理由:abort 的 bug 几乎全在时序交错里,手写枚举覆盖不到;fast-check 是 cat-cafe 实证的形状(984→1327)。代价:引入一个 dev dependency + 团队(自己)要会读 shrink 报告——单人项目,可接受。

**验收**:四条不变量全绿;人为在 pi-port 层注入一个「abort 后仍发事件」的 bug → 属性测试在 CI 变红。

---

## 3. 整体验收标准

**唯一验收标准(plan.md 原文):开始用它而不是用别的。**

可操作化(全部满足才算 Phase 1 完成):

1. **真实使用 3 天**:用 `myh` 完成至少 5 个真实任务(读代码、改文件、跑测试),期间没有用回其他工具。遇到的每个「想用回别的」的瞬间记录为 issue——那才是 Phase 2 的真实需求清单。
2. **打断-恢复链路**:流式中 `Esc` → 草稿还在;重开 CLI → session 树可续跑;`session-search` 能找回昨天的某个决策出处。
3. **headless 在 CI 绿**:见 ⑥。
4. **一致性测试套件绿**:见 ⑦,且包含一次「人为注入 bug 会变红」的反向验证。
5. **CI 依赖铁律绿**:见 ①。

明确**不**作为验收标准:渲染美观度、token 成本、速度。Phase 1 验证的是「可依赖」,不是「好用」。

---

## 4. Phase 1 明确不做

写下是为了不手软(全部有去处):

- permission 流水线、blocking card、request 总线实现 → Phase 2(protocol 的 envelope 类型已在 ② 定好)
- alt-screen、block 折叠、inline diff、FocusStack → Phase 2
- team、@mention、dashboard → Phase 2.5
- compaction、SKILL.md、plan mode、记忆 → Phase 3
- 工具的输出首/末裁剪策略 → Phase 2(Phase 1 硬截断)
- `Ctrl+Enter` cancel-and-send → Phase 2

## 5. 假设与风险

- 假设:Bun 最新稳定版;pi 三包 pin 在当前已验证版本(Phase 0 确认);运行环境 WSL2。
- 风险:pi 的 `Agent` 类状态假设与「事件流当事实源」冲突(概率低)——缓解:④ 的 Tradeoff 1 已留掉层逃生口,⑦ 的测试套件是前提。
- 风险:`pi-tui` 无 `exports` map,深引用不受约束——缓解:只在 `pi-port.ts`(core)和 `app.ts`(tui)两处触碰 pi,vendor 决策留到真正被撞时。
- 已知粗糙点(记录在案,不算 bug):bash 输出硬截断、thinking/diff 纯文本渲染、无应用内滚动。

## 6. Phase 0 实证记录

本仓库于 2026-08-31 在 WSL2/Linux 完成以下可复现检查:

- `bun install --exact` 安装 `@earendil-works/pi-ai@0.84.4`、`pi-agent-core@0.84.4`、`pi-tui@0.84.4`;三包实际 ESM import 成功。
- `bun x @earendil-works/pi-coding-agent@0.84.4 --version` 输出 `0.84.4`;对应 tag commit 为 `b79e4cc834970cca69daebffab7df1da7d1e52c4`。
- pi 源码中的 `packages/{client,server,protocol}` 与 `packages/coding-agent/examples/extensions/` 已读取;前者分别提供 transport-neutral client、实验性 server、严格 CBOR/protocol，后者为扩展格式参考，不作为本项目依赖。
- `pi-tui@0.84.4` 在 Linux 发布物不含 Linux native `.node`，实际 import 走 TypeScript/JS 路径;不能把 macOS/Windows native 文件误记成 WSL2 门禁通过。
- `HStack` 在 40 列宽度下可在同一行渲染左右区域,二维分栏的基础能力通过代码探针;dashboard 的完整交互仍留 Phase 2.5 人工验证。
- `session-search` 对本机生成的 1000 条 JSONL 查询耗时 `5.281ms`,低于 `<100ms` 验收线。

尚未自动化的 Phase 0 人工项:真实终端下鼠标滚轮、OSC 52、truecolor 目测，以及二维 dashboard 的交互目测。Phase 1 不依赖二维 dashboard;它属于 Phase 2.5。
