---
doc_kind: note
created: 2026-09-01
---

# zts212653/clowder-ai 深度调研

> 状态:已调研(2026-09-01)
> 快照:[`zts212653/clowder-ai@090626a`](https://github.com/zts212653/clowder-ai/tree/090626a538d59e2b6ce3c3ba9b205b57d958fcdd)。本文区分上游 `approved` 目标架构、固定 commit 的当前实现和本项目建议;建议不是已批准 ADR。

## 1. 结论

Clowder 对本项目最有价值的不是“多 agent 聊天”表象,而是一套消息责任的事实分离:

1. enqueue target 只是 intent,admission 前必须重验。
2. admission、body exposure、handled、responsibility completed 和 run terminal 是不同事实。
3. 一条消息只有一个正常调度入口;队首由一个 owner admission,exact run terminal 后再释放并继续 drain。
4. 显式 target 失败不能悄悄换人;private/structured work 永不走最近成员 fallback。
5. UI receipt、头像、queue row 和 stream block 都是 projection,不能反过来拥有 lifecycle truth。

上游已经把目标 delivery kernel 收敛为三个对象:

| 对象 | durable | 回答的问题 |
|---|---:|---|
| `Queue Entry` | 是 | 哪个输入按什么顺序和 target intent 等待 admission |
| `Chat History Message` | 是 | 哪个内容已经进入共享 timeline,顺序与 causal refs 是什么 |
| `Active Run` | 否 | 哪个 exact input 已被哪个 agent client 接纳,对应哪个 response bubble |

来源:[A2A protocol](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/a2a-protocol.md#L7-L17)。

但固定 commit 的代码还没有完全长成这张图。`InvocationQueue` 仍是 process-local `Map<string, QueueEntry[]>`;durable custody 分散在 `MessageStore.queueCustody`、revision-fenced transition、`QueuedMessageCustodyCoordinator` 和 invocation auth/turn stores。这个差距不是反例,而是迁移状态。对本项目的正确用法是迁移其**不变量**,不要复制当前类图和历史兼容字段。

## 2. 调研边界与证据等级

本报告交叉检查了:

- `docs/architecture/a2a-protocol.md`:面向读者的精简 delivery contract。
- `docs/architecture/message-delivery-handling-handoff-audit.md`:状态为 `approved` 的完整架构与验收边界。[frontmatter](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/message-delivery-handling-handoff-audit.md#L1-L19)
- `InvocationQueue.ts` / `QueueProcessor.ts`:当前 process-local queue、selection 和 execution coordination。
- `MessageStore.ts` / `QueuedMessageCustodyCoordinator.ts`:durable custody、revision/CAS、exposure/attempt 与 recovery projection。
- `InvocationRegistry.ts`:exact callback principal、owner provenance 与 typed terminal。
- `a2a-mentions.ts` / `callback-tools.ts`:文本 mention 与 structured `targetCats` 的真实边界。

证据等级按下面使用:

| 标签 | 含义 | 本文如何引用 |
|---|---|---|
| approved architecture | 上游已经批准的目标契约 | 可作为设计先例,不能声称固定 commit 已全部实现 |
| source fact | 固定 commit 的实际类型、字段或调用路径 | 可说明现状,不能自动升级为稳定 public API |
| myh recommendation | 对本项目的裁剪与映射 | 需要 Phase 2.5 ADR/operator 决策后才成为真相源 |

这一区分很重要。上游完整架构自己就指出,当前问题来自 Queue/custody、body exposure、structured action/wait、InvocationRecord/TurnExecution 与 UI projection 互相冒充:[问题陈述](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/message-delivery-handling-handoff-audit.md#L43-L55)。因此不能只看一个 `status` 字段或一张 UI 图就推断整条链已闭合。

## 3. 目标架构:三个对象,多组正交事实

### 3.1 三个对象不是三本万能账

`Queue Entry / Chat History Message / Active Run` 只构成 conversation delivery kernel。Queue custody/body exposure、structured action、wait、durable invocation、callback principal 等仍由自己的 owner 保存;共享 id 是引用,不是复制 owner 权限。[对象边界](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/message-delivery-handling-handoff-audit.md#L313-L329)

这给本项目一个很实用的约束:

```text
Message/Delivery owns routing and admission
Invocation owns one exact run and terminal
Exposure owns whether body entered one exact context
Responsibility owner owns whether work was actually discharged
Projection owns none of the above
```

不要设计一个膨胀的 `status`:

```text
queued -> delivered -> seen -> processing -> done
```

这条线看起来简单,实际上把五个 owner 强行串成一个总序。现实中完全可能出现:

- 已 admission,但 provider start 前尚未 exposure。
- 已 exposure,但 invocation failed,责任仍待处理。
- invocation completed,但 review/approval 责任尚未 satisfied。
- terminal 已提交,UI reducer 尚未追上。

上游批准架构明确将 enqueue target、Queue admission、provider body exposure、source handled 与 responsibility completed 定义为五个不同事实:[设计目标 8-10](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/message-delivery-handling-handoff-audit.md#L65-L68)。

### 3.2 消息的唯一主流程

目标流程只有一条:

```text
source envelope
  -> durable enqueue
  -> strict comparator head
  -> one admission transaction
  -> create/reuse input message + fixed response bubble
  -> create process-local exact run
  -> stream into the same bubble
  -> commit one typed terminal in place
  -> release exact run
  -> request drain again
```

精简协议逐步写明了 enqueue、strict head、admission、same bubble、one terminal 和 release/drain:[message journey](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/a2a-protocol.md#L19-L29)。完整批准文档还规定 durable enqueue commit 后才 `requestDrain`,admission transaction commit 后才调用 Agent Client:[七步主线](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/message-delivery-handling-handoff-audit.md#L87-L99)。

这里有三个关键 cutover:

| cutover | durable fact | 之后才允许的 side effect |
|---|---|---|
| enqueue commit | input 可恢复且有序 | signal/request drain |
| admission commit | exact targets、input/bubble、owner binding 已固定 | 建立 live client/run |
| terminal commit | bubble、owner disposition、合法 successor 已闭合 | 释放 live run并继续 drain |

任何 side effect 提前都会留下无法解释的状态。例如先启动 provider、后写 admission,进程在两者之间退出时,系统无法判断该不该重放;先释放 active run、后写 terminal,下一条 work 可能与旧 callback 同时占用同一责任。

### 3.3 strict head 是可解释性选择

上游目标不是“扫描全部 entry,挑一个现在能跑的”,而是只检查 comparator 的 exact head。head target 忙就等待,不越过它偷跑后项;drain 由 enqueue、terminal、reorder、recovery 等真实变化触发,dirty bit 处理 drain 中途到达的事件。[ordering/drain](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/a2a-protocol.md#L31-L39)

好处:

- replay 后顺序容易证明。
- Queue Panel 与实际执行顺序一致。
- 不需要为“为什么后项先跑”维护第二套解释。
- 可以锁住不变量:不存在“queue 非空、head 可执行、无 active run、无 drain”的稳定状态。

代价是 head-of-line blocking。本项目可以先采用 strict per-thread head,但应把它标成可被真实使用证据推翻的调度策略,不是永恒公理。

## 4. Routing:结构化 target 是协议,mention 是输入语法

### 4.1 `targetCats` 与 `@mention` 不是同等级信号

当前 Clowder callback schema 直接暴露 `targetCats`;cross-thread structured action 还要求 exact `clientMessageId` 和 target cardinality,不满足就 fail closed。[structured target validation](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/mcp-server/src/tools/callback-tools.ts#L1388-L1437)

文本路径则解析行首 mention:

- 先剥 fenced code block。
- 使用 registry 中的 mention patterns,最长匹配优先。
- 每个 match 当场调用 resolver 重验 target availability。
- disabled/missing target 进入 typed `routing_warnings`。
- inline action mention detector 只做 write-side feedback,明确 `NOT for routing`。

源码:[`analyzeA2AMentions`](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts#L79-L157),[inline detector boundary](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts#L160-L169)。

对本项目的结论:

```text
TUI structured send / teammate tool call -> targetAgentIds
human free text                       -> mention parser fallback
both                                  -> same target resolver -> same enqueue API
```

`@mention` 不应是 durable routing truth。保存解析后的 stable `AgentId[]`,同时保留原文作审计/展示。agent rename 后不能重新解析旧正文得到不同 target。

### 4.2 enqueue intent 必须在 admission 重验

target 在 enqueue 时可用,不代表 dispatch 时仍可用。成员可能被 disable、配置被删、owner generation 已变化、structured fence 已终局。目标架构因此把 enqueue target 叫 intent,在 client effect 前重新验证。

fallback 规则也很窄:

- 只适用于没有 target 的 public head。
- 只在 thread 没有 Active Run 时使用。
- 先选最近 `completed` response 的成员,再选 server default。
- 显式 target、private input、structured work 永不 fallback。
- exact target 失败产生 typed failure/diagnostic,不悄悄换人。

来源:[fallback contract](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/a2a-protocol.md#L41-L45)。

个人 harness 初版甚至可以更简单:没有 target 就交回当前 active teammate或要求用户选择;关键是**有显式 target 时绝不 silent fallback**。

## 5. Delivery、exposure、handled 与 responsibility

### 5.1 admission 不等于 agent 看过正文

目标协议明确说“Processing”只表示 server-side execution live,不表示 agent 已读正文;body exposure 和 handled 各有自己的 owner。[participant visibility](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/a2a-protocol.md#L60-L64)

当前代码已经为这种分离付出明确字段:

- `queuedAwakenedInvocationIdByCatId`:exact child 已建立,但 prompt body 未必 exposure。
- `queuedSeenInvocationIdByCatId`:哪个 exact invocation 读了 queued body。
- `queuedBodyExposures`:append-only exact exposure witnesses。
- `queuedFailedByCatIds`:读过的 invocation 失败,责任仍在 queue。
- `queuedHandledByCatIds`:某个 target 的历史 closure。

这些字段集中出现在 [`QueueEntry`](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts#L25-L69)。字段很多不是本项目应该复制的理由;它们证明“awakened/seen/failed/handled”不能用一个 `processing` 代替。

### 5.2 responsibility terminal 由责任 owner 提交

普通对话可以在 successful run terminal 时自动视作 handled,但 review、approval、wait、action successor 等结构化责任不能从一段自然语言或 process exit code推断完成。delivery kernel 只负责 exact input -> target -> result 这一跳;上游 owner用自己的 predicate提交 disposition。

因此本项目应保留两个层次:

```ts
type InvocationTerminal =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"

interface ResponsibilityReceipt {
  deliveryId: string
  kind: "handled" | "delegated" | "declined"
  evidenceRef?: string
}
```

第一层回答“这次 run 怎么结束”;第二层回答“这条责任是否闭环”。Phase 2.5 可以只让普通 peer message 自动生成 `handled`,但类型上不要把二者焊死。

## 6. Exact invocation 与 typed terminal

### 6.1 callback principal 绑定 exact run

当前 `InvocationRegistry` 的安全契约不是“这个 cat 最近有一个调用”,而是 `invocationId` exact 绑定一个 child `TurnExecution` attempt 和 callback token;记录同时保存 owner auth provenance、server-resolved work binding、cat、thread、parent/trigger ids 与 lifecycle state。[registry contract](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts#L1-L57)

terminal disposition 是 typed union:

```text
completed | failed | interrupted | replaced | revoked | canceled
```

同一 terminal commit 返回 `committed | already_terminal | not_found`;不同 disposition 的重放会发出 conflict signal,而不是覆盖旧结果。[terminal types](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts#L59-L90),[commit conflict](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/invocation/InvocationRegistry.ts#L301-L311)。

本项目不需要 callback token/Redis backend,但必须保留这三个性质:

1. terminal 绑定 exact `invocationId + attempt/generation`。
2. terminal 是吸收态;重复同结果幂等,冲突结果可诊断。
3. late delta/callback 不能更新新一代 run。

### 6.2 `interrupted` 是恢复结论,不是 live callback

正常 client callback 只有 `completed / failed / canceled`;`interrupted` 由 startup recovery 在 admission 已 durable、live client 已消失时合成,沿 failure-like 分支收敛。partial streamed output 保留在同一个 response bubble,不替换成一条脱离上下文的 generic error。[terminal/recovery](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/docs/architecture/a2a-protocol.md#L47-L50)

这对文件实现尤其重要。启动时看到 `claimed/` 文件不能直接搬回 `queued/`;应先为旧 attempt 写 `interrupted`,再根据 retry policy 创建新 attempt。否则历史上同一个 invocation 会看起来执行了两次却没有中断证据。

## 7. 当前实现:部分迁移,不要照抄类图

### 7.1 `InvocationQueue` 仍是 process-local projection

当前类直接持有:

```ts
private queues = new Map<string, QueueEntry[]>()
```

源码:[`InvocationQueue` storage](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts#L235-L269)。`enqueue()` push 进数组,`peek/dequeue/remove` 直接操作该数组:[enqueue](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts#L318-L436),[peek/dequeue](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts#L502-L531)。

它还承担 idempotency、priority、merge、fan-out fence、steer reservation、seen/handled projection等大量迁移期职责。对本项目的启示不是“也写一个 2000 行 Queue class”,而是:

- durable record先定义。
- process-local index/cache可从 durable record恢复。
- queue selection与 lifecycle transition分开测试。
- 不让 UI 或每个 teammate 自己持有第二份 queue truth。

### 7.2 durable custody 依附在 message store

`StoredMessage` 当前携带 `deliveryStatus`、`queueCustody` 和 crash-recoverable `queueCustodyAdmission`。[stored fields](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/stores/ports/MessageStore.ts#L386-L397)

store port提供三类关键操作:

- `initializeQueueCustodyAdmission`:process-local carrier staging 前先写完整 fan-out recovery intent。
- `initializeQueueCustody`:为 legacy queued message初始化 custody。
- `transitionQueueCustody`:带 `expectedRevision` 的 custody transition,terminal delivery在同一 operation提交。

来源:[store contract](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/stores/ports/MessageStore.ts#L763-L790)。内存实现也真的检查 revision mismatch并在同一 transition中更新 `deliveryStatus/deliveredAt`:[CAS implementation](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/stores/ports/MessageStore.ts#L1815-L1844)。

### 7.3 coordinator 在 durable custody 与 local queue 之间对账

`QueuedMessageCustodyCoordinator.persistEntry()` 将 process-local entry的状态投影回每条受管 message;transfer/recovery以 `MessageStore` CAS作为 linearization point。[persist/transfer](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts#L1309-L1378)

fan-out recovery更能说明边界:先把完整 admission intent持久化,再为每个 accepted target重建独立 process-local carrier。[rehydrate fan-out carriers](https://github.com/zts212653/clowder-ai/blob/090626a538d59e2b6ce3c3ba9b205b57d958fcdd/packages/api/src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.ts#L742-L819)

这套实现已经具备恢复证据,但 canonical queue尚未收敛成批准架构里的独立 durable `Queue Entry`。因此报告采用下面的准确表述:

| 层 | 当前事实 | 不应误述为 |
|---|---|---|
| `InvocationQueue` | process-local selection与执行 projection | durable queue本体 |
| `MessageStore.queueCustody` | durable body custody/attempt/revision事实 | 完整 conversation lifecycle |
| `InvocationRegistry` + turn store | exact principal与terminal事实 | teammate identity或session truth |
| UI enrichment | 从上述事实派生 receipt/row | canonical lifecycle owner |

## 8. 对本项目的最小映射

### 8.1 建议的 durable records

Phase 2.5 不需要移植 Clowder 对象全部字段。最小形状可以是:

```ts
interface TeamMessage {
  id: string
  threadId: string
  from: { kind: "user" | "agent" | "system"; id?: string }
  targetAgentIds: string[]
  body: string
  createdAt: string
}

interface Delivery {
  id: string
  messageId: string
  targetAgentId: string
  state: "queued" | "admitted" | "terminal"
  attempt: number
  invocationId?: string
  terminal?: "completed" | "failed" | "cancelled" | "interrupted" | "rejected"
}

interface BodyExposure {
  deliveryId: string
  invocationId: string
  exposedAt: string
}

interface ResponsibilityReceipt {
  deliveryId: string
  outcome: "handled" | "delegated" | "declined"
  evidenceRef?: string
}
```

`ActiveInvocation` 保持 process-local,但 durable `Delivery` 要能证明哪次 attempt 曾被 admission。详细字段与 TUI projection 建议见 [peer-agent-team-tui.md](./peer-agent-team-tui.md)。

### 8.2 文件实现的 admission cutover

本项目可以用单进程 + 文件实现相同语义:

```text
1. write TeamMessage + queued Delivery to temp
2. atomic rename publishes durable facts
3. one scheduler requests/drains strict head
4. atomic transition records admitted attempt + invocation id
5. prompt assembler records BodyExposure
6. agent emits stream events; transcript is projection/output
7. append exact terminal, then release local invocation
8. request drain again
```

若采用目录表达状态,`rename()` 只负责 claim/admission的原子切换:

```text
inbox/queued/<delivery-id>.json
  -> inbox/claimed/<delivery-id>.<invocation-id>.json
```

它不能证明 exposure、handled或terminal。terminal必须是独立持久事实;启动扫描 `claimed + no terminal` 时先写 `interrupted`,再按 policy重试。

### 8.3 一个 scheduler,所有入口汇合

唯一允许的入口链:

```text
human text / structured send / teammate output
  -> resolve explicit target or mention fallback
  -> persist TeamMessage + Delivery
  -> requestDrain(thread)
  -> one scheduler admits exact head
```

禁止三条捷径:

- TUI直接 `agent.prompt()`。
- mention parser直接启动 target。
- teammate自己扫描 inbox并各自抢占 lifecycle truth。

这样 headless `--json`、TUI和未来其他 client只生产同一种 command,不需要复制调度逻辑。

## 9. TUI 应怎样表达这些事实

Clowder 的 UI 价值不是头像样式,而是 visible state不能越权:

| UI 文案/标记 | 可由什么事实支撑 | 不能暗示什么 |
|---|---|---|
| Queued | durable Delivery存在且未 admission | agent已看到正文 |
| Starting | admission已提交,local client正在建立 | provider已接收正文 |
| Running | exact ActiveInvocation live | responsibility必然会完成 |
| Seen/Exposed | exact BodyExposure witness | handled |
| Completed | exact invocation terminal completed | structured responsibility已满足 |
| Interrupted | startup reconciliation的typed terminal | 自动重试已成功 |
| Needs input | exact pending request id | 整个 teammate“坏了” |

Queue Panel row、History bubble、dashboard agent row是三个不同 projection:

- Queue Panel回答“哪些输入等待 admission”。
- History回答“哪些消息已进入共享 timeline,对应结果是什么”。
- dashboard回答“哪些 teammate/session/run当前需要监督”。

不要为了减少 UI component把它们压成同一个列表;也不要为了显示方便把 projection status写回 canonical record。

## 10. 明确不迁移

Clowder 是 API server + Redis + web UI + connectors + MCP callback + structured responsibility platform。个人 Bun harness 当前不需要:

- Redis/Lua和跨 API 实例协调。
- web/connector message visibility矩阵。
- callback token、agent-key和HTTP outbox。
- action successor、wait carrier、approval index的完整领域模型。
- 每个历史 feature的兼容字段与 migration path。
- Clowder 的 cat命名、UI投影和业务 vocabulary。
- 将 Queue custody塞进 chat message的当前过渡类图。

值得迁移的是窄机制:

- stable ids + exact attempt/generation。
- structured target first,mention fallback。
- single admission owner + strict head。
- durable-before-effect与terminal-before-release。
- body exposure/handled/responsibility分离。
- typed absorbing terminal + startup reconciliation。
- projection无写权。

## 11. 必须锁住的契约测试

### Admission 与 ordering

- [ ] enqueue commit前不会启动 agent。
- [ ] 同一 thread只有一个 drain owner。
- [ ] strict head busy时后项不会越过。
- [ ] admission crash后能判断是 queued、admitted还是证据不足,不会猜。
- [ ] queue非空、head可执行、无 active run时最终必有 drain。

### Target 与 delivery

- [ ] explicit target在admission前重验。
- [ ] explicit/private target失败产生typed rejection,不fallback。
- [ ] rename teammate后旧message仍指向原stable id。
- [ ] text mention和structured send进入同一enqueue path。
- [ ] fan-out每个target有独立Delivery/Invocation terminal。

### Exposure 与 responsibility

- [ ] admitted但未exposed可单独构造和显示。
- [ ] exposed invocation failed后responsibility仍可pending。
- [ ] terminal completed不会自动关闭需要typed predicate的review/approval。
- [ ] projection落后或重放不能改canonical truth。

### Terminal 与 recovery

- [ ] 同一attempt重复相同terminal幂等。
- [ ] 同一attempt冲突terminal被拒并留下diagnostic。
- [ ] 旧generation delta/terminal不能污染新run。
- [ ] streaming中崩溃保留partial output并写interrupted。
- [ ] terminal durable后才释放exact local run并drain下一条。

## 12. 风险与未定案项

| 问题 | 当前判断 | 何时定案 |
|---|---|---|
| strict head是否过度阻塞 | 初版最可解释 | 真实Phase 2.5 usage显示持续HOL blocking后再改 |
| durable log分片方式 | 单文件与per-thread均可 | 先定写入原子性、恢复和compaction需求 |
| interrupted自动重试 | 不能全局统一 | 按source/effect class定policy |
| exposure是否首版持久化 | 建议持久化exact witness | ADR里权衡磁盘写放大 |
| responsibility receipt范围 | 普通message可自动handled | review/approval接入时扩展typed owner |
| fan-out上限 | 必须有,数值未定 | Phase 2.5施工图 |

最大的实现风险不是少一个状态,而是让两个组件都认为自己拥有 admission或terminal。最大的产品风险则是UI用一个顺眼的“done”掩盖了run结束与责任完成的差异。

## 13. 最终判断

Clowder 已经提供了 peer-team最难的一部分参考答案:如何让一条消息从排队、被接纳、进入context、产生结果到责任闭环都能指出唯一 owner,并在失败/重启后解释发生过什么。

本项目应采用其收敛后的 delivery invariants,但实现得更小:

- durable files而非Redis/API平台。
- one process-local scheduler而非分布式协调。
- stable teammate/session/delivery/invocation ids。
- explicit structured target优先,mention仅作人类输入fallback。
- exact terminal与reconciliation先于dashboard美化。

Phase 2.5 开工前应先把这些边界写成ADR和纯函数 reducer测试。若先从 inbox目录或dashboard row开始,很容易重建Clowder正在收敛掉的同一类双重真相问题。
