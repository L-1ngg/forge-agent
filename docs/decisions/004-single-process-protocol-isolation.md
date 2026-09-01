---
doc_kind: decision
created: 2026-09-01
---

# ADR-004: 单进程架构 + 协议隔离

> 状态:已批准(2026-09-01,operator 发起;起草于 2026-08-31,编号后补故日期晚于内容)
> 参与者:operator(发起)、Grok(分析)

## 背景

clowder-ai 用「服务端 + 网页界面 + Redis」的分布式架构实现了核心与界面的物理分离。代价:Redis 快照空档丢数据(28 秒,307→144 keys)、进程管理、Lua CAS 并发控制(单用户场景防的是不存在的并发)、Mission Hub 运维面板——每一层基础设施都在解决上一层制造的问题,而不是用户的问题。详见 [design-rationale.md](../design-rationale.md) C.4、[cat-cafe.md](../cat-cafe.md) F.1。

本项目需要回答:如何在不做分布式的前提下,让核心与界面之间的边界同样牢固?

## 决策

**核心与界面逻辑分离,物理同进程。**

1. `protocol` 包定义 `SessionEvent` 联合类型与 `RequestEnvelope`/`ResponseEnvelope` 信封,作为核心与界面之间的唯一通信协议。Phase 1 已落地。
2. `core` 不 import `tui`,`tui` 只 import `protocol` 与 `pi-tui`;CI 用 `check-deps.ts` 强制。Phase 1 已落地。
3. headless 模式(`--json`)作为边界腐烂探测器,持续证明 core 没有 UI 泄漏。Phase 1 已落地。
4. 多 agent 协作(Phase 2.5)同样 in-process:一个进程里 N 个 `Agent` 实例,靠 async 并发。

**被否方案:clowder 式物理分离(服务端 + Redis + 独立进程)。** 否决理由:单人单用户场景下,分布式基础设施解决的是不存在的并发问题,引入的是真实存在的运维和持久化风险。

**以后加网页版的路径:** core 包一层 server(Unix socket / WebSocket),协议层和 UI 组件不动,终端和网页是两个客户端。

## 后果

**变容易的:**

- 多 agent 协作:agent 之间直接调函数,dashboard 直接读内存对象
- 调试:单进程,一个堆栈
- 无 Redis / daemon / 消息队列的运维负担

**变难的 / 需要纪律守住的(三条规矩,Phase 2.5 第一行代码之前必须定):**

1. **工具一律取显式 cwd**,不读 `process.cwd()` —— clowder 的 HOME 隔离方案 6 个 commit 全部回退,根因修复只有两行:问题不在隔离方案不够强,在不该读全局状态
2. **env 走 per-agent context**,不碰全局 `process.env`
3. **不设模块级可变单例** —— Bun 模块缓存共享,模块内部有可变状态会导致所有 agent 看到同一个实例

**已接受的风险:**

- 一个 agent 崩溃会带走整个进程。agent 之间是协作关系,单点故障可接受;真需要硬隔离时单独拆子进程

## 出处

- 详细论证:[design-rationale.md](../design-rationale.md) C.3(in-process 多 agent)、C.4(协议边界与演进路径)
- 失效模式证据:[cat-cafe.md](../cat-cafe.md) F.1(Redis 数据丢失)、F.2(双执行入口、并发上限)
- 实现:[plan.md](../plan.md) §1 架构与依赖方向
