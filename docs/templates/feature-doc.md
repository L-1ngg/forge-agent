---
doc_kind: plan
created: YYYY-MM-DD
---

# <Phase / Feature 名称>

> 状态:草稿 | 施工图 | 已完成(YYYY-MM-DD) | Owner:<谁>
> 中 / 大改动使用本模板,按 [SOP.md](../SOP.md) 流程骨架填空。

## Why

<问题与动机;指向上位文档(plan.md 哪一节)>

## Entry Criteria

| # | 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|---|
| E1 | … | … | … |

豁免必须标注「未验证风险」,不得改写成已通过。

## What

<设计,按工作项拆分。每项带:>

- **路径**:<要创建 / 修改的文件>
- **tradeoff**:<选了什么、放弃了什么>
- **验收**:<可验证的检查>

## Acceptance Criteria

出口条件(Release):

- 下方 AC 全部为 ✅
- <其它出口条件,如 bug bar / dogfooding>

明确**不**作为出口条件:

- …

- [ ] AC-1:<可验证标准,checkbox 不是感觉>
- [ ] AC-2:…

## Test plan

| 层 | 覆盖什么 | 跑在哪 |
|---|---|---|
| unit | … | CI 每次 push |
| … | … | … |

每个里程碑带一次反向验证:人为注入失败路径 → 对应测试变红。

## 明确不做

- … → 去处(后续施工图 / 明确不做)

## Rollback

- 批次如何独立 revert
- 开关 / 降级路径(必须走保守侧)

## Key Decisions

<重大决策链接到 docs/decisions/NNN-*.md>

## Dependencies

<依赖的 Phase / 外部包 / 前置验证>

## Risk

| 风险 | 缓解 |
|---|---|
| … | … |
