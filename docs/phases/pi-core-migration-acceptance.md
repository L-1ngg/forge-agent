---
doc_kind: plan
created: 2026-09-08
---

# 本地执行内核接入验收

> 状态:已完成，operator 已在 WSL 验收并授权推送与关闭对应 Issue(2026-09-08)。范围与 AC 定义归 [Spec #14](https://github.com/L-1ngg/forge-agent/issues/14) 及 #15–#26；施工接合见[迁移设计](pi-core-migration.md)。本地提交不代表远端 Issue 已关闭或版本已发布。

## 源码与版本

- 实施起点：`34a5ebff17bbc77606c31c728f98a079de140ea2`。
- 原样源码基线提交：`3b4d961c384254e04168bfdc80a7a952db71d66a`。来源 `earendil-works/pi@9767ba275f3e9a5ee0f5c5342249b629ab1b2282`；必要四文件、SHA-256 与 MIT 许可见 [runtime](../../packages/core/src/runtime/README.md)。测试也来自固定上游。
- 模型适配锁定 `@earendil-works/pi-ai@0.85.1`，`typebox@1.3.7`，Bun `1.3.12`。Forge workspace 包版本仍 `0.1.0`，私有 Bun SDK；会话仍 v4。版本号不是旧宿主源码兼容承诺，工具 execute 返回值已变更。
- 接入后仅添加 `shouldStopAfterResponse` 可选 Core 接缝；默认上游行为继续作差分。Forge 启用后的 length/deferred 及取消记录边界见 [local-changes](../../packages/core/src/runtime/local-changes.md)。普通任务 retry、持久化和配置策略位于会话层。
- Responses 0.85.1 补丁从对应 npm 发布文件重建；未复用 0.84.4 的旧行号。completed/incomplete/failed/missing 通过真实本地 HTTP 终态测试。

## 验证索引

以下索引引用 AC，不另定义验收清单。所有 HTTP 均为回环地址，工具仅操作测试临时目录。

| 父规格覆盖 | 可复现证据 |
|---|---|
| AC-MIG-01/02 | `bun test packages/core/test/runtime`：45 项固定上游测试；`bun scripts/compare-core.ts <fixed-checkout>`：独立基线编译后的 JS 与原版一致，当前默认 Core 与原版 25 组差分，仅归一化 timestamp |
| AC-MIG-03/09/10 | `bun run check:deps`；SDK/CLI 默认 `createPiPort → AgentSession → runtime/Agent`；旧执行器与权限转发桥删除；`bun run typecheck:examples`；中英文 README/SDK 升级说明 |
| AC-MIG-04 | `runtime-session`、`session`、`sdk`、`input-ownership`、`incremental-session`、`tests/loop-contract/owned-core`：消费归属、慢/失败保存、未启动取消、释放等待、多实例隔离、禁止不确定效果重放 |
| AC-MIG-05 | `runtime-context`、`compaction`、`input-ownership`：阈值与工具续轮、完整历史、手动摘要、禁用自动、usage、overflow/length 单次恢复；`runtime-configuration` 覆盖摘要期间更新 |
| AC-MIG-06 | `runtime-tools`：串行准备/授权、并行/串行效果、拒绝/异常/terminate、进度、图片与 details 文件重开、坏结果等待兄弟工具；`runtime-retry`：工具后 529、取消与 2/4/8 秒退避及新 invocation 计数重置 |
| AC-MIG-07 | `bun run check` 包含所有包/脚本类型检查、完整测试、本地 HTTP、CLI 子进程及真实 PTY；`provider-replay` 覆盖 thinking 签名；`responses-terminal` 覆盖终态补丁 |
| AC-MIG-08 | 原样差分的并行→串行反向实验在 `toolUse/all/false` 失败；接入后的 assistant 保存等待反向实验检测到保存未完成时 effects=1（应为 0），恢复后通过 |
| AC-MIG-09 | `runtime-configuration`：模型流及完整工具批次 gate、accepted/applied、模型/prompt/thinking/tools 实际请求变化、无额外请求、失效 usage、无效更新回滚、释放取消；公开接口见 SDK |

首次完整集成检查：469 pass / 0 fail，10,981 assertions，67 文件；随后增加保存等待反向用例并定向通过。双轴审查修复了 compact 存储失败后的 result/idle 悬空、SDK 队列模式缺口和两处架构文档陈述；公开 SDK 的 all/one-at-a-time 及 compact 故障回归先失败、修复后通过。真实 PTY 包含既有工具/授权/输入/取消/compact 工作流及新增 retry → success → 下一输入。最终代码提交 `33b7ce53274afcc7bc34c4e0b373e08bdae1ab80` 上的完整检查为 473 pass / 0 fail、11,064 assertions、67 文件；依赖门禁、五包及自动化脚本类型检查、SDK 示例类型检查通过，25 组源码行为差分通过。Standards 与 Spec 复审剩余问题各 0 项。

## Operator 验收与交付授权

2026-09-08，operator 反馈：“我以wsl验收过了，暂时没有发现bug”。这是用户在 WSL 的实际验收结果；未提供逐场景清单，不推断未说明的供应商、平台或长期使用覆盖。随后明确要求：“请你推送，并关闭对应的issue”，授权推送本轮提交并关闭父规格 #14 与子任务 #15–#26。

启动旧会话时曾遇到 v3 文件被 v4 读取器拒绝的问题，已只读确认文件版本并说明新会话/副本转换方式；未由 Agent 删除、覆盖或原地转换用户会话。

## 反向验证复现

1. 固定 checkout 的 HEAD 及四文件必须与来源提交一致；差分脚本直接核对 git 内容，不使用 Forge 生成 oracle。
2. 暂时把本地 Core 默认 parallel 路径改为 sequential，运行差分的 `--behavior-only`，应在工具顺序场景失败；恢复后默认完整差分通过。
3. 暂时把 `AgentSession` 的 message_end listener 中 `await this.persistEntry(entry)` 改为不等待，运行 `bun test packages/core/test/runtime-tools.test.ts -t 'persistence barrier'`。assistant 慢写入期间工具提前执行，断言失败。恢复 await 后通过。
4. 实验结束恢复源码；不提交故障注入，不碰真实会话。

## 回退与交付边界

- 保留本轮前的二进制/源码、lockfile 和会话副本。测试本轮代码时，先把选定 v4 会话复制到独立路径，再显式传入该路径；不要让两个实例同时写同一会话。
- 回退应用时使用起点提交及其完整 lockfile，在独立 checkout 执行 `bun install --frozen-lockfile`；切换 SDK 宿主工具返回协议也需与旧提交匹配。不要仅回退循环文件而混用新会话层/旧模型依赖。
- 原样 Core 基线提交只用于来源核查，不是最终 Forge 集成的产品回退点。恢复原产品使用实施起点，而非单独部署源码基线。
- v4 中本轮新增 details 可被新版本完整重载；旧版本是否保留这些扩展字段不作保证。可靠回退采用保留的旧会话副本；取消、不确定工具效果和历史写入均不能自动重放或撤销。
- 实施阶段不推送、不关闭远端 Issue；operator 的后续明确授权现允许推送与关闭 #14–#26。此次不发布版本，不覆盖 operator 会话，不由 Agent 运行收费模型。
- 未验证：真实供应商多轮任务矩阵、macOS/Windows、Node.js/Python、npm 分发与人工长期使用。历史 Phase 1 / E1–E3 人工验收豁免仍为豁免，不能记作通过。Bun/WSL、本地 HTTP 与真实 PTY 不代表这些未测平台。
