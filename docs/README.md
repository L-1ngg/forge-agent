# docs/ — 文档系统

> 状态:生效(2026-09-09)。
> 文档组织的历史决策见 [decisions/001-doc-system.md](decisions/001-doc-system.md)。
> 原则:文档领路,代码跟随;证据说话,不是信心说话。

## 导航

从用途选择入口；当前行动项统一见 [plan.md](plan.md)。目录按文档职责组织，任务状态看文档自身状态行与对应 GitHub Issue。

### 使用与接入

| 文档 | 职责 |
|---|---|
| [英文 README](../README.md)、[中文 README](../README.zh-CN.md) | 使用入口、当前能力与路线摘要；双语内容一起维护 |
| [sdk.md](sdk.md)、[sdk.en.md](sdk.en.md) | 中/英文 Bun SDK 接入、存储、输入归属与生命周期契约；接口变化时同步 |
| [release.md](release.md) | 英文手动源码预发布操作与失败处理 |

### 现行设计与验收入口

| 文档 | 职责 |
|---|---|
| [plan.md](plan.md) | 项目路线、优先级与当前行动项（**热层**）；已建 issue 的任务使用链接 |
| [内核接入](phases/pi-core-migration.md)、[迁移验收](phases/pi-core-migration-acceptance.md) | 当前内核与 SDK 的施工、证据与未测边界 |
| [上下文管理](phases/context-management.md)、[上下文验收](phases/context-management-acceptance.md) | 上下文策略与专项证据；迁移后的接合验证见迁移验收 |
| [TUI 主界面工作流](phases/tui-main-workflow.md) | 主界面交互设计与跨流程验收 |
| [会话管理](phases/session-management.md) | 新会话、清屏与项目内恢复的施工及验收 |
| [会话恢复体验](phases/session-resume-experience.md) | 清晰标题、按需原文预览与重复浏览缓存；规格见 GitHub #29 |
| [Markdown 渲染](phases/markdown-rendering.md) | 正文与详情渲染、流式显示及源码复制的施工与验收 |
| [decisions/](decisions/) | ADR：已定决策及其替代关系，防重新争论 |

### 历史施工与研究依据

| 文档 | 职责 |
|---|---|
| [phases/](phases/) | 施工图全量目录（**温层**）；历史阶段与主题施工记录均保留 |
| [旧内核批次](phases/owned-core.md)、[旧 SDK 批次](phases/sdk.md) | 原批次设计与证据；当前接口从上方 SDK 指南与内核接入阅读 |
| [GitHub 交付](phases/github-delivery.md) | 命名、CI、草稿预发布的施工与验证记录 |
| [design-rationale.md](design-rationale.md) | 跨调研综合后的设计论证与探测证据（**冷层**） |
| [research/](research/) | 固定源码快照的上游/专题深度调研（**冷层**）；候选建议的采用范围以 ADR 与施工图为准 |
| [lessons.md](lessons.md) | 教训库（LL-XXX），入库有质量门禁 |

### 协作约定

| 文档 | 职责 |
|---|---|
| [SOP.md](SOP.md) | 工作规则、改动分级、流程骨架、裁剪原则、验证纪律与 review 交接 |
| [Issue tracker](agents/issue-tracker.md) | GitHub Issues 操作与规格、任务进度、施工图的职责边界 |
| [Domain docs](agents/domain.md) | single-context 领域文档的读取与写入约定；根目录 `CONTEXT.md` 按需创建 |
| [Triage labels](agents/triage-labels.md) | triage 角色到 GitHub 标签的映射 |
| [templates/](templates/) | ADR / feature doc / review request 模板 |

## 位置与命名规范

| 位置 | 内容 | 命名 |
|---|---|---|
| `docs/decisions/` | 架构决策记录(ADR) | `NNN-slug.md`,三位数字递增,不重排不复用 |
| `docs/phases/` | 阶段或功能施工图 | 历史阶段用 `phase-{N}.md`;当前按主题命名(如 `session-management.md`、`markdown-rendering.md`),不另建一套数字路线 |
| `docs/research/` | 固定快照的源码调研、可迁移结论与未决问题 | `{topic}.md` |
| `docs/templates/` | 文档模板 | `{type}.md` |
| `docs/agents/` | Skills 的项目配置 | `issue-tracker.md`、`domain.md`、`triage-labels.md` |
| `review-notes/`(仓库根) | 跨 session 的 review 交接信 | `YYYY-MM-DD-{topic}-review-request.md` |

- 教训条目:`LL-XXX` 三位递增,发布后不删不改 ID;重大改写保留 ID 并记录更新与原因。
- 日期一律 `YYYY-MM-DD`。

根目录 `CONTEXT.md` 只维护领域术语，按需创建；具体接口契约通过链接引用现有权威文档。Skills 的施工与交接流程见 [SOP](SOP.md#skills-接入)。

## 分层原则(2026-08-31 operator 确认)

给不给文件夹,看两条:**数量是否无界增长** × **是否被单独精确引用**。

- 数量无界 + 单独引用(decisions/、research/、review-notes/)→ 文件夹,一文一件。
- 整体消费 + 条目短(lessons.md)→ 单文件;拆分触发条件:条目多到无法整体阅读。
- 施工图统一放在 `docs/phases/`:2026-09-01 因第二份施工图出现而从平铺目录迁入。阶段编号保留历史含义,后续路线以 `plan.md` 为准。

## 元信息约定

新类型文档(decisions/、review-notes/)开头带最小 frontmatter:

```yaml
---
doc_kind: decision        # decision | plan | note | review-request
created: 2026-08-31
---
```

正文首行用状态行(延续现有文档风格):`> 状态:<状态词>(日期)`。状态词按文档性质取——决策类用 `草稿 / 已批准 / 被 NNN 取代`;流程与索引类用 `生效 / 启用`;施工图类用 `实现中 / 已完成 / 草稿`。
**状态只写在一处**:文档自己的状态行。别的文档引用它时给链接,不复制状态。

## 生命周期

- **热层** —— plan.md:完成的行动项移除,不堆积。
- **温层** —— `phases/*.md` 施工图:维护对应阶段的施工契约与验证证据;结束后保留,状态行区分已完成、已中止和待交付审核。
- **冷层** —— design-rationale / decisions / research / lessons / review-notes:保留决策与证据历史。经 operator 确认退出项目范围的研究材料可从工作树移除；仍被引用的证据改为固定 Git 提交链接。

## 有意不采用

以下机制暂缓，历史取舍与再议条件见 [decisions/001-doc-system.md](decisions/001-doc-system.md)「明确不迁移」:
F 编号 feature 系统 + ROADMAP 表格、CI 文档校验脚本、guides/ registry、sop-definitions、perspectives/、harness-feedback 评估系统、多模型角色卡。
