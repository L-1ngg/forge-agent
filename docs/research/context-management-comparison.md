# pi 与 Claude Code 上下文管理比较

> 状态:历史调研结论(2026-09-07)，保留当时的实现快照与提案；最终决策见 [ADR-014](../decisions/014-pi-aligned-context-management.md)，当前实现见[验收证据](../phases/context-management-acceptance.md)。本文不是实现规格。

## 结论

两者都把上下文管理作为运行时职责：控制工具输出增长、摘要旧上下文、保留任务连续性，并在超限或压缩无效时有限恢复。仅加一个摘要函数不足以处理整个问题。

源码与引用分别见 [pi 调研](pi-context-management.md) 和 [Claude Code 调研](claude-code-context-management.md)。pi 固定公开 SHA；Claude Code 使用当日官方资料，未审计私有实现或运行真实请求。下表每行的证据在两个报告对应主题章节，不把两类证据强度混为一谈。

## 决策比较

| 问题 | pi coding-agent 实际路径 | Claude Code 官方描述 |
|---|---|---|
| 职责归属 | AgentSession 调度，基础 Agent 提供请求前扩展点；另有新 AgentHarness | harness 内建，SDK 复用并报告 compact_boundary |
| 触发 | 每次下一模型响应前预检；阈值和 overflow 两类处理 | 主动压缩与 API 超限恢复；阈值依模型和配置 |
| 预算 | 最近有效 usage 加新增消息估算；默认预留 16384 tokens | 按模型/配置设置 auto-compact window；没有公开完整预算实现 |
| 近期原文 | keepRecentTokens 默认 20000；可在同一用户任务内合法切分 | 保留近期交流与关键决策，未披露精确切分算法 |
| 摘要请求 | 对话序列化为独立文本，不带原 tools/system prompt | 同 system prompt/tools/history 末尾加摘要指令，利用热缓存 |
| 摘要更新 | 旧摘要加新增待压缩内容；分割 turn 时可额外摘要 turn prefix | 结构化摘要、定向摘要；不从公开描述推导内部增量算法 |
| 历史 | 追加 compaction entry，原消息保留；按边界投影上下文 | transcript 保留原消息；摘要替换活动上下文 |
| 指令保留 | 摘要模板记录约束；system prompt 独立提供 | system prompt 不变，根规则、记忆和部分相关内容重注入 |
| 大结果 | Read 截头分段、Bash 截尾加完整输出临时文件路径 | 清旧工具输出；Read 分页、Bash 结果按类型限额/外置 |
| 恢复上限 | compact-and-retry 一次；摘要失败有单独处理 | 超限恢复、底层失败原因、反复立即填满时停止 thrashing |
| 找回旧信息 | 宿主有历史访问 API，未发现内置专用模型 recall 工具 | 文档称可参考 transcript，未确认稳定消息级 recall 协议 |

默认 token 数只是 pi 固定快照参数，不是 Forge 的推荐值。单次 compaction 不等于只有一次摘要 API 调用。

## 对当前项目的影响

1. **请求准备位置。** 在每一次模型调用前准备上下文，必须覆盖一次 `runTurn()` 内的多次工具循环。仅在用户输入时检查不足。
2. **原历史与投影。** 当前 SessionStorage 仅有 load/appendTurn，而内核只有消息数组。需要明确摘要覆盖范围和近期保留边界如何表达，不能直接删除已保存历史。
3. **完整预算。** 现有 UsageTracker 的消息估算没有包含 system prompt 与工具 schema；它可继续做展示，但不能直接成为严格请求准入依据。
4. **工具输出。** 本项目 Bash 已有默认 65536 字节共享 stdout/stderr 限额，Read 默认可读完整文件。还缺整批结果的预算、必要原输出存储与模型可用引用；并不是所有单工具保护都要从零重写。
5. **输入与提交。** 调研时 pi 的逐消息保存与 Forge 的整次成功提交不同。后续第 9 项已通过 [ADR-013](../decisions/013-incremental-session-persistence.md) 将目标方向改为逐步持久化，部分替代 ADR-010；当前实现尚未迁移，输入归属规则继续保留，未完成工具历史的请求投影仍需确认。
6. **恢复不重放副作用。** 超限发生在工具执行后时，应调整上下文再请求模型；从 invocation 起点重新执行可能重复写文件或执行命令。

本地依据：`packages/core/src/execution-core.ts`、`pi-port.ts`、`usage.ts`、`session-storage.ts`、`agent-runner.ts`、`packages/tools/src/read.ts`、`bash.ts`。本次核对当前工作树，未修改上述文件。

## 调研后建议的讨论顺序

以下为建议，不代表 operator 已批准。

1. 原始需求与约束哪些必须原文保留；哪些材料允许摘要或移出上下文。
2. 在同一长工具任务内允许哪些切分边界，以及摘要后如何保留当前任务来源和状态。
3. 请求预算、摘要目标、超大单条输入和并行工具批次超额时的动作。
4. 原文找回由什么接口提供、引用能活多久、如何避免找回后再次撑爆窗口。
5. 主模型与独立摘要模型的取舍，摘要本身超限/截断/失败时如何有限降级。
6. 压缩的状态、事件、取消、steering/follow-up、提交失败与计费边界。
7. 用超长单任务、并行大结果、摘要遗漏找回、取消与存储故障、无进展循环等场景定义验收。

其中第 1 项会决定保留集合，第 2/3 项会决定算法和预算；不应先抄一个 80% 或 95% 阈值再反推行为。

## 已批准范围

见 [ADR-012](../decisions/012-context-management-direction.md)：自动续跑、历史原文保留与找回、有边界的额外模型调用；不纳入进程重启后自动恢复。用户要求先完成此次上游调研，再继续设计。

## 验证

- Ran:两份一手资料报告交叉比较，本地执行与工具路径核对，文档 diff 与相对链接检查。
- Not run:上游或本项目的真实压缩运行、付费模型请求、取消/超限故障注入。
- Why:本轮交付为决策调研与已确认方向记录，没有实现代码变更。
- Risk:摘要保真、token 估算误差和供应商错误兼容不能由源码/文档阅读证明，需要后续实现验收。
