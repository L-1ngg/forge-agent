# 近期历史选择 A/B 实验数据

> 状态:生效(2026-09-29，修正离线复算入口)。方法、评分和结论见[评估记录](../../phases/context-selection-evaluation.md)。本目录保留原始结果，不把失败的 v1 混入 v2 成功率。

| 批次 | A 旧选择 USD | B 近期选择 USD | 结果 |
|---|---:|---:|---|
| 连接探针 `smoke-*` | 0.058852 | 0.033690 | 两次单场景调用；早期 runner hash 单独保留在原始记录，非正式结果 |
| v1 开发 `development-*` | 0.408988 | 0.447622 | 8/8 与 8/8 |
| v1 保留 `holdout-*` | 0.989444 | 0.954698 | 各 21/24；精确证据各三次零请求预算失败 |
| v2 开发 `v2-development-*` | 0.447782 | 0.403960 | 8/8 与 8/8 |
| v2 保留 `v2-holdout-*` | 1.258966 | 1.258538 | 各 24/24；正式报告 gate=true |

累计 USD 6.262540 是模型目录费率按返回 usage 估算，不是供应商账单。v2 保留集全部模型请求均有 usage。v1 结果使用 [`runner-v1.txt`](runner-v1.txt) 和 [`report-v1.txt`](report-v1.txt) 的源快照；v2 使用 [`runner-v2.txt`](runner-v2.txt) 和 [`report-v2.txt`](report-v2.txt)。v2 fixture/runner/report 的 SHA-256 分别为 `a1994edd3a539d707b3ef626ac35b4d29fc1bf16ff08f0ee6ae25221926638aa`、`516be73a28cdbcb220f6d9943c87b76e584b335ac489f436898561cea37ed5b2`、`9d3cc5dd3f1a3907873548fa0b070289be795dab9c59b40dcf9c1c6c6e18d9d5`。A 的源码为 HEAD `62c7f2574126ad713f30811b74a2abbbccab290b`，B 的 [`compact.ts` 快照](candidate-compact-v2.txt) SHA-256 为 `7e47a87deab8e26db28299e3ab891dd6ec5d39d9b38cbda6e93b7d95a78d5c3c`。

## 离线复算 v2

需要 Bun 1.3.12、Git，以及包含上述基线提交的仓库历史；浅克隆须先补齐该提交。当前 `scripts/context-selection-report.ts` 和运行时已随架构迁移更新，不能直接用于这份旧数据。使用[冻结实验复算入口](../../../scripts/context-selection-reproduce.ts)，从仓库根目录执行：

```sh
bun scripts/context-selection-reproduce.ts --split holdout \
  --out /tmp/forge-context-selection-v2-report.json
```

`--split development` 复算 v2 开发集。入口只在临时目录重建 A 的七个历史源码文件，以保存的 `compact.ts` 替换 B 对应文件，并使用冻结的 `runner-v2.txt`、`report-v2.txt` 和 fixture。只对临时输入副本重定位 `metadata.sdkRoot`；原始数据不改动，原报告器的源码、fixture、runner、配置、样本和评分校验全部保留。导出前还核对 `gate`、`summary`、`failures`、`provenance` 与原报告一致；导出的输入路径指向仓库材料，临时副本最后删除。

整个过程不安装依赖、不运行 runner、不调用模型、不切换当前工作区。输出是历史实验的复算，不是当前实现的新质量验收。v1 的快照及 `scripts/fixtures/context-selection-tasks-v1.json` 继续用于历史追溯，本入口只复算 v2。

独立报告为 [`v2-holdout-report.json`](v2-holdout-report.json)；v1 失败详情为 [`holdout-report.json`](holdout-report.json)。`development-*`、`holdout-*`、`v2-development-*`、`v2-holdout-*` 中的 `baseline/candidate.json` 是逐次原始记录；同名 `preflight-*` 是付费前受控投影证据。
