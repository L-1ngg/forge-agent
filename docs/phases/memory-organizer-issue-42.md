---
doc_kind: plan
created: 2026-09-29
---

# Issue #42 记忆整理响应与计划校验施工图

> 状态:已完成(2026-09-29，本地实现与 Linux 离线验收；真实供应商质量与跨平台未测)。范围与 AC 以 [Issue #42](https://github.com/L-1ngg/forge-agent/issues/42) 为准；官方 deferred 保存及 Markdown 合同见 [ADR-026](../decisions/026-native-skills-and-markdown-memory.md)，模型响应审计见 [ADR-028](../decisions/028-model-response-boundary.md)。[Issue #37 原验收](tool-ecosystem-issue-37.md)只对应当时版本。

## Entry And Design

起点 `784da81bf2d300158ebf154ee49c8217f8d11622`，`master` 的 staged、unstaged、untracked 均为空。#42 已确定整理继续由 `memoryMiddleware` 在成功任务后 deferred 调度，并保持一次当前模型请求、user/project 目录、索引与主题布局、主任务结果及失败事件合同。#43 的自动压缩预算不在本次范围。

1. 整理请求调用与摘要相同的 `callModel` 接缝。原始 adapter 迭代器及 `finally`、协议终态和 TanStack 消息投影完成后，仅从完整 `stop` 且无工具调用的回答提取文本。系统提示词要求单个纯 JSON 对象；空 `updates`/`indexes` 代表无更新。
2. 单个 JSON 文档经严格 schema 校验，再逐项预检所有 scope、静态路径、内容和操作形状。主题不能选 `MEMORY.md`，写操作必须含内容。全部通过后才按主题先于索引执行；文件 I/O 的现有非事务合同不变。
3. 记忆事件沿用 `memoryMiddleware` 的保存回执与 `calls`。整理请求的原生 usage 保持可选，缺失时不合成零；整理失败由 middleware 转成失败回执，不影响成功的 `AgentTurn.result`。不新增对外事件或取消合同。

## Verification And Release

测试沿用 Issue #42 的 Testing Decisions：公开 `createAgent`/`AgentTurn`、`memory` 事件、临时 Markdown 目录及确定性 native/Bedrock 流 fixture。先验证失败路径使测试变红，再逐个修复；覆盖完整写盘与重开召回、空计划、非法/不完整流、整份计划预检、事件 usage、scope 和证据输入。每轮运行相关单文件测试与类型检查，末尾运行一次全量离线套件，并执行双轴 code review。

**Ran**：公开 SDK 的确定性测试覆盖一次完整请求、跨会话召回、空计划、user/project 隔离、索引指向主题、确认工具证据、失败回执、已知与未知 usage、主题先于索引及普通 I/O 故障。协议 fixture 覆盖缺终态、终态后 adapter 抛错和迟到 `RUN_ERROR`、`length`、`deferred`、取消、工具提案、空文本、非法 JSON/schema、未授权 scope、后段非法路径/内容；Bedrock Converse 的完整 JSON 缺 `messageStop` 拒写、完整 `messageStop` 写入均通过。定向 SDK/native-model/Bedrock 五文件 49/49；反向临时移除 `stopReason` 拒写门槛后，缺终态测试确实从 `failed` 变为 `saved` 并转红，恢复后通过。

**Ran**：`bun run check` 通过依赖检查、源码/自动化/测试类型检查及 Linux network namespace 隔离下的 contract 541/541、integration 375/375、CLI/PTY 15/15。`bun run test:headless`、`bun run typecheck:examples`、`git diff --check` 通过。完整门禁运行于同步完成的 #43 提交 `1a23910` 加 #42 工作树之上；上述定向测试是 #42 的直接行为证据，不将全仓通过解释为 #43 的独立验收。

**Not run / Why / Risk**：未调用真实供应商整理任务，没有本次指定的目标、凭据及费用预算；纯文本 JSON 的实际抽取质量、失败率、费用和延迟尚无新样本。未运行 macOS/Windows 或长期使用评估；Linux fixture 不能外推跨平台及供应商协议变化。保守失败会拒绝未完整确认的计划，真实模型若不遵守纯 JSON 格式将表现为可观察的记忆保存失败，不改变主任务回答。

交付出口为 Issue #42 的适用 AC、定向与全量软件检查、受影响文档、双轴审查及本地提交。回退以本次独立提交 revert；若整理结果无法确认完整有效，则拒绝自动写盘。#43 的自动压缩预算不属于此图验收。
