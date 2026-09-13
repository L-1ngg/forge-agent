---
doc_kind: research
created: 2026-09-12
---

# `/resume` 冷热路径性能基准

> 状态:脚本与测量结果已核对(2026-09-13)。与软件行为/PTY 验收分开，不构成跨机器性能承诺。

## 结论与复现

运行 `bun run benchmark:resume`，入口为 [`scripts/session-resume-benchmark.ts`](../../scripts/session-resume-benchmark.ts)。基准观察生产 `SessionHost.list()`、`SessionHost.preview()` 的 JSONL 读取次数和耗时；使用临时目录中的合成 v4 会话，不读取用户历史、不调用模型、不写入仓库，结束时删除合成数据。变更场景会向合成会话追加记录，不执行真实工具。

[`SessionHost`](../../packages/cli/src/session-host.ts) 的列表按文件 revision 缓存轻量元数据；预览在传入同 revision 的 previous 时复用摘录。缓存命中只说明重复浏览省去了文件读取和解析，不代表首次打开同样快。交互正确性继续由已有 SDK/PTY 场景验证，性能数字不作为测试中的绝对时间断言。

## 当前实现与初始设计的分工

初始设计考虑独立长文件列表、删除失效、分支/图片、CPU/文件系统信息、读取字节数等扩展。当前脚本只实现下表六个场景，其余不是已经完成的测量，不在本次提交中扩展生产接口。脚本使用 Bun 1.3.12 可执行的 `spyOn(fs, "readFile")` 观察边界，并在 finally 恢复；无需为 benchmark 给生产代码新增文件访问 adapter。

数据为同一临时目录中的 102 个会话：100 个小文件、2 个 assistant 正文为 10 MiB 的长文件；JSONL 封套使实际长文件略大于 10 MiB。每份数据含合法 UUID header/消息身份。通过明确的 fixture 标题选中长会话，并用 stat 验证大小，不能依赖列表末项。

| 场景 | 操作 | 样本 / 预热 | 读取行为 |
|---|---|---|---|
| cold-list-102-sessions | dispose 后重建 host 再 list；耗时包括 host 重建 | 10 / 1 | 每次读 102 个 JSONL |
| hot-list-unchanged | 同一 host 对未变目录 list | 10 / 1 | 无 JSONL 正文读取 |
| cold-preview-long-session | 不传 previous，预览指定的 10 MiB 会话 | 10 / 1 | 每次读 1 个 JSONL |
| hot-preview-same-revision | 传入相同 revision 的 previous | 10 / 1 | 无 JSONL 正文读取 |
| changed-list-target-file | 追加一次记录后首次 list | 1 / 0 | 只重读目标 JSONL |
| changed-preview-target-file | 对变更后的文件传入旧 previous | 1 / 0 | 重读目标 JSONL |

这里 cold 指应用层元数据/预览缓存未命中，不清空操作系统页缓存；不能称为物理磁盘冷读。文件追加发生在计时外。变更场景禁止预热，避免把唯一一次失效重读排除于统计。每次正式样本保留毫秒数和读取次数；偶数样本中位数取中间两项均值，p95 用 nearest-rank。单样本变更场景的 median/p95 只是同一观测，不代表稳定分布。

## 实测结果

环境：Linux x64、Bun 1.3.12，系统临时目录；CPU 型号、文件系统类型、内存峰值和读取字节数本轮未记录。原始逐次样本及环境元数据见 [`resume-benchmark-results.json`](resume-benchmark-results.json)，可独立复算汇总值。

| 场景 | median ms | p95 ms | JSONL reads |
|---|---:|---:|---:|
| cold-list-102-sessions | 91.54 | 113.38 | 102 |
| hot-list-unchanged | 9.03 | 10.24 | 0 |
| cold-preview-long-session | 25.38 | 37.91 | 1 |
| hot-preview-same-revision | 0.07 | 0.13 | 0 |
| changed-list-target-file | 35.50 | 35.50 | 1 |
| changed-preview-target-file | 21.62 | 21.62 | 1 |

结果支持本次合成数据上的缓存命中与目标文件失效行为：列表正文读取由 102 降为 0，预览正文读取由 1 降为 0，追加后重读目标文件。时间只是本环境的观测，不构成跨机器 SLA，也不是终端完整打开耗时。

此前草稿的“长预览约 0.29 ms”撤回：旧脚本按列表末项选到了小会话。旧 changed-list 的预热也消耗了唯一一次失效；提交前复跑观察到正式样本 0 次读取，与旧表中写的 1 次不符。另修正了偶数样本上中位数冒充 median 的问题。上表是修复后重新测量的结果，不混用旧错误记录。更早的 #29 单次测量仍保留在原施工图中，不用本表覆盖其历史证据。

## 验证边界

本次运行了完整 benchmark 和 automation typecheck；读取次数及原始样本检查与汇总一致。没有运行真实模型、实际用户历史、网络文件系统或新一轮 PTY 交互验收，未将此基准作为重新关闭 Issue #29 的理由。

删除失效、分支/图片、大文件专用目录、读取字节数和内存峰值属于初始设计的候选扩展，本次未实现。禁用 summaries 命中/preview 快速返回的两项故障注入也仍是后续基准验证建议，不冒充本次已执行证据。mtime/size revision 对保留相同元数据的外部篡改不提供保证；恢复流程仍需重新校验文件。
