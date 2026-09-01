---
doc_kind: decision
created: 2026-09-01
---

# ADR-002: request 总线用双向事件流,不用 `Promise<Decision>`

> 状态:已批准(2026-09-01,operator 要求补记)
> 参与者:operator(发起)、Claude(起草)

## 背景

阻塞式交互(permission / cancel_confirm / question / plan_approval / oauth)必须由 `core` 发起、由 UI 应答。[design-rationale.md#L323](../design-rationale.md) 把它标成 **最高风险项**,并在 [#L336](../design-rationale.md) 给了唯一一条这种级别的警告:

> ⚠️ **这一条 Phase 2 写错,Phase N 就是把整个 permission 流水线拆一遍。** 唯一「现在不做、以后一定后悔」的项。

同一节 [#L328](../design-rationale.md) 给出了目标形状 —— 带 id 的信封,而不是函数调用:

```
core → { type: 'request',  id: 'r7', kind: 'permission', payload: {...} }
UI   → { type: 'response', id: 'r7', result: { decision: 'allow_always', scope: ... } }
```

并且明确 pi 的 `ctx.ui.confirm()` 属于**被否的那一种形态**:pi 的 hook 只能当触发点,总线要在 `core` 里自己做。

Phase 2 把这条落成 M1([phases/phase-2.md#L62](../phases/phase-2.md)),要求它最先做、单独合入。决策必须在写代码前定下来,因为协议是本项目唯一不可回退面([phase-2.md#L279](../phases/phase-2.md))。

## 决策

总线实现成**双向事件流**:request 出、response 入,两条 async iterable。

契约(M1 的真正交付物,不是那几十行实现):

1. id 由 `core` 分配,全局唯一,不复用。
2. 每个 request 恰好一个终态:`response` | `cancelled` | `timeout`。
3. 迟到 / 重复 / 未知 id 的 response 一律丢弃并记录,不报错、不生效第二次。
4. turn 被 abort 时,在飞的 request 自动 `cancelled` —— 决策语义是 **deny**,不是「继续等」。
5. UI 是唯一响应者;`core` 不持有任何 UI 引用。
6. 五种 kind 一次定全,不留「以后再加」。`plan_approval` 的消费者在 Phase 3,形状现在定;`oauth` 是最容易漏的第五种(`pi-ai` 用本地回调端口等浏览器跳转,同样是阻塞式交互)。
7. headless 五种 kind 各有确定行为,**默认全部 deny + 稳定退出码**,不做隐式降级。

被否方案:

| 方案 | 否决理由 |
|---|---|
| `Promise<Decision>` 风格的直接调用(`await ui.confirm()`) | 在 in-process 下更短,但把「谁是响应者」编译期绑死。以后换 socket / web UI 是**重写**而非替换实现([design-rationale C.4](../design-rationale.md) 演进路径) |
| 引入通用 RPC 库 | 五种 kind、单进程、单响应者。引一个库来传五个信封是过度工程(同 Phase 1 对 dependency-cruiser 的判断) |

## 后果

- **变容易**:换传输层(socket、web UI)只替换两条 iterable 的两端,`core` 不动。第二个客户端不需要重新设计 permission 语义。
- **变难**:`core` 内部要自己维护 pending map + 超时,约多 50 行。调用点从 `await confirm()` 变成 `await bus.ask(...)` —— 形状仍是 await,可读性损失有限。
- **不可回退面**:M1 定的五个 kind 一旦合入,后续只许加字段不许改形状。
- **安全语义**:降级方向恒为 deny(abort → cancelled → deny;headless 默认 deny),不存在隐式 allow 路径。
- **需要同步的文档**:[phases/phase-2.md](../phases/phase-2.md) M1(已含本决策);[plan.md](../plan.md) Phase 2 行动项「request 总线」条目引用本 ADR 即可,不复制理由。
