---
doc_kind: plan
created: 2026-09-07
---

# 上下文工程实现与验收

> 状态:代码实现、本地自动化与受控真实任务验收完成(2026-09-07)；未推送、未发布版本、未迁移用户数据。此处记录实现证据，任务状态以 GitHub Issues 为准。

## 范围与基线

落实 [Spec #2](https://github.com/L-1ngg/forge-agent/issues/2) 及其 #3 至 #13 子任务。Pi 决策基准为 `9767ba275f3e9a5ee0f5c5342249b629ab1b2282`，运行依赖保持 `pi-ai 0.84.4`，循环仍由自研 `ExecutionCore` 拥有。

开工 HEAD 为 `05d8912fddd70d0cdefc153edb92daa6598252ba`。运行代码与验收先独立提交为 `85b6499`。开工前已有的 `CONTEXT.md`、ADR-010、`docs/plan.md` 修改，以及 ADR-012/013/014、上下文设计施工图和六份研究文件按父规格 Construction reference 的交付要求随后单独收录；保留既有正文，只同步实现状态、公开配置名及验收链接。当前实现结果以本证据及 Issues 为准。

## 已实现行为

- 会话采用 v4 JSONL 与 `SessionStorage.load/append`。输入实际消费后、请求之前保存；assistant 在工具执行或恢复前保存；并行工具整批收尾后按调用顺序保存。取消保留过程，存储故障停止调度并停用实例。
- 每次模型请求前按严格 `C > W - reserveTokens` 检查，最多主动压缩一次。最多历史、turn 前缀两个逻辑摘要顺序生成并直接拼接，默认继承推理、2/4/8 秒重试，没有累计调用帽或强制缩小要求。
- overflow 与符合 Pi 条件的 length 共用一次连续失败链恢复。普通 length 保留正文，截断调用不执行；恢复失败记录保留原文且不进入恢复视图。成功回答不会因超窗重新生成。
- usage 锚点关联请求材料和被计量前缀，变更后回退估算；图片透传并采用每张 1024 tokens 启发式。摘要用量独立随事件和 compaction 记录保存。
- Read 使用 offset/limit，2000 行/50 KiB 头部预览；Bash 合并采集输出并保留同限额尾部，超过阈值才写系统临时日志。自定义工具自行管理输出体积，内核没有整批配额。
- SDK、CLI 与 TUI 共用 compact 路径。手动压缩先等待当前执行和写入收尾，完成后保持空闲。任务和摘要共享 sessionId；HTTP affinity 字段仍由 pi-ai/provider 与缓存设置决定。

公开合同及迁移示例见 [中文 SDK](../sdk.md) / [English SDK](../sdk.en.md)。

## 逐票证据

以下引用验收编号，不重新定义所属规格的验收标准。测试路径均相对仓库根目录。

| Ticket | 验收范围 | 主要证据 |
|---|---|---|
| [#3](https://github.com/L-1ngg/forge-agent/issues/3) | AC-PICTX-10/11/13 | `incremental-session.test.ts`、`input-ownership.test.ts`、SDK/loop/PTY 回归：保存先于调度、部分写失败、取消保留、未启动调用不伪造结果 |
| [#4](https://github.com/L-1ngg/forge-agent/issues/4) | AC-PICTX-11 | `session-conversion.test.ts`：v3 副本、源与已有目标保护、坏行诊断、无换行只读、选中分支与压缩边界校验 |
| [#5](https://github.com/L-1ngg/forge-agent/issues/5) | AC-PICTX-08 | `packages/tools/test/tools.test.ts`、工具 PTY：Read 头部预览、续读 offset、首行过长及非法参数 |
| [#6](https://github.com/L-1ngg/forge-agent/issues/6) | AC-PICTX-08/09 | 同工具测试：真实命令尾部、阈值前后完整日志、Read 补查、非零退出、超时/取消、日志写失败及缺失文件 |
| [#7](https://github.com/L-1ngg/forge-agent/issues/7) | AC-PICTX-02/04 | `usage.test.ts`、`context-http.test.ts`：锚点与失效、中文/JSON/图片、无重复固定材料、HTTP 图片透传和参数映射 |
| [#8](https://github.com/L-1ngg/forge-agent/issues/8) | AC-PICTX-01/03/10/11/12 | `compaction.test.ts`、conversion/PTY：手动保存、重开、空材料跳过、无效摘要拒绝、取消等待、完成后空闲 |
| [#9](https://github.com/L-1ngg/forge-agent/issues/9) | AC-PICTX-01/03 | split-turn 用例验证历史再前缀、0.8R/0.5R 输出配置、直接拼接及保留原文；HTTP 验证仅摘要序列化截断工具文本 |
| [#10](https://github.com/L-1ngg/forge-agent/issues/10) | AC-PICTX-04/05 | 两段各第四次成功、累计超过 32 次、默认退避、取消退避、永久错误不重试；HTTP 推理继承/off/不支持回退 |
| [#11](https://github.com/L-1ngg/forge-agent/issues/11) | AC-PICTX-01/06/12 | 严格等值边界、同一工具循环重复准备、失败主动路径继续、摘要变大仍发布、无新增记录不重复压缩 |
| [#12](https://github.com/L-1ngg/forge-agent/issues/12) | AC-PICTX-07/12 | overflow→length 共用失败链、HTTP 已输出部分内容后恢复、失败原记录保留、截断调用不执行、失败恢复不重发、headless 终态 |
| [#13](https://github.com/L-1ngg/forge-agent/issues/13) | AC-PICTX-13/14 及跨任务核对 | 完整 check、公开 SDK/HTTP、真实 PTY、双语 README/SDK、`examples/context-acceptance.ts` 真实任务 |

core 测试位于 `packages/core/test/`，PTY 测试位于 `tests/tui-integration/`。断言包括工具副作用次数、保存顺序、原记录与请求分离，不能以终端文字或摘要变短代替这些检查。

## Ran

- `bun run check`：依赖边界、全部包类型检查、automation 类型检查通过；388 pass / 0 fail，10637 次断言，58 个测试文件。
- `bun run typecheck:examples`、`git diff --check`：通过。
- provider 本地 HTTP 矩阵：Anthropic Sonnet 4.5 的 thinking budget、Sonnet 4.6 adaptive、OpenAI Responses GPT-5.2、GPT-5 不支持 off 时回退、OpenAI Chat 路径 DeepSeek V4 Flash。该矩阵验证实际适配请求形状和流解析，不代表这些服务的线上验收。
- `/code-review` 两路审查：Standards 初轮文档状态和重复保存逻辑已修复；Spec 初轮图片、普通 length、加载边界和 sessionId 四项已修复。刷新后两路均无剩余问题。
- 反向验证：headless 恢复成功仍返回失败的新增用例先失败，修复后通过。各批次对保存点、工具限额、手动/自动压缩和恢复也运行了实现前失败用例。另有两个逻辑摘要各第四次成功，以及单个 invocation 内超过 32 次摘要尝试仍完成 10 次工具调用的回归；没有将其表述为已经注入旧累计帽的实验。

真实任务命令为 `bun examples/context-acceptance.ts`，使用运行时现有 xAI 配置，实验限制最多 16 次模型入口和 180 秒，凭据未写入仓库或输出。记录如下：

```json
{"provider":"xai","model":"grok-4.6","toolCalls":4,"modelCalls":6,"summaryCalls":1,"compactions":1,"reopenedConstraintsPreserved":true,"physicalOverflowTested":false}
```

任务完成四个按 cursor 顺序衔接的工具调用，自动压缩后继续；重开仍保留目标 `analytics-db` 与最大批量 `17`。本地窗口设为 6000、reserve 为 1024、keepRecent 为 2000；这是触发流程实验。临时验收会话已清理；工具测试创建的日志由测试清理，不改变产品日志生命周期。

## Not Run / Why

- 供应商物理窗口超限：未执行；低本地窗口不构成物理超窗证据，overflow/length 以受控驱动及本地 HTTP 验证。
- 全部 provider 的真实线上矩阵：未执行；线上仅 xAI，其他路径为本地 HTTP 请求形状测试。
- 断电、OS 崩溃与真实磁盘耗尽恢复：未执行；本轮注入存储追加失败和工具日志 I/O 失败，不保证 JSONL 事务性或 fsync 持久性。
- macOS 与 Windows 的新增矩阵：未执行；本轮在当前 Linux/Bun 环境运行。旧 CI 结果不充当本次平台验收。
- 版本发布、远端推送与 operator 数据迁移：未执行；#13 仅授权交付核对，实施提交与测试副本不替代发布授权。

## Risk / Release / Rollback

估算不是精确 tokenizer，固定摘要模板不保证无遗漏；关键约束仅在上述受控任务内验证。无整批工具、累计摘要及日志全局配额，系统临时文件也不保证及时清理或永久可用。Read 仍完整加载文件，超大输入可能使摘要失败。

存储、core、SDK、CLI 须同版本交付。v3 通过显式副本升级，已有目标拒绝覆盖；原文件保留供匹配旧二进制回退。关闭自动压缩不能让旧二进制兼容 v4。原有阶段人工验收豁免和本批自动化通过均不代表人工交付审核通过。
