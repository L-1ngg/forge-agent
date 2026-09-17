---
doc_kind: decision
created: 2026-09-13
---

# ADR-018：统一上下文压缩，移除旧策略

> 状态:已批准(2026-09-13)。operator 明确要求“启用这个改良的策略，我不需要你保留兼容性”。
> 命名更新(2026-09-17)：operator 要求功能与代码统一称为上下文压缩。下文 `adaptive` 是当时的历史名称，当前接口以 SDK 指南为准。

## 2026-09-17 命名统一

功能统一称为“上下文压缩”(Context Compaction)，取消当前代码和接口中的策略别名。实现入口为 `context/compact.ts`，持久化检查点及 SDK 类型分别为 `checkpoint`、`CompactionCheckpoint`；`compaction` 事件移除只有一个取值的 `strategy`，保留实际动作与预算指标。压缩选择、模型提示、预算与恢复规则不变。

旧 v4 会话的 `adaptive` 字段只在读取边界转换为 `checkpoint`，继续验证来源与状态替代关系，不重写原始文件。新记录只写 `checkpoint`；不保留旧 SDK 类型别名。历史实验 JSON、源码快照和已发布文档路径保留原名；当前基准使用 `compaction` 标签，报告器可读取旧标签但禁止混合不同命名的运行集。

验收覆盖当前检查点写入与重开、旧字段恢复及损坏拒绝、事件和 SDK 类型、当前/历史实验报告，并运行仓库全套检查。仅做命名调整，不重新执行付费模型质量评估。

本次验证：

- `bun run check` 通过：依赖边界、各包及自动化类型检查、585 tests passed / 0 failed（80 files），包含 Linux PTY 压缩及会话恢复。
- `bun run typecheck:examples`、`bun run test:headless`、`git diff --check` 和本次修改文档的本地链接目标检查通过。
- 定向压缩/报告测试 40 pass / 0 fail；临时移除旧字段转换后，新格式恢复通过、旧格式恢复按预期失败，随后恢复转换并通过全套检查。旧文件原文不变、追加新字段后重开、无效版本/来源及双字段冲突均有覆盖。
- 未运行付费模型质量/费用评估或 macOS/Windows 验证；本次不改变压缩算法、提示词和预算公式，不新增上述质量及平台结论。

## 决策

替代 ADR-017 中默认 pi、adaptive 必须显式启用的选择。CLI 与 SDK 均统一使用 adaptive，包括短检查点、相关性裁剪、search_context/read_context、预算与有限重建。空的 context 对象使用增强策略；不再支持 strategy 配置，传入该字段明确报错。实际项目配置也启用自动压缩，避免仅改源码而运行配置未生效。

不为旧行为维持默认或自动回退：已有 pi 摘要的会话由 adaptive 从原始分支历史构建请求，不把旧摘要当作完整任务状态。预算不足或提取失败仍明确停止，不降级为旧策略放行。operator 随后明确授权删除旧策略和旧测试：移除 pi 压缩实现及 context.strategy 配置入口，仅保留 adaptive 执行路径。旧策略专属测试删除；通用 provider、恢复、存储和工具合同转为覆盖 adaptive。旧会话原文保留，历史验收文档仅作为历史证据。

默认输出预留和保留工具名随 adaptive 合同生效。原本依赖 pi 的宿主需要移除 strategy 配置，并接受不同输出上限或工具定义，这是本次明确接受的行为改变。原始会话记录和凭据不删除、不重写迁移；正在运行的 CLI 需重启才能加载新源码及配置。

## 验证

从公开 SDK 验证省略策略时工具定义含 search_context/read_context、默认输出上限生效、预算不足时停止发送；从配置加载与 CLI 装配验证当前项目启用。删除原 pi 专项回归，通用回归覆盖唯一的 adaptive 路径。完成相关回归、全套检查、SDK 中英文/README 同步与两轴审查。

策略默认值改变不代表新短投影已完成真实模型总费用/质量复验；该未测项仍按后续验证记录保留。

## 默认切换阶段验证结果（2026-09-13，删除旧策略前）

- `bun run check`：依赖边界、各包与自动化类型检查通过；574 tests passed，0 failed（75 files）。其中默认 SDK 请求包含两个历史工具与 4096 输出上限；省略/空 context、部分配置更新、预算拒绝、旧 pi 会话恢复与 PTY 手动压缩均有回归覆盖。
- `bun run typecheck:examples`、`bun run test:headless` 与 `git diff --check` 通过。
- 使用生产 `loadConfig({ cwd: process.cwd() })` 读取当前项目配置，仅输出 context：`strategy: "adaptive"`、`enabled: true`；与源码默认一致。配置文件被 Git 忽略，不纳入提交。
- 规范与规格两轴审查已完成：默认值重复与通用图片测试绕过默认路径的发现均已修正并复核。
- 未运行：新短投影的真实模型质量与总费用复验、macOS 平台验证；本次使用本地受控 provider 与 Linux PTY，不能据此声明上述未测项通过。未重启用户已有 CLI 进程；下次启动加载本次默认与配置。

## 删除旧策略的验收范围

移除 pi 的切点选择、两段摘要模板/生成、请求投影及策略分支；移除 `context.strategy`，SDK 创建和空闲配置更新均拒绝该旧字段。当前 ignored 配置只保留自动压缩开关。通用生命周期测试迁至 `compaction-lifecycle.test.ts`，provider 参数/重试/图片/超限恢复继续覆盖唯一执行路径。

Provider 的 error/aborted 响应在临时重试策略结束后直接停止，不以检查点重建重复发送鉴权或额度错误；来源/结构校验失败仍可有限重建。基准 runner 只调度 adaptive，单策略报告要求全部任务 completed，不以空 pi 对照组放宽门槛；历史双策略记录与证明保持历史证据身份，复算使用原提交。

## 删除后验证结果（2026-09-13）

- `bun run check` 通过：依赖边界、各包/自动化类型检查、550 tests passed / 0 failed（75 files）。测试数量减少来自删除旧 pi 专项测试；通用生命周期、provider、存储、TUI 和 adaptive 合同继续保留。
- `bun run typecheck:examples`、`bun run test:headless`、`git diff --check` 通过。
- 生产 `loadConfig` 当前读取到 `context: { enabled: true }`；策略已由唯一的 adaptive 路径提供，不需要 selector。
- 鉴权/额度单次请求、503 重试开关、单策略报告拒绝未完成任务均先复现失败再修复通过；规格/规范复核无未关闭发现。
- 本次未运行付费模型基准或 macOS 验证，不新增真实模型质量/总费用结论；未重启用户已有进程。提交与推送状态以 Git 记录为准。
