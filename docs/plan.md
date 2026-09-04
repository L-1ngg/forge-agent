# 个人 Coding Harness — 规划

> 状态:Phase 2.2 自有 TerminalFrame TUI 设计中,待 operator 确认(2026-09-04)。Phase 2 M1-M6 代码与自动化验收已完成;Phase 2.1 pixel parity 已中止,改由 [phases/phase-2.2.md](./phases/phase-2.2.md) 接手。Phase 1 人工验收与 Phase 2 E1-E3 按 operator 指示暂缓实测并按豁免处理,AC-14 未实测,E4 已复核。
> **本文件只放行动项。** 论证、探测证据、子系统设计见 [design-rationale.md](./design-rationale.md)。
> 灵感来源:[pi](https://github.com/earendil-works/pi) · [clowder-ai](https://github.com/zts212653/clowder-ai) · [grok-build](https://github.com/xai-org/grok-build)
> 第四来源 [cat-cafe-tutorials](https://github.com/zts212653/cat-cafe-tutorials) 的失效模式提炼见 [cat-cafe.md](./cat-cafe.md) —— 已并入本文件与 design-rationale。**该文件已审**(2026-08-31,对源仓库逐条核对,见 cat-cafe.md F.9):设计落点无一被推翻,修正集中在引用纪律(出处 / 标签 / 归因);引用时仍需连证据标签一起引。

---

## 0. 结论

三个参考项目占三个不重叠的层,不是三个竞争方案:

| 来源 | 提供 | 采用方式 |
|---|---|---|
| **pi** | 多供应商抽象、agent loop、harness 积木 | 作为 npm 依赖,**分层取用**(→ A)。不再取用 `pi-tui`(→ [ADR-005](./decisions/005-tui-own-compositor.md)) |
| **grok-build** | TUI 的交互设计与信息架构 | 只借设计(Rust,UX 不受版权保护) |
| **clowder-ai** | 团队协作语义、记忆、压缩恢复 | 只借机制,不引依赖 |

四条决策:

1. **agent loop 用 pi 的生成器层,现在不自研。** `pi-agent-core` 是四层且成熟度不同:`pi-ai` 永久依赖、`agentLoop()` 现在用、`harness/` 积木单取、`AgentHarness` 是空壳。→ A、C.1
2. **TUI 自有 cell compositor,不再依赖 `pi-tui`。** UX 借 grok 的信息架构与交互契约,不以 pixel parity 为出口。历史论证 C.2 保留,施工约束见 [ADR-005](./decisions/005-tui-own-compositor.md)(草稿,待确认)。
3. **team 用文件实现 clowder 的语义,in-process 多 `Agent` 实例。** 语义值得抄,Redis / A2A / web UI 不要。→ C.3
4. **core 与 UI 以协议隔离,现在就做。** 成本几天,不做则以后是重写。→ C.4

技术栈 **TypeScript + Bun**。走 Rust 等于放弃 `pi-ai` 重写整个供应商层。

---

## 1. 架构

```
my-coding-harness/
├── packages/
│   ├── protocol/   # 事件 union + request/response 类型。零依赖
│   ├── core/       # 编排:agent 调度、team、session store、config、context 装配
│   ├── tools/      # read / write / edit / bash / grep + 自有工具
│   ├── tui/        # shell:TerminalFrame compositor + grok IA,零外部 TUI 依赖
│   └── cli/        # 入口:interactive / -p print / --json
└── (deps) @earendil-works/pi-ai  pi-agent-core    [exact pinned]
```

### 依赖方向

```
protocol  ←  core  ←  cli  →  tui  →  protocol
              ↑
            tools
```

三条铁律,靠 CI 检查而非自觉:

- `core` 的 `package.json` 里永远不出现 `tui`
- `tui` 只认 `protocol` 与 `node:`,不 import `core` 的内部类型,也不依赖 `pi-tui` 或其它 TUI 框架
- `cli` 是唯一把两侧接起来的地方

### 与 pi 的接缝

```ts
const agent = new Agent({ ...initialState }, models.streamSimple.bind(models))
```

在 `core` 里包一层自己的窄接口,不让 pi 的类型漏到 `tui` 和 `tools`。pi 12 个月发了 43 个版本,隔离层几十行,收益是 breaking change 只砸一个文件。

---

## 2. 路线

### Phase 0 — 底座验证 spike(半天到 1 天)

> 自动化门禁已通过:`pi-tui` 在 WSL2 实际 import/render、40 列二维 `HStack`、上游多 `ScrollView` 测试和 pi `client/server/protocol`/extension 源码均已核实。证据见 [phases/phase-1.md](./phases/phase-1.md) §6 与 [research/pi.md](./research/pi.md)。

剩余发布前人工验收:真实终端/tmux 下滚轮、OSC 52、truecolor,以及完整二维 dashboard 的焦点、resize 与持续 streaming 交互。

**Plan B**(已升格为 Phase 2.2 正路径,待 ADR-005 确认):TUI 自己在 Bun 上写 cell compositor;继续只用 `pi-ai` / `pi-agent-core`,不引 `pi-tui`。

### Phase 1 — 每天能用

> 施工图(路径 / tradeoff / 验收)见 [phases/phase-1.md](./phases/phase-1.md);此处只留行动项。

- `protocol` 包定形状(借 ACP)+ CI 依赖检查
- `TuiMainScreen` 起步(比 alt-screen 便宜)
- 4 个工具:read / write / edit / bash。**入参 schema 与错误形状按纪律写**:能 `enum` 不用自由文本、`additionalProperties: false`、错误统一含 `error_code` / `field` / `expected` / `example` / `retryable`(→ F.5)
- 流式渲染按 `contentIndex` 归组
- session JSONL 树形持久化 + **`session_search` 等价的本地检索函数**(grep 定位 → 只读那一处,→ F.1 ⑤)
- `Esc` 取消保留草稿;`Enter` 排队
- `--json` headless 入口
- **loop 一致性测试套件** — 先跑在 pi 的实现上锁住行为契约,是 Phase 3 敢换 loop 的前提(→ C.1)。abort 部分写成**纯函数状态机 + fast-check 属性测试**,不止验配对性(→ F.2)

**唯一验收标准:开始用它而不是用别的。**

### Phase 2 — TUI 升级到 grok 水准

> M1-M6 原施工图见 [phases/phase-2.md](./phases/phase-2.md);pixel parity 返工已中止,见 [phases/phase-2.1.md](./phases/phase-2.1.md);当前 TUI 重写见 [phases/phase-2.2.md](./phases/phase-2.2.md)。

- 自有 alt-screen + `TerminalFrame` compositor(Phase 2.2)
- block 模型 + 折叠 + inline diff
- `FocusStack` + blocking card 契约(card `Esc` = park)
- **request 总线**(带 id 的 request/response)—— 本规划唯一「现在不做、以后一定后悔」项,→ C.4;形状决策见 [decisions/002-request-bus-shape.md](./decisions/002-request-bus-shape.md)
- permission 流水线:hooks → rules → 记住的授权 → 内置自动批准 → mode
- status line —— context 用量**在真相点计算**,不展示上一次调用的缓存快照(→ F.1 ②)
- `/` 菜单 + `@` file picker
- 语义色槽主题

### Phase 2.5 — Team(与 Phase 2 并行)

- `.harness/team/<name>/` + `IDENTITY.md` 进 system prompt slot
- `@mention` 路由(在 `core`)+ inbox + `rename()` 租约。**单一执行入口**:mention 解析的唯一输出是「写 inbox + 入队」,消费者只有一个(→ F.2,P0)
- **三个硬上限**:深度 `MAX_A2A_DEPTH=15`、fan-out ≤2 且串行、入队去重 + 「目标已被父调用覆盖」短路(→ F.2)
- `board.jsonl` 任务板
- in-process N 个 `Agent` 实例。工具取显式 cwd,env 走 per-agent context —— in-process 交出了 OS 隔离(→ F.2)
- 独立的 `hasActiveInvocation`,不从「是否在流式输出」推导能否停止(→ F.2)
- dashboard + peek panel(二维基础能力已验证;完整真实终端交互仍待 Phase 2.5 验收)

### Phase 3 — 产品化

SKILL.md 加载 · plan mode · `/rewind` · todo · `beforeToolCall` deny 规则 · compaction + 重注入载荷 · SQLite FTS5 记忆

其中四条来自 F.1 / F.3,不是可选打磨:

- **用户原始请求的原文进 slot**,与 `IDENTITY.md` 同级放 transcript 之外 —— AC / 摘要是需求的有损压缩(→ F.1 ①)
- **压缩写出阈值留余量**:预警 0.80 / 动作 0.88。阈值贴着自动压缩点等于机制一次也不会跑起来(→ F.1 ②)
- **状态文件的 key 带写出时的 head entry id**,SessionStart 校验它是当前 head 的祖先,否则丢弃 —— 树形 session 有多分支(→ F.1 ④)
- **记忆写入准入三门禁**:可追溯锚点、「防护」必须是可执行机制、「原理」需有真实失败案例。默认查询排除 `superseded_by`(→ F.3)

载荷里写死「不确定之前做了什么就去搜,不要猜」,并且任何需要模型自述或判断的部分挪到**读取时**做(→ F.1 ⑤⑥)。

### Phase 4 — 深化

subagent(独立 context,返回单条最终摘要)· `requireDifferentFamily` 评审 · (可选)ACP 完整合规 → Zed 当客户端 · (可选)core 包 server 层 → web UI

---

## 3. 下一步

operator 已选 1A/2A/3A。下一步是确认 [ADR-005](./decisions/005-tui-own-compositor.md) 与 [phases/phase-2.2.md](./phases/phase-2.2.md),然后 B0 清空 `packages/tui` 并去掉 `pi-tui`。确认前不删代码。

开工时一并 `git init`。
