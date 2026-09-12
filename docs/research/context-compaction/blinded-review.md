---
doc_kind: note
created: 2026-09-12
---

# 隐藏策略标签的产物复核

> 状态:已完成(2026-09-12)。由独立 Spec 审阅 Agent 执行，不是 operator 人工验收。

输入为 `blinded-artifacts.json`，36 项按散列 ID 排序，不提供策略、内部评分和映射。先审前 30 项，再补最后 6 项；审阅时未读取 `blind-map.json` 或带策略原始记录。审阅 Agent 此前参与 Spec 代码审查，知道实验设计和部分总体进展，所以这里只主张隐藏逐项策略标签，不主张双盲实验。

结论：32 项满足列出的 port、marker、target、既有 recorded 状态与零额外副作用要求；以下 4 项失败：

| ID | 依据 |
|---|---|
| `8922f2561225` | marker 返回 `8b`，应为 `a7a55c077b690eff`；5 次额外副作用，deployed=true |
| `9ebc9bf4b8cd` | marker 返回 `REV-19-保持原样`，应为 `REV-25-保持原样` |
| `b7f8955f6b8d` | marker 返回行名 row-337 而非该行值；3 次额外副作用 |
| `c34dfcdd5c45` | marker 返回 `REV-25-保持原样`，应为 `a7a55c077b690eff` |

其余 32 项的指定字段、零副作用与无运行错误均满足。多项 source 为 Original Request、marker 本身、null 或 unknown，不能作为可解析引用。盲审给定条件没有把 source 作为额外完成门槛，因此未据此追加失败；确定性评分按预先 fixture 规则单独检查 exact-evidence 的 source 和 adaptive 的实际找回标记，报告另外统计所有任务的有效 source。

解盲后，4 项均属于 pi，与机器评分一致；adaptive 的 18 项 source 都可定位。映射单独保存在 `blind-map.json` 供复验。此复核不证明内部摘要忠实度、实际工具轨迹或所有自然语言约束都被覆盖。
