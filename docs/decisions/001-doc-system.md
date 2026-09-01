---
doc_kind: decision
created: 2026-08-31
---

# ADR-001: 采用 clowder-ai 式文档系统

> 状态:已批准(2026-08-31,operator 发起)
> 参与者:operator(发起)、Grok(调研 + 落地)

## 背景

仓库处于规划期,已有 4 份文档(plan / phase-1 / 原附录文档 / cat-cafe;其中原附录文档现名为 design-rationale),但缺:

- AI 协作者的统一入口 —— 哪个文档说了算,靠口口相传
- 决策的固定安放处 —— 当时埋在 plan.md §0 和原附录文档(现 [design-rationale.md](../design-rationale.md)),以后会被重新争论
- 教训与跨 session 交接的制度化格式

调研对象:clowder-ai commit `7188f73`(2026-08-31)。其文档系统的本质是**机器可校验、AI 可导航的知识协作基础设施**:frontmatter 契约(ADR-011)、Feature Doc 作为唯一真相源、热/温/冷三层生命周期、review-request 交接信、证据只引用不复制。

## 决策

迁移以下机制(均已落地,路径见各条):

1. **AGENTS.md 单入口 + CLAUDE.md 指针** —— clowder 按模型分角色(AGENTS / CLAUDE / GEMINI 三份角色卡);本项目单 operator,收敛为一个入口,其它工具入口只做指针,防漂移。
2. **docs/README.md 索引 + 命名 / 元信息约定** —— 对应 clowder ADR-011 元数据契约,取最小集(`doc_kind` + `created`),不上全套 frontmatter CI。
3. **docs/decisions/ ADR 目录** —— `NNN-slug.md`,三位编号不重排不复用,本文件即 001。**历史决策不回填**:plan.md §0 四条决策与原附录文档(现 [design-rationale.md](../design-rationale.md))已有出处和证据,原地保留,ADR 从本文件起算。
4. **docs/lessons.md 教训库** —— LL-XXX 七槽位 + 入库门禁,与 plan.md F.3 三门禁对齐。
5. **review-notes/ 交接信** —— `YYYY-MM-DD-{topic}-review-request.md`,原话引用 + verdict 绑定 SHA;轻量评审不落盘。
6. **docs/SOP.md** —— 改动分级、验证纪律(Ran / Not run / Why / Risk)、「文档领路,代码跟随」。
7. **docs/templates/** —— ADR / feature doc / review request 三个模板。格式即契约:状态行与 `- [ ] AC-` checkbox 保持稳定,为未来机器解析留口。

## 明确不迁移(及再议触发条件)

| clowder 机制 | 不迁理由 | 何时再议 |
|---|---|---|
| F 编号 feature 系统 + ROADMAP 热表 | 现有 phase 体系已覆盖,两套编号并存违反单一真相源 | Phase 3 后 feature 粒度变细时 |
| frontmatter CI / check:features 等校验脚本 | 仓库未 git init,无工具链与 CI | Phase 0 工具链落地后 |
| guides/ registry、sop-definitions 机器真相源 | 无 runtime 消费方 | harness 自身要消费文档时 |
| perspectives/、harness-feedback 评估系统 | 面向多 agent 团队与运行时自评,过重 | team 语义落地(Phase 2.5)后 |
| 多模型角色卡 | 单 operator 项目 | 多 agent team 落地时 |

## 后果

- 新文档一律按 docs/README.md 的约定写;既有 4 份文档不回改。
- 本 ADR 同时是 ADR 格式的实例(模板:[../templates/adr.md](../templates/adr.md))。
