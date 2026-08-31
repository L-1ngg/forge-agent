# docs/ — 文档系统

> 设计借自 [clowder-ai](https://github.com/zts212653/clowder-ai)(commit 7188f73),取舍记录见 [decisions/001-doc-system.md](decisions/001-doc-system.md)。
> 原则:文档领路,代码跟随;证据说话,不是信心说话。

## 导航

| 文档 | 职责 |
|---|---|
| [plan.md](plan.md) | 规划 + 行动项(**热层**:只放当前要做的) |
| [phase-1.md](phase-1.md) | Phase 1 施工图:路径 / tradeoff / 验收 |
| [appendix.md](appendix.md) | plan 的论证与探测证据(**冷层**) |
| [cat-cafe.md](cat-cafe.md) | cat-cafe-tutorials 失效模式附录(带证据标签) |
| [SOP.md](SOP.md) | 开发协作流程:改动分级、验证纪律、review 交接 |
| [lessons.md](lessons.md) | 教训库(LL-XXX),入库有质量门禁 |
| [decisions/](decisions/) | ADR:已定决策,防重新争论 |
| [templates/](templates/) | ADR / feature doc / review request 模板 |

## 位置与命名规范

| 位置 | 内容 | 命名 |
|---|---|---|
| `docs/decisions/` | 架构决策记录(ADR) | `NNN-slug.md`,三位数字递增,不重排不复用 |
| `docs/templates/` | 文档模板 | `{type}.md` |
| `review-notes/`(仓库根) | 跨 session 的 review 交接信 | `YYYY-MM-DD-{topic}-review-request.md` |

- 教训条目:`LL-XXX` 三位递增,发布后不删不改 ID;重大改写保留 ID 并记录更新与原因。
- 日期一律 `YYYY-MM-DD`。

## 分层原则(2026-08-31 operator 确认)

给不给文件夹,看两条:**数量是否无界增长** × **是否被单独精确引用**。

- 数量无界 + 单独引用(decisions/、review-notes/)→ 文件夹,一文一件。
- 整体消费 + 条目短(lessons.md)→ 单文件;拆分触发条件:条目多到无法整体阅读(参考:clowder 102 条 / 1944 行仍是单文件)。
- 数量有界(phase-*.md,路线图上共 5 个 phase)→ 平铺;升格 `docs/phases/` 的触发条件:第二份 phase 施工图出现,或单 phase 开始携带证据 / 资产附件。

## 元信息约定

新类型文档(decisions/、review-notes/)开头带最小 frontmatter:

```yaml
---
doc_kind: decision        # decision | plan | note | review-request
created: 2026-08-31
---
```

正文首行用状态行(延续现有文档风格):`> 状态:草稿 / 已批准 / 已审(日期)`。
**状态只写在一处**:文档自己的状态行。别的文档引用它时给链接,不复制状态。

## 生命周期

- **热层** —— plan.md:完成的行动项移除,不堆积。
- **温层** —— phase-*.md 施工图:Phase 进行中是唯一施工图;Phase 结束后保留,状态行标 `已完成`。
- **冷层** —— appendix / decisions / lessons / review-notes:永久保留,只追加不移除。

## 有意不采用

clowder-ai 的以下机制暂缓,触发条件见 [decisions/001-doc-system.md](decisions/001-doc-system.md)「明确不迁移」:
F 编号 feature 系统 + ROADMAP 表格、CI 文档校验脚本、guides/ registry、sop-definitions、perspectives/、harness-feedback 评估系统、多模型角色卡。
