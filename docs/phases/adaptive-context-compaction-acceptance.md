---
doc_kind: note
created: 2026-09-12
---

# 可追溯上下文压缩验收

> 状态:已通过本次限定验收(2026-09-12)。任务状态与 AC 原文见 [Issue #31](https://github.com/L-1ngg/forge-agent/issues/31)。

施工选择见[施工图](adaptive-context-compaction.md)和 [ADR-017](../decisions/017-evidence-backed-context-compaction.md)。本记录区分软件合同与真实模型质量，不将受控摘要、压缩率或 Agent 审阅当作人工运行验收。

## 软件合同

Ran：`bun run check`：561 pass / 0 fail，11690 次断言，75 个测试文件；`bun run typecheck:examples`、`bun run typecheck:automation` 通过。全套检查包含核心 typecheck 与既有回归；新增公开 SDK 场景有 19 个实例。汇总脚本另以混合配置、未知实现、篡改评分、重复样本四种输入验证均拒绝（`report-integrity.json`）；完整 36 行正向重算通过。后续只修正评估记录/汇总脚本及文档，生产实现仅清理空行空白。

在独立临时源码副本注入四种故障，相关 SDK 行为测试均失败：删除 active 状态投影、放开原文分支限制、重复工具副作用、取消实际摘要请求调用帽。第一个注入最初未被旧测试检出（约束仍留在原文），测试已增加无关背景使旧原文必须移出，再次注入检出；未把首次未检出隐藏为成功。临时故障副本已经删除。

| AC | 证据入口与边界 |
|---|---|
| AC-1、AC-2 | `adaptive-context.test.ts` 的恢复、纠正、连续五次压缩、非法状态重开测试；状态/引用校验与实际工具 ledger 分离，宿主权限仍由现有工具链决定 |
| AC-3 | 长工具正文零摘要裁剪、重复正文去重、单次 SDK 工具链压缩且不重放；真实 long-log 与 correction 对照 |
| AC-4 | 原文 missing/foreign/denied 三种权限边界、Unicode 超长单行尾部、伪造证据拒绝发布；真实 exact-evidence 表格分页找回 |
| AC-5 | 连续五次压缩触发原文 rebuild、非法状态/引用与超大 summary input 失败；语义分类和 taskChanged 依赖模型，不宣称能检测所有语义矛盾 |
| AC-6、AC-7 | thinking 输出预留、protected input 预检、超大 summary input 零请求、旧工具正文零摘要；既有 context/HTTP 模型与配置失效回归 |
| AC-8、AC-9 | 包含 retry 的四次实际请求帽、有限重建、公开 compaction 事件的预算/调用/usage/停止原因；不将未知 usage 混入实测 Token |
| AC-10 | 原始历史不变、取消不发布、pi→adaptive 从原始记录恢复、坏版本重开拒绝；既有 session/storage 的保存失败、分支与工具收尾回归 |
| AC-11 | 公开 SDK + 本地 HTTP provider + 副作用计数；四类故障注入见上文 |
| AC-12、AC-13 | 下方真实模型记录、冻结保留集、独立评分、成本及未测限制 |
| AC-14 | 实施前 operator 确认的 ADR-017/施工图；`docs/sdk.md` 与 `docs/sdk.en.md` 同步，默认 pi、显式 adaptive、回退保留历史 |

## 真实模型实验

固定保留集见 [`context-tasks-v2.json`](../../scripts/fixtures/context-tasks-v2.json)：6 类 × 2 策略 × 3 次。真实摘要与任务均通过 xai / `grok-4.6`，实际返回 `grok-4.6-build`；thinking off、retry 0、声明窗口 32000、maxTokens 2048、reserveTokens 4096、keepRecentTokens 256。供应商目录窗口为 500000，本实验没有制造物理窗口超限。

开发阶段 exact-evidence v1 可以直接复述摘要，不能证明按需找回。因此在正式保留集开始前冻结 v2：600 行 opaque 值表格，压缩结束后才指定 row-337，adaptive 必须实际读取到目标片段且返回正确 `source: "evidence"`。其余开发场景数据未改变。开发旧结果和失败仍保留，不把开发集当独立泛化证据；只有保留集使用固定 v2 完整评分。

任务使用构造的已保存历史和 JSON 配置产物；副作用工具只计数，不操作真实部署。策略顺序确定性交替并记录在 metadata，非随机抽样；不同场景曾使用 3 个并发 worker，延迟包含当时 provider/网络负载，不能视为严格隔离的性能基准。

原始逐次记录见 [`context-compaction/`](../research/context-compaction/)。汇总器独立重算字段评分，检查重复/缺失样本、运行配置与真实返回模型。所有失败样本计入结果，没有择优重跑。最后 task-switch 初次因 recorder 自读脚本时 URL 字符串路径错误在模型调用前退出；改为 URL 对象后首次执行该场景，不属于失败模型样本重跑。

完整 36 条保留集通过预定质量 gate。独立汇总见 [`holdout-report.json`](../research/context-compaction/holdout-report.json)，原始逐条记录在 `holdout/`。所有正式保留集模型调用均有 usage，未用估算值代替总 Token。

| 指标 | pi（18 次） | adaptive（18 次） |
|---|---:|---:|
| 任务完成 / 全部硬约束通过 | 14 / 18 | 18 / 18 |
| 无额外副作用的运行 | 16 / 18 | 18 / 18 |
| 额外副作用次数 | 8 | 0 |
| 精确证据任务完成 | 0 / 3 | 3 / 3 |
| marker 正确且 source 可定位 | 0 / 18 | 18 / 18 |
| 原文读取成功 / 请求 | 0 / 0 | 14 / 14 |
| 总 Token 中位数 / p95 | 14627 / 40874 | 15014.5 / 58105 |
| 任务耗时中位数 / p95（秒） | 61.94 / 146.38 | 50.95 / 157.21 |
| 压缩耗时中位数 / p95（秒） | 23.13 / 105.17 | 46.23 / 145.77 |
| 模型请求 / 其中摘要请求 | 82 / 57 | 58 / 27 |
| 估计费用（USD） | 0.943248 | 1.134848 |
| overflow 运行 | 0 | 0 |

adaptive 的 Token 中位数增加约 2.65%，费用增加约 20.31%，压缩耗时中位数增加约 99.9%；任务耗时中位数减少约 17.74%，但 p95 增加约 7.40%。质量收益伴随费用与压缩延迟代价，不能宣称全面性能提升。所有任务/摘要/失败调用均纳入 Token 和费用；14 次原文读取中 11 次属于 exact-evidence（三次分别 4、3、4 次），其余 3 次为其他任务主动核对。

pi 的 4 次失败是 repeated-compaction 第 1 次返回旧 marker，以及 exact-evidence 三次未返回目标表格值，其中两次产生 3 / 5 次额外副作用。没有更改 pi 来迎合本任务集；基线失效是本组数据的观测结果，不扩展成 pi 在所有任务不安全的结论。普通任务的 source 不正确单列报告，未事后把它追加到原先只针对 exact-evidence 的完成门槛。

隐藏策略标签的独立 Agent 产物审阅见 [`blinded-review.md`](../research/context-compaction/blinded-review.md)。已审 36 项，与确定性评分一致；仅核对产物及副作用，未验证内部摘要全部语义，也不是人工验收。开发结果保留在 `development/`：最终采用的非 exact 30 次与 v2 exact 6 次中，adaptive 18/18、pi 15/18；旧 exact v1 的六次及全部开发探针另存，不删除失败样本。

全部开发、探针、旧 fixture 和保留集的已计费/保守预留累计 **USD 6.941052**，低于 USD 10 上限；见 [`cost-ledger.json`](../research/context-compaction/cost-ledger.json)。这是目录模型费率估计，不是供应商账单；早期探针/开发缺少终止 usage 时保留请求费用上界，不能将其当成实测 token。正式保留集无 usage 缺失。


## 记录完整性与复现

旧 recorder 缺少 `recordingVersion` 和自身 hash；精确源码留在 `legacy-runner.txt`，SHA-256 为 `36beb3dc647917212f75ade03b736158ca5a63767405184549e8119c168a6767`。v3 修复按 toolCallId 配对并记录自身 hash。旧 recorder 批量读取时逐项参数/结果可能错配，因此其 `retrievals` 明细不能作为准确分页证据；累计 lookup 成功数和从工具结果直接判断的 requiredFragmentRead 不受影响。汇总报告保留这个限制及每个输入的原 metadata，不将最终脚本 hash 冒充历史来源。

保留集生产源码有两个 hash，唯一差异是 `agent-session.ts` 第 47 个空白行删除两个 Tab，位于构造函数内，不在字符串里。`whitespace-proof.json` 记录两个 hash；汇总器从当前源码重建旧空白并计算全部源文件 hash，只有证明成立才接受该混合输入。该调整不改变模型请求、评分或生产行为；没有用 holdout 调参。

复算不调用模型：

```sh
bun scripts/context-compaction-report.ts docs/research/context-compaction/holdout /tmp/context-report.json docs/research/context-compaction/whitespace-proof.json
```

重新进行付费实验应使用已配置 provider；每个进程发送前限制最多 2000 请求和不超过 `--max-cost` 的保守费用（最大 USD 10）。分进程运行时额度不是共享的，调用方必须分配总预算。完整单进程示例：

```sh
bun scripts/context-compaction-benchmark.ts --split holdout --repeats 3 --max-cost 3 --out /tmp/context-holdout.json
```

汇总器同样支持目录中单个包含全部 36 行的结果文件。已有保留集不能再用于调参后的独立验收；须冻结新保留集。

## 未测边界与回退

Not run：其他真实 provider、多模型矩阵、供应商物理超限、真实部署副作用、人工语义验收。Why：本次冻结的质量实验限定单 provider、小型构造历史；软件生命周期由受控 HTTP/SDK 回归覆盖。Risk：引用正确只证明可追溯，不能保证自然语言提取完整或语义无损；固定任务集没有统计显著性，不能推断所有长任务都提升。

保持 `context.strategy: "pi"` 为默认；显式启用 `adaptive`。回退到 pi 停止增强压缩，同版本 reader 使用降级 summary 并保留原始历史；不保证旧二进制读取增强载荷时得到相同投影，不重放任何工具。远端 CI 与交付 SHA 以 Issue 的交付证据为准。
