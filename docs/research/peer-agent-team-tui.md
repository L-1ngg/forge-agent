---
doc_kind: note
created: 2026-09-01
---

# Peer agent team 与 TUI 表达调研

> 状态:已调研(2026-09-01)
> 目的:给 Phase 2.5 的设计评审与施工图提供源码证据。本文提出的是建议契约,不是已批准 ADR;与 [plan.md](../plan.md)、[design-rationale.md](../design-rationale.md) 冲突时,应先由 operator 定案。

## 1. 结论

当前 `peer-agent-team` 方向可行,但已有设计需要补一层明确的 delivery/run 契约,否则 `.harness/team/<name>/inbox/*.json` 很容易同时承担「待投递」「已读取」「正在执行」「已完成」四种互不等价的事实。

TUI 可行性已经不再是未知项。`pi-tui@0.84.4` 同时提供 `HStack`、`VStack`、`ScrollView` 和 `basis/grow/shrink/minSize/maxSize/visible`;上游测试直接覆盖两个并排 `ScrollView` 的指针命中与独立滚动。本项目安装包的 40 列探针也已渲染左右区域。因此:

- 宽屏可以做「agent 列表 + peek/detail」二维布局。
- 中等宽度可以把 peek 下沉成列表下方的纵向区域。
- 窄屏应改成单 pane drill-in,不应把两栏硬压到一起。
- 仍未通过的是实际 WSL2/tmux 终端下的完整交互验收,尤其是滚轮、OSC 52、truecolor 和多滚动区键盘所有权。

产品语义上,本项目要的是**持久、对等的 teammate**,不是一次性 subagent,也不是只有 session 列表的 dashboard:

| 能力 | disposable subagent | session dashboard | peer teammate |
|---|---|---|---|
| 身份跨 session | 否 | session 身份 | 是,稳定 teammate id |
| 独立上下文 | 是 | 是 | 是,且可形成 session chain |
| 显式互发消息 | 通常只回 parent | 用户可 reply | 人与 teammate、teammate 之间都可发 |
| 共享任务状态 | 无 | 无或仅 session 状态 | 有 board + owner + revision |
| 消息责任闭环 | parent 聚合结果 | turn 完成 | delivery + exact invocation + terminal |
| TUI | thread picker | command center | command center + inbox + board + peer routing |

最值得迁移的组合是:

1. Codex 的 thread inspection 与可 steer/stop 管理面。
2. grok-build 的 dashboard/peek、稳定 row id、焦点与输入所有权。
3. Clowder 的显式 target、单一 admission owner、exact invocation、typed terminal 与 reconciliation。
4. pi 的 agent loop、事件流和 TUI 原语。

不应迁移 Clowder 的 Redis/API/web/connectors 平台,也不应把 pi 的 subagent 示例误当成 team runtime。

## 2. 调研边界与证据层级

### 2.1 固定快照

| 项目 | 固定 commit / 版本 | 本文使用范围 |
|---|---|---|
| OpenAI Codex | [`032d15c`](https://github.com/openai/codex/tree/032d15cba77e28d4eb697b1f11bc395c2522d12b) | 当前 multi-agent v2 与 TUI 实现快照 |
| pi | [`853a80d`](https://github.com/earendil-works/pi/tree/853a80d26c90a14c1886f0ebb8ffaae133ca2185),npm `0.84.4` | agent loop、TUI、实验 client/server、subagent 示例 |
| grok-build | [`bc7f02e`](https://github.com/xai-org/grok-build/tree/bc7f02eddd3d84085849dc19ed216f11c23b0571),`SOURCE_REV=d5a0335` | dashboard、scrollback、焦点、queue、subagent 生命周期 |
| clowder-ai | [`090626a`](https://github.com/zts212653/clowder-ai/tree/090626a538d59e2b6ce3c3ba9b205b57d958fcdd) | delivery/custody/run 语义与当前迁移状态 |

Codex 部分刻意分成两级:

- **官方公开契约**:[OpenAI Docs - Subagents](https://developers.openai.com/codex/agent-configuration/subagents)。它确认并行 subagent workflow、thread inspection、结果聚合、steer/stop/close、继承 sandbox/permission 等用户可依赖能力。
- **当前源码快照**:v2 工具、canonical task path、session-local picker 和 daemon-wide command center。它们能证明设计已经可实现,但不能替代公开稳定性承诺。

### 2.2 本项目现状

现有设计在 [design-rationale.md C.3](../design-rationale.md) 已经决定:

- `.harness/team/<name>/IDENTITY.md` 进入 system prompt slot。
- 每个 teammate 有自己的 config、session 与 inbox。
- `board.jsonl` 是共享任务板。
- 单进程内运行 N 个 `Agent` 实例。
- mention 只负责写 inbox + 入队,不能成为第二执行入口。
- 用显式 `cwd`、per-agent env 和无模块级可变单例约束 in-process 共享基底。

这些方向保留。需要修正或补全的地方有四个:

1. `@mention` 只能是人类输入的 fallback 语法,不能是可靠协议原语。结构化路径必须携带 `targetAgentIds`。
2. `rename()` 只能证明某个消费者 claim 了文件,不能证明 agent 看到了正文、处理完责任或产生了唯一终局。
3. `session.jsonl` 不是稳定 teammate identity;同一 teammate 可以有多条 session chain。
4. dashboard 不能从「是否仍在 stream」推断运行状态;必须读取独立的 invocation truth。

## 3. 参考实现告诉了什么

### 3.1 Codex:强 thread 管理,弱持久 team 语义

官方文档明确了 subagent workflow 的用户模型:主 thread 保留需求和决策,并行 thread 承担噪声较大的探索/测试工作,最后返回摘要;CLI 用 `/agent` 查看和切换 thread,App/IDE 暴露 thread 活动,用户可以要求 steer、stop 或 close。

当前源码进一步展示了两级管理面:

- `spawn_agent`、`send_message`、`followup_task`、`wait_agent`、`list_agents`、`interrupt_agent` 已拆成不同语义。[工具定义](https://github.com/openai/codex/blob/032d15cba77e28d4eb697b1f11bc395c2522d12b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L181-L345) 明确 `send_message` 只排队、不触发 turn,而 `followup_task` 会触发 idle agent 或在运行边界注入。
- v2 使用 canonical task path,避免树中重名 agent 的寻址歧义。[spawn 说明](https://github.com/openai/codex/blob/032d15cba77e28d4eb697b1f11bc395c2522d12b/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L731-L750)
- `/subagents` picker 按 first-seen spawn order 保持稳定,而不是按 thread id 重排。[agent navigation](https://github.com/openai/codex/blob/032d15cba77e28d4eb697b1f11bc395c2522d12b/codex-rs/tui/src/app/agent_navigation.rs#L1-L18)
- daemon-wide `Agent command center` 将 thread 分为 `Needs input / Working / Ready / Finished`,宽度 `>= 90` 时切成列表 + 详情。[overview view](https://github.com/openai/codex/blob/032d15cba77e28d4eb697b1f11bc395c2522d12b/codex-rs/tui/src/app/agents_overview_view.rs#L43-L72),[宽屏切分](https://github.com/openai/codex/blob/032d15cba77e28d4eb697b1f11bc395c2522d12b/codex-rs/tui/src/app/agents_overview_view.rs#L595-L616)
- command center 依赖共享 background server;embedded/local-only session 显示明确 unavailable 状态。[overview availability](https://github.com/openai/codex/blob/032d15cba77e28d4eb697b1f11bc395c2522d12b/codex-rs/tui/src/app/agents_overview.rs#L44-L79)

可迁移:thread picker、稳定顺序、汇总状态、显式 steer/stop、宽度响应式详情。

不能直接当 team 契约:Codex subagent 仍由 parent spawn 与聚合;公开文档没有承诺 roster、跨 session teammate identity、共享 board 或 durable peer inbox。

### 3.2 pi:布局与 loop 足够,team 编排不在库里

`pi-tui` 的二维能力已经由源码和测试证明:

- [`HStack`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/h-stack.ts#L5-L43) 会先分配每个 child 的宽度,再把行合成到对应 x offset。
- [`StackEntryOptions`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/stack.ts#L4-L21) 暴露 `basis/grow/shrink/minSize/maxSize/visible`。
- [`ScrollView`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/src/components/scroll-view.ts#L21-L53) 有独立 `scrollTop`、follow、overscroll 与 scrollbar 状态。
- 最强证据是 [alt-screen 测试](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/tui/test/tui-alt-screen.test.ts#L153-L179):两个并排 scroll view 中,右栏上的 wheel 只改变右栏位置。

`pi-agent-core` 则提供单 agent 的运行语义:事件顺序、steering/follow-up 队列、abort、tool 执行与 subscriber。它没有 roster、board、peer delivery 或 team scheduler。这一层应由本项目拥有。

实验性 `protocol/client/server` 已经验证另一条边界:长度前缀 CBOR、request correlation、authoritative snapshot 和 exclusive/shared session lease 是可行的。但 Phase 2.5 仍在单进程内,不需要提前引入 socket server。

### 3.3 grok-build:成熟的 supervision TUI,不是消息协议

grok dashboard 的关键价值不在配色,而在状态和输入所有权:

- row 每帧由 roster/session truth 重建,selection 绑定稳定 `DashboardRowId`,而非列表 index。[row id 与持久映射](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/state.rs#L117-L138),[selection](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/state.rs#L377-L408)
- peek 替换底部 dispatch 区;dispatch 创建新 session,peek reply 发给既有 row。reply target 因此不能从当前 index 临时推断。
- list 和 input 是两个明确 focus owner;`Esc` 一层一层退出。
- 状态按 `Needs input > Working > Idle > Inactive > Completed > Failed` 分组。`Working` 包含 turn 结束后仍活着的 background task/monitor/loop,不能等同于 streaming。
- pin/reorder 按 session id 持久化,不会因行重排丢失。

blocking card 也使用单一 key router。四种卡片是 `Permission / CancelTurn / Question / McpElicitation`;焦点可以 park 到 scrollback,卡片仍留屏,`Tab/Space` 是回到卡片的 pinned route。[key owner](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L9-L59),[park semantics](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L150-L163)

它不解决 peer message 的 durability。ACP `session/new`、`session/prompt`、`session/update` 能驱动 UI,但「谁负责这条消息直到哪个终局」仍需本项目定义。

### 3.4 Clowder:最有价值的是事实分离

Clowder 最新批准架构把 delivery kernel 压到三个对象:

| 对象 | durable | 回答的问题 |
|---|---|---|
| Queue Entry | 是 | 哪个输入按什么 intent 等待 admission |
| Chat History Message | 是 | 哪个内容已进入共享语义边界,顺序与 causal refs 是什么 |
| Active Run | 否,内存 | 哪个 exact input 已被哪个 agent 接纳为当前运行 |

来源:[A2A protocol](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/a2a-protocol.md#L9-L17)。其主线是「enqueue -> strict head -> one admission transaction -> same response bubble streams -> one typed terminal -> release exact run -> drain again」:[pipeline](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/a2a-protocol.md#L23-L29)。

最重要的不变量不是对象名,而是:

- enqueue target 只是 intent,dispatch 时重新验证。
- admitted 不等于 body exposed。
- exposed 不等于 handled。
- stream ended 不等于 responsibility completed。
- terminal 必须绑定 exact invocation,且只提交一次。
- derived projection 只显示事实,不能反过来成为 truth owner。

当前实现仍处于迁移期。`InvocationQueue` 是 process-local `Map`,durable custody 则散在 `MessageStore`、`QueuedMessageCustodyCoordinator` 和 `InvocationRegistry`。这说明本文应迁移其**目标架构不变量**,不应照抄当前类图。

## 4. 建议的最小领域模型

以下是 Phase 2.5 值得先定成 ADR 的最小集合。字段名是建议,不是既定 API。

```ts
type AgentId = string
type SessionId = string
type ThreadId = string
type MessageId = string
type DeliveryId = string
type InvocationId = string

interface Teammate {
  id: AgentId
  name: string
  identityRef: string
  configRef: string
  enabled: boolean
}

interface TeamMessage {
  id: MessageId
  threadId: ThreadId
  from: { kind: "user" | "agent" | "system"; id?: string }
  targetAgentIds: AgentId[]
  bodyRef: string
  createdAt: string
}

interface Delivery {
  id: DeliveryId
  messageId: MessageId
  targetAgentId: AgentId
  state: "queued" | "admitted" | "terminal"
  attempt: number
  invocationId?: InvocationId
  terminal?: "completed" | "failed" | "cancelled" | "interrupted" | "rejected"
}

interface ActiveInvocation {
  id: InvocationId
  deliveryId: DeliveryId
  agentId: AgentId
  sessionId: SessionId
  startedAt: string
}
```

另外保留两个**正交事实**,不要塞进 `Delivery.state`:

```ts
interface BodyExposure {
  deliveryId: DeliveryId
  sessionId: SessionId
  exposedAt: string
}

interface ResponsibilityReceipt {
  deliveryId: DeliveryId
  handledAt: string
  outcome: "done" | "delegated" | "declined"
}
```

这样设计后:

- inbox 文件存在只表示 `queued`。
- dispatcher claim 只表示开始 admission。
- prompt assembler 实际把正文放进 context 时才写 exposure。
- agent turn 结束写 invocation terminal。
- 若这条消息要求 review/ack 等责任闭环,由 receipt 单独表达 handled。

普通对话可以在 terminal 时自动生成 receipt;未来的审批、review 或 handoff 可以由各自 owner 决定 receipt。Phase 2.5 不必实现复杂责任类型,但不能把扩展口堵死。

## 5. 单一 admission 与事件流

### 5.1 唯一入口

建议的调用链:

```text
human text / structured tool / teammate output
                    |
                    v
             resolve targets
      (@mention only a parser fallback)
                    |
                    v
          persist TeamMessage + Delivery
                    |
                    v
             requestDrain(thread)
                    |
                    v
      one scheduler validates strict head
                    |
                    v
       admit exact Delivery -> Invocation
                    |
                    v
      expose body -> run agent -> terminal
                    |
                    v
       release exact run -> drain again
```

所有路径都必须汇入 `persist TeamMessage + Delivery`;TUI 不直接调用某个 `Agent.prompt()`,mention parser 也不直接执行。这延续 [cat-cafe.md](../cat-cafe.md) 已审的「单一执行入口」结论。

### 5.2 建议 canonical events

事件名不是重点,事实边界才是重点:

```text
team.message.enqueued
team.delivery.admitted
team.delivery.exposed
team.invocation.started
team.invocation.completed
team.invocation.failed
team.invocation.cancelled
team.invocation.interrupted
team.delivery.handled
team.task.created
team.task.assigned
team.task.status_changed
team.reconciliation.completed
```

每个 event 至少带 `eventId`、`occurredAt`、`threadId`、producer、对应 exact ids。UI 可以从 reducer 得到 projection;session store、headless JSON 和未来 web client 也消费同一流。

### 5.3 `rename()` 的正确边界

同一文件系统内原子 rename 适合作为 claim:

```text
inbox/queued/<delivery-id>.json
          -> inbox/claimed/<delivery-id>.<invocation-id>.json
```

但它不是完整事务系统。必须额外满足:

1. 文件内容先写临时文件,fsync 策略按实际风险决定,再原子 rename 发布。
2. claim 文件带 exact `deliveryId/invocationId/attempt`。
3. terminal 是独立 append-only 事实或原子 snapshot,不能靠删除 claim 文件表达。
4. 启动时扫描 `claimed + no terminal`,收敛为 `interrupted`,再按显式 policy 重试或留给用户。
5. 单进程只有一个 scheduler 负责 admission;不要让每个 agent 自己扫目录抢活。

## 6. 生命周期与调度

### 6.1 Delivery 状态机

```text
                    target invalid / overload
                  +--------------------------> rejected
                  |
queued --admit--> admitted --start--> running --success--> completed
   |                   |                 |  +-------------> failed
   |                   |                 |  +-------------> cancelled
   |                   |                 +----------------> interrupted
   |                   |
   +--cancel queued--> cancelled

terminal states are absorbing
```

实现可以把 `admitted/running` 放在 `ActiveInvocation` 而非 durable enum;外部可观察语义仍要保持。任何 terminal 之后的迟到 delta、重复 completion 或旧 attempt 回调都必须被 exact id + generation 拒绝。

### 6.2 三种输入语义

不要只用一个“send”:

| 操作 | 对 idle target | 对 busy target | 用户表达 |
|---|---|---|---|
| `enqueue` | 进入下一次 drain | 留在队列 | 普通 `Enter` |
| `append` | 等价 enqueue | 加入当前 run 的 steering queue | 明确 command/tool |
| `steer` | 进入下一次 drain | cancel 当前 run 后 admit 新 delivery | `Ctrl+Enter` |

`append` 是否进入 Phase 2.5 可以晚定;`enqueue` 与 `steer` 必须从第一天分开。grok 和 Codex 都用不同路径表达“只排队”与“触发/打断”。

### 6.3 公平性与背压

Clowder 的文档明确采用 per-thread strict head,不扫描后项绕过 busy target。个人 harness 可以先采用同样规则,因为它最容易解释和恢复;若真实使用出现 head-of-line blocking,再用证据增加 per-agent queue。

Phase 2.5 必须先定四个上限,具体数值可在施工图决定:

- 每个 agent 的 queued deliveries 数量。
- 全 team 的 queued body bytes。
- 单次 fan-out 数量。
- peer hop depth / attempt count。

超限必须产生可见、typed `rejected/overloaded`,不能静默丢弃,也不能只在 toast 里报错。

## 7. TUI 信息架构

### 7.1 两种主视图

不要把所有能力塞进一个 dashboard。建议保留两个一级 surface:

1. **Conversation**:当前 thread 的 transcript、block、card、composer。
2. **Team command center**:roster、inbox/needs-input、task board、选中 agent 的 peek/reply。

它们消费相同 projection,但优化不同工作:

- Conversation 优先连续阅读与回答一件事。
- Command center 优先扫描、比较、切换和干预多个 agent。

### 7.2 宽屏 `>= 110 columns`

```text
+ Team ---------------------------------------------------------------+
| Agents (28)              | Selected: reviewer                       |
|                          |                                           |
| ! reviewer   needs input | Last response                             |
| * builder    working     | Reviewed request-bus shape. One blocking  |
| o researcher idle       | issue remains in timeout ownership...     |
| x scout      failed      |                                           |
|                          | Queue 2 | Task review-bus | model ...      |
|--------------------------+-------------------------------------------|
| Board                    | > reply to reviewer                       |
| doing  review bus        |                                           |
| blocked terminal UX      |                                           |
+---------------------------------------------------------------------+
```

布局建议:

- 左侧固定 24-32 列,`minSize` 防名字/status 被压没。
- 右侧 `grow: 1`,peek body 自己是 `ScrollView`。
- board 在左栏下半部或独立 tab,不要再套 card。
- terminal 太矮时先隐藏 board,再缩 peek;composer 和 status 不可被挤掉。

### 7.3 中等宽度 `70-109 columns`

```text
+ Team --------------------------------------------------+
| ! reviewer  needs input   * builder  working           |
| o researcher idle         x scout    failed            |
|---------------------------------------------------------|
| reviewer | Last response                               |
| Reviewed request-bus shape...                          |
|---------------------------------------------------------|
| > reply to reviewer                                    |
+---------------------------------------------------------+
```

用 `VStack` 把 roster、peek、composer 纵向排列。roster 自己滚动,peek 自己滚动;鼠标命中可由 pi layout rect 路由。键盘必须有唯一 active scroll owner。

### 7.4 窄屏 `< 70 columns`

```text
+ Agents 3 working, 1 needs input --+
| ! reviewer       needs input      |
| * builder        working          |
| o researcher     idle             |
| x scout          failed           |
|                                     |
| > New task                         |
+-------------------------------------+
```

`Enter` drill into selected agent,详情成为单 pane;`Esc` 回列表。窄屏不同时画 roster 与 peek,也不保留第二个不可见 focus owner。

### 7.5 Row 内容与状态优先级

row 只放适合扫描的事实:

```text
state icon | name | short activity | queue count | attention badge
```

model、cwd、permission mode、完整 task title 放 peek footer/detail,不塞列表。状态分组建议沿用 grok 的优先级:

1. `Needs input`
2. `Working`
3. `Idle`
4. `Inactive`
5. `Completed`
6. `Failed`

其中 `Needs input` 是 blocking request 存在;`Working` 由 active invocation 或 background work truth 决定;`Idle` 是可接活;`Inactive` 是定义存在但当前未加载。`Completed/Failed` 更适合 session/run history,而不是永久 teammate 本身。UI 可以显示 teammate 的最近 run 结果,但模型层不要把 teammate 标记成永久 completed。

## 8. 焦点、键盘与草稿

### 8.1 Focus owner

任一时刻只能有一个 owner:

```text
modal/blocking card
  > viewer/overlay
    > team list | peek scroll | reply input
      > global bindings
```

shortcuts bar 必须从同一 router 读取当前 owner,不能由各 component 各自宣传快捷键。

### 8.2 建议键位

| 键 | list focus | peek focus | reply input |
|---|---|---|---|
| `j/k` 或 `Up/Down` | 移动稳定 row id | 滚动 | 历史/光标,不切 target |
| `Enter` | attach/open | focus reply | enqueue to bound target |
| `Ctrl+Enter` | 无 | 无 | steer/cancel-and-send |
| `Tab` | 下一个 owner | 下一个 owner | 下一个 owner |
| `Esc` | 退出 command center | 回 list | 先退出子状态,再 park/回 list |
| `Ctrl+C` | 依当前 owner 清除/取消 | 同左 | 有草稿先清草稿,空草稿才请求 cancel run |

reply composer 必须绑定稳定 `DashboardRowId/AgentId`,而不是“当前高亮第 N 行”。有非空草稿时,移动 selection 不应悄悄换收件人。可选的最简单规则是**锁定 target 直到发送或清空**;如果允许切换,必须明确提示并清空 draft + undo history。grok 的实现选择后者,本项目可在 Phase 2.5 UX 评审时二选一。

dispatch composer 与 reply composer 必须视觉和语义分开:

- `New task` 永远创建新 top-level run/task。
- `Reply to <name>` 永远投给已存在 teammate/run。

## 9. Failure 与恢复表达

TUI 必须把恢复事实画出来,不能只给红色 `Failed`:

| 状态 | 触发事实 | TUI 行为 |
|---|---|---|
| `queued` | durable delivery,未 admission | queue count + 可 cancel |
| `needs input` | unresolved blocking request | 行置顶 + 打开 exact card |
| `interrupted` | 启动发现 admitted run 已无 live owner | 显示 recovered interruption,给 retry/discard |
| `target unavailable` | dispatch 时 agent 不存在/disabled | typed failure,不 fallback 到别人 |
| `stale callback` | invocation/generation 不匹配 | 不改变状态,诊断日志可查 |
| `overloaded` | 命中背压上限 | 明确 rejected,保留来源与重试入口 |
| `projection stale` | reducer revision 落后 | 显示 reconnecting/stale,禁止 destructive action |

启动 reconciliation 的最低行为:

1. 读 durable messages/deliveries/terminals。
2. 找到 `admitted` 且没有 live invocation/terminal 的记录。
3. 原子写 `interrupted` terminal。
4. 根据来源与 attempt policy 决定重新入队还是等待人工 retry。
5. reducer 重建 command center projection。

不要直接“把 claimed 文件搬回 queued”而不留下 interrupted 事实,否则历史无法解释为什么同一消息执行了两次。

## 10. Phase 2.5 建议施工切片

### Slice 0:先定契约

产物:

- ADR:teammate/session/message/delivery/invocation 的 owner 边界。
- ADR:enqueue/append/steer 语义和 single admission owner。
- protocol event union 与 reducer fixture,暂不接真实 agent。

出口:对重复 terminal、迟到 event、crash recovery 做纯函数状态机测试。

### Slice 1:持久 identity + session chain

产物:

- stable `AgentId`,显示名可改但 id 不变。
- `IDENTITY.md` / config 的解析与 system slot 装配。
- 每个 teammate 可有多条 session,最近 active session 是 projection,不是 identity。

出口:重启后 roster、session lineage 与 identity 不漂移。

### Slice 2:durable inbox + scheduler

产物:

- structured target first,mention fallback parser。
- `TeamMessage + Delivery + exact Invocation`。
- 单 scheduler、strict head、typed terminal、reconciliation。
- 基础上限与 `overloaded`。

出口:故障注入覆盖 enqueue 后崩溃、claim 后崩溃、stream 中崩溃、terminal 重放。

### Slice 3:board

保留现有 `TaskItem` 核心字段,增加 `revision` 与可追溯 `updatedBy/updatedAt`。`subjectKey` 做幂等键,不是执行锁。board mutation 也走单 owner + compare revision,避免两个 agent 最后写覆盖。

出口:并发 claim 同一 task 只有一个成功;projection 可以由日志重建。

### Slice 4:command center

先做 narrow single-pane 与 medium `VStack`,再启用 wide `HStack`;这样数据/焦点契约不依赖二维布局。接入稳定 row id、peek、reply binding、needs-input cards。

出口:三档宽度无 overlap,resize 后 selection/scroll/draft target 保持正确。

### Slice 5:真实终端验收

在 WSL2 真实终端和常用 tmux 配置下验:

- 左右/上下两个 scroll view 的滚轮命中。
- `Tab/Esc/Enter/Ctrl+Enter/Ctrl+C` 的 owner 一致性。
- OSC 52 复制、鼠标 selection、truecolor。
- resize、detach/reconnect、agent streaming 时 dashboard 切换。

## 11. 必须锁住的验收标准

### 协议与一致性

- [ ] 同一 `Delivery` 最多一个 admitted `Invocation`;重试必须增加 attempt/generation。
- [ ] terminal 是吸收态;重复/迟到/旧 generation event 不改变结果。
- [ ] enqueue target 在 dispatch 时重验;显式 target 失败不会 silent fallback。
- [ ] `queued/admitted/exposed/handled/terminal` 可分别构造并观测,不存在互相推导的捷径。
- [ ] mention、TUI structured send、agent peer send 最终都进入同一个 scheduler。
- [ ] 启动 reconciliation 后不存在“queue 非空、head 可执行、无 active run、无 drain owner”的稳定状态。
- [ ] 背压超限产生 typed、可见、可追踪结果。

### TUI

- [ ] 40/69/70/89/90/109/110/160 列做 snapshot,文字不重叠、focus owner 唯一。
- [ ] 两个 scroll region 的 pointer wheel 只改变命中区域。
- [ ] resize/churn 后 selection 仍绑定 stable row id,不跳到另一个 agent。
- [ ] 非空 reply draft 不能无提示地换 target。
- [ ] dispatch 只创建新 session;reply 只投已有 target。
- [ ] blocking card park 后仍留屏,shortcuts bar 显示真实 owner 的键。
- [ ] `Needs input` 可从 dashboard 一步打开 exact request,回答后回到原 selection。
- [ ] narrow mode 无隐藏的第二 focus owner。

### 恢复与故障注入

- [ ] enqueue 持久化后进程退出,重启只执行一次。
- [ ] admission 后、agent 调用前退出,重启产生 `interrupted` 且按 policy 收敛。
- [ ] streaming 中退出保留已有输出,不把 stream end 当 terminal。
- [ ] terminal 写成后重复回调不再创建第二 response/task mutation。
- [ ] board 同 revision 的并发更新只有一个成功,失败方拿到当前 revision。

## 12. 尚未定案的问题

这些问题需要真实 Phase 1 使用证据或 operator 决策,本文不猜:

1. busy target 上 `append` 是否进入 Phase 2.5,还是只有 enqueue/steer。
2. reply 草稿切 target 时是锁定 target,还是确认后清空。
3. strict per-thread head 是否会造成不可接受的 head-of-line blocking。
4. durable event log 是单个 `.harness/team/events.jsonl`,还是每 thread/session 分片。
5. interrupted 默认自动重试哪些来源,哪些必须人工确认。
6. queue count/bytes/fan-out/depth 的初始数值。
7. board 是否在 command center 常驻,还是作为 tab/overlay。

## 13. 最终建议

Phase 2.5 不应从 dashboard 开始。正确顺序是先锁住 identity、delivery、invocation、terminal 与 recovery,用 headless reducer 证明状态机,再把 command center 接到 projection 上。TUI 的二维能力已经具备,现在最大的风险不在“画不画得出来”,而在 UI 是否诚实表达底层事实。

实现边界保持简单:

- 依赖 pi 的 loop 与 TUI 原语。
- 自持 peer-team scheduler 和 durable facts。
- 学 grok 的 supervision UX,不移植 Rust 结构。
- 学 Clowder 的事实 owner,不移植其平台复杂度。
- 把 Codex 的公开 subagent 能力视为交互基线,把当前源码 dashboard 视为设计参考而非稳定 API。
