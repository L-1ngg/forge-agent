# docs/ — 文档系统

> 状态:生效(2026-09-21)。职责分工见 [ADR-001](decisions/001-doc-system.md)，归档与读取规则见 [ADR-020](decisions/020-document-archival.md)。
> 原则:文档领路，代码跟随；证据说话，不是信心说话。

## 当前导航

按任务选择入口，不默认通读整个目录。当前行动项见 [plan.md](plan.md)；任务规格、验收标准与任务状态以对应 GitHub Issue 为准，施工图维护接口、实施约束和证据。

### 使用与接入

| 文档 | 职责 |
|---|---|
| [英文 README](../README.md)、[中文 README](../README.zh-CN.md) | 使用入口、当前能力与依赖边界；双语一起维护 |
| [sdk.md](sdk.md)、[sdk.en.md](sdk.en.md) | 中/英文 Bun SDK 接入、输入归属、存储与生命周期合同 |
| [release.md](release.md) | 英文手动源码预发布操作与失败处理 |

### 内核、宿主与扩展

| 文档 | 职责 |
|---|---|
| [内核接入](phases/pi-core-migration.md)、[迁移验收](phases/pi-core-migration-acceptance.md) | 固定 Pi 内核来源、定制范围、SDK 接线与未测边界 |
| [职责收敛](phases/architecture-responsibilities.md)、[会话装配](phases/agent-assembly.md) | AgentTurn.result、输入归属、压缩协调和统一装配 |
| [StreamFn](phases/stream-fn.md)、[逐轮停止策略](phases/turn-policy.md) | 模型流注入、双调用路径、shouldStopAfterTurn 与调用用量 |
| [Skills 设计](phases/skills.md)、[Skills 验收](phases/skills-acceptance.md) | 本地分层发现、按需加载、显式输入及配置提交边界 |
| [架构决策](decisions/) | ADR 及替代关系；先读状态行，再沿当前决策指针读取 |

### 上下文、记忆与会话

| 文档 | 职责 |
|---|---|
| [默认上下文压缩](decisions/018-adaptive-default.md) | CLI/SDK 默认策略与旧会话恢复行为 |
| [压缩设计](phases/adaptive-context-compaction.md)、[首次验收](phases/adaptive-context-compaction-acceptance.md) | 独立状态、证据、预算及首次真实模型对照；首次实验不证明后续投影质量 |
| [短检查点与历史搜索](phases/context-notes-search.md) | 当前请求投影、search_context、软件验证和未测质量边界 |
| [持久记忆](phases/persistent-memory.md) | Markdown、会话内更新、worktree 副本与质量/成本验收 |
| [宿主上下文变换](phases/context-transform.md)、[分层预算决策](decisions/021-host-context-transform-and-request-budget.md) | transformContext、记忆组合、最终请求预算的接口与本地验收证据 |
| [会话管理](phases/session-management.md)、[首次写入](phases/session-first-write.md) | 新会话、清屏、项目内恢复及增量落盘 |
| [会话恢复体验](phases/session-resume-experience.md)、[记录浏览](phases/transcript-browser.md) | 会话标题、原文预览、缓存与历史浏览 |
| [实验与验收数据](research/README.md) | 仍被现行验收引用的原始数据、运行方法及证据限制 |

### 界面与测试

| 文档 | 职责 |
|---|---|
| [TUI 主界面工作流](phases/tui-main-workflow.md) | 主界面交互与跨流程验收 |
| [Markdown 渲染](phases/markdown-rendering.md) | 正文与详情渲染、流式显示和源码复制 |
| [测试体系](phases/testing-system.md)、[测试施工与验收](phases/testing-system-implementation.md) | 测试分层、确定性证据、平台和网络隔离边界 |

### 协作约定

| 文档 | 职责 |
|---|---|
| [SOP.md](SOP.md) | 工作规则、流程裁剪、验证纪律与交接 |
| [Issue tracker](agents/issue-tracker.md) | GitHub Issues 与施工图的职责分工 |
| [Domain docs](agents/domain.md)、[CONTEXT.md](../CONTEXT.md) | single-context 读取规则与领域术语 |
| [Triage labels](agents/triage-labels.md) | triage 角色到标签的映射 |
| [lessons.md](lessons.md)、[templates/](templates/) | 教训库与 ADR / feature / review 模板 |

## 归档与读取规则

历史材料统一从[归档索引](archive/README.md)进入，仅用于追溯历史决策、旧版本行为、回归来源或用户指定的研究。日常设计和实现按上方当前导航读取。

- **按适用性归档**：已被替代的合同、已中止路线和完成选型使命的研究进入 `docs/archive/`。年份久、任务已完成，都不是单独的归档理由；仍适用的设计与必要验收证据留在现行目录。
- **先保留现行约束**：混合文档中的有效合同、未测项与豁免先转入当前权威入口，再迁移整份旧记录。原始实验数据保持内容和证据含义。
- **保留历史**：归档文件添加归档状态、日期和当前入口；原状态标作历史状态。过去的“当前”“下一步”“待实现”按其记录版本解释，不是新的任务授权。归档不能把未测、中止或豁免改成通过。
- **修复引用**：迁移时更新入链、相对路径和索引。当前导航只推荐现行合同；指向归档的其他引用明确用于历史追溯。ADR 编号和路径保持稳定，以状态及替代指针说明效力。
- **默认跳过**：根目录 `.ignore` 排除 `/docs/archive/`，默认 `rg` 内容搜索和 `rg --files` 跳过归档。追溯时使用 `rg --no-ignore '关键词' docs/archive`，或直接读取明确路径。此规则不约束所有工具；使用 `find`、脚本或递归读取时也应主动排除归档。
- **版本管理有别**：`docs/archive/` 继续由 Git 管理；`review-notes/` 仅在本地保存，由 `.gitignore` 排除。项目合同与可共享验收证据不能只留在本地交接中。

维护时同步文档状态、当前导航、归档索引及 `plan.md` 行动项，检查本地文件链接和受影响锚点。只为整理文档无需重跑运行时全量测试；报告实际执行的文档检查即可。

## 验收边界

验收记录只证明对应版本、环境和实际执行范围。当前内核证据从[迁移验收](phases/pi-core-migration-acceptance.md)及各功能记录进入，后续文档整理不产生新的测试结果。

- Phase 1 人工验收与 Phase 2 E1–E3 按 operator 2026-09-01 指示暂缓实测并按豁免处理，不能声明人工验收通过。
- 历史 Phase 2.2 关闭不等于通用 Agent 或对外 SDK 全部验收；AC-14、5 天 dogfooding、真实 provider 多轮工具/session/取消矩阵不由旧离线测试证明。后续安排见 [plan.md](plan.md)。
- B6 按 [ADR-007](decisions/007-no-compile-grok-reference.md) 使用 in-repo cell golden，不编译 grok-build。
- WSL 验收不能推广为全部平台、供应商和长期质量结论；Linux OS 断网与 macOS fixture 兼容性按[测试证据](phases/testing-system-implementation.md)分别解释。
- 真实模型质量、费用、人工长期使用与确定性软件合同分别验收。旧保留集结果不证明新投影或后续实现有效；明确的未测项保留在对应验收文档。

## 位置与命名规范

| 位置 | 内容 | 命名 |
|---|---|---|
| `docs/decisions/` | 架构决策及替代关系 | `NNN-slug.md`，三位递增，不重排不复用 |
| `docs/phases/` | 当前适用的功能施工图与验收证据 | 按主题命名，如 `session-management.md` |
| `docs/research/` | 当前仍需消费的研究与原始实验依据 | `{topic}.md` 或专题目录 |
| `docs/archive/` | 已被替代的历史材料 | 保留原类别与文件名，索引说明当前入口 |
| `docs/templates/` | 文档模板 | `{type}.md` |
| `docs/agents/` | 协作技能的项目约定 | 如 `issue-tracker.md`、`domain.md` |
| `review-notes/`（仓库根，本地） | 跨 session 交接 | `YYYY-MM-DD-{topic}-review-request.md` |

教训条目用 `LL-XXX` 三位递增，发布后不删改 ID；重大改写保留 ID 并记录原因。日期一律 `YYYY-MM-DD`。根目录 `CONTEXT.md` 只维护领域术语，具体合同链接既有权威文档。Skills 施工与交接流程见 [SOP](SOP.md#skills-接入)。

## 元信息与生命周期

决策、计划和交接等文档沿用模板中的最小 frontmatter：

```yaml
---
doc_kind: decision        # decision | plan | note | review-request
created: 2026-09-21
---
```

正文使用状态行 `> 状态:<状态词>(日期)`：ADR 用 `草稿 / 已批准 / 被 NNN 取代`；流程与索引用 `生效`；施工图用 `草稿 / 实现中 / 已完成`；历史材料用 `已归档` 并保留历史状态。文档效力在自身状态行维护，其他入口链接它，避免复制容易过期的进度。

`plan.md` 只保留当前行动项；功能完成后，仍适用的合同和验收证据继续维护；被替代后按上述规则归档。数量无界且被独立引用的 ADR、研究和交接一文一件；短条目整体消费的教训继续用单文件。阶段编号保留历史含义，不另建一套编号路线。

## 有意不采用

暂不引入 F 编号 feature 系统、ROADMAP 表格、CI 文档校验脚本、guides registry、sop-definitions、perspectives、harness-feedback 评估系统或多模型角色卡；历史取舍与再议条件见 [ADR-001](decisions/001-doc-system.md)。
