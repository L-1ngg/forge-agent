---
doc_kind: decision
created: 2026-09-08
---

# ADR-015: 移植并本地维护 Pi Agent Core

> 状态:已批准(2026-09-08)。operator 已确认规格及配置时序并授权按 #15–#26 实施；正式需求见 [Spec #14](https://github.com/L-1ngg/forge-agent/issues/14)，源码基线及接入证据见[迁移验收](../phases/pi-core-migration-acceptance.md)。
> 参与者:operator、Codex。

## 背景

operator 在 2026-09-08 调研后明确：

> 我的想法是用源码先复现pi agent的core，后续我再在此基础上进行改动

随后进一步限定范围：

> 我只是希望agent内核复制pi core，其余的东西比如CLI/TUI本项目依旧保留。
> 但是如果有涉及到接口改动，你也可以进行对应的更改。
> 本轮目标是迁移和拥有足够清晰的接口。因此只要是pi设计优秀的可以考虑

因此，工作方向是从固定上游源码建立本地拥有的 Core 基线，再完成项目接入。旧 SDK 的方法名、类型和封装层可以调整，不能为了保留旧接口逐项重写上游循环。基础事实见[上游研究](../research/pi-core-upstream-semantics.md)与[接入研究](../research/pi-core-integration-surface.md)。

## 决策

1. **来源与所有权。** 复制标准 Pi 使用的 `Agent`、`agent-loop`、相关类型与必要依赖闭包，保留源码来源、固定 SHA 和 MIT 许可。生产执行循环由本仓库维护，不仅在外面包装 npm 的 `pi-agent-core`。不将源码派生描述为原创算法。
2. **先基线，后接入定制。** 首个独立基线保留上游结构、签名、状态和运行语义；必要路径/构建适配逐项记录。基线验证后，再接入 Forge。任何必须修改 Core 的接入要求均形成独立、可追溯改动，不污染“原样复现”的判据。
3. **保留本项目应用。** CLI/TUI、终端展示、输入交互与 headless 入口继续由 Forge 拥有；协议和调用点可随迁移修改，最终共同使用同一执行路径。Core 不依赖 CLI/TUI。
4. **以接口清晰为准。** 采用 Pi 的生命周期、结构化工具结果、进度回调、hooks、状态归约与上下文投影顺序。移除被替代的循环和仅为旧实现存在的转发层；不同时维护两套等价状态、工具类型或生产执行器。SDK 保留 Forge Agent 名称、`@forge-agent/core` 包、`@forge-agent/core/sdk` 接入入口与 `createAgent`；返回对象、方法参数和事件可以调整，宿主无需改用 Pi SDK。外部 SDK 不必复制每个 Pi 类型，也不要求机械兼容旧 Forge 签名。
5. **会话策略独立。** 已完成的上下文/usage/存储实现由会话层承接；优先使用上游已有 `subscribe`、`transformContext`、`convertToLlm`、`prepareNextTurn` 等接缝。普通任务重试属于会话策略，不能为获得它整体搬入 Pi 应用层。
6. **已有行为合同继续作为输入。** 允许接口变化不自动撤销 ADR-010/014 的输入归属、取消、可靠落盘与上下文选择。若接入需要改变这些行为，设计须点明场景及影响；优先在外层承接，必要的 Core 定制排在原样基线之后。
7. **工具接口与工具功能分别验收。** 原生 content/details/update、准备与执行签名属于迁移接入范围。复制整个 coding-agent 工具实现、改变 bash 默认超时或迁入 edit 新功能，不因“Pi 设计优秀”自动成为本轮必做项；只有接入必需或另行选定时才实施。

建议基准沿用上下文工程的 `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`。新 AgentHarness 是另一条运行时，不属于标准 Agent Core 复制范围。Pi 扩展加载器、应用资源管理和 UI 也不随本次 Core 移植进入本仓库。

## 替代关系

本 ADR 修订 [ADR-009](009-self-owned-agent-core.md) 对“自行实现”的含义：执行实现由本地拥有和维护，初始源码来自 Pi；不再以现有 ExecutionCore 算法为必须保留的基线。保留 pi-ai、单 Agent、无永久双引擎等原则。

[ADR-004](004-single-process-protocol-isolation.md) 的 Core/界面隔离、[ADR-008](008-general-agent-positioning.md) 的通用定位及 ADR-010/014 的行为约束不由本草稿整体替代。对协议类型、SDK 签名和 pi-ai import 门禁的必要调整，应以施工设计列出的调用链为依据。

## 备选与后果

| 选择 | 取舍 |
|---|---|
| 在现有 ExecutionCore 上逐项模仿 Pi | 难以得到清晰的同源基线，不符合 operator 先复制源码再定制的要求 |
| 直接依赖上游 pi-agent-core | 维护循环的成本较低，但不满足本次把实现源码纳入本项目的选择 |
| 整体复制 Pi coding-agent | 会连带替换会话/资源/应用层，超出保留 Forge CLI/TUI 的 Core 迁移范围 |
| 先移植核心，接入改动独立记录 | 可验证上游等价及本地差异；本项目承担后续源码同步责任 |

施工设计见 [Pi Core 源码迁移](../phases/pi-core-migration.md)，正式规格及子任务见 [GitHub #14](https://github.com/L-1ngg/forge-agent/issues/14)。规格发布时尚未修改运行代码；当前实现与验证见[迁移验收](../phases/pi-core-migration-acceptance.md)。

## 会话能力范围确认

2026-09-08，operator 在了解普通任务重试的含义及两项任务已经发布后回复“我认可”，确认 [#22 普通任务重试](https://github.com/L-1ngg/forge-agent/issues/22) 与 [#23 运行时配置更新](https://github.com/L-1ngg/forge-agent/issues/23) 纳入本轮。两者属于 Core 之外的会话接入能力，不再作为待选范围重复询问；具体契约及验收继续以对应 Issue 为准。本记录确认范围，不声明代码已实现。

同日 operator 进一步回复“确认”，选定配置更新时序：空闲时应用；执行中接受更新，当前模型响应及其整批工具继续使用原配置完成，在下一轮模型请求前应用新配置。SDK 区分“已接受”和“已生效”，已启动工具不替换或重放，生效后旧 usage 依据按已有规则失效。验收以 #23 为准，不再将活动执行中一律拒绝作为候选方向。
