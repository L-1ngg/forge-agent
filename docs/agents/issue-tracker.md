# Issue tracker: GitHub
> 状态:生效(2026-09-07)

Skills 的任务与规格使用 `L-1ngg/forge-agent` 的 GitHub Issues，通过 `gh` 操作。

## 规格与进度归属
- GitHub Issues 维护请求、需求规格、任务范围与任务级验收标准；任务状态、标签、依赖和认领以对应 issue 为准。
- `docs/plan.md` 维护项目路线、优先级与当前阶段入口；已建 issue 的任务只保留链接，不复制其开关状态、标签或验收清单。
- `docs/phases/` 维护中、大改动的整体施工设计、跨任务验收、验证证据与发布边界；任务级验收引用对应 issue，issue 引用相关施工图。
- `to-spec` 发布需求规格时引用已有施工图；`to-tickets` 拆分后，父规格保留整体需求，子任务维护各自的范围和验收，父规格通过链接索引子任务。
- 同一条验收标准只在所属规格、任务或施工图中定义一次，其他载体按链接和 AC 编号引用。历史施工图中的标准继续留在原处，新 issue 按需引用。
- 任务关闭不代表阶段交付或人工验收通过；这些结论以施工图的验证证据与交付边界为准。

实施与交接流程遵循 [SOP](../SOP.md#skills-接入)，历史文档保持原位。

## 操作约定
- 在仓库内运行 `gh`，由 git remote 确定目标；在其他目录显式指定 `--repo L-1ngg/forge-agent`。
- 创建：`gh issue create --title "..." --body-file <file>`。多行正文使用文件传入。
- 读取：`gh issue view <number> --comments`；需要结构化数据时使用 `--json number,title,body,labels,comments`。
- 列表：`gh issue list --state open --json number,title,body,labels`，按需使用 `--label` 筛选。
- 评论：`gh issue comment <number> --body-file <file>`。
- 标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`。
- 关闭：`gh issue close <number>`。
- “publish to the issue tracker”表示创建 GitHub issue；“fetch the relevant ticket”表示读取 issue 及评论。
- issue 与 PR 共用编号空间；编号类型不明时先用 `gh pr view <number>` 判别，再读取对应对象。

## Pull requests as a triage surface
**PRs as a request surface: no.**

## Wayfinding
- map 使用带 `wayfinder:map` 标签的 issue，正文维护 Notes、Decisions-so-far、Fog。
- 子任务优先用 GitHub sub-issues 关联；不可用时在 map 中维护任务列表，子任务注明 `Part of #<map>`。
- 子任务类型标签为 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`。
- 阻塞关系使用 GitHub 原生 issue dependencies，API 中使用 issue 数据库 ID；不可用时在子任务顶部记录 `Blocked by: #<n>`。
- 按 map 顺序选择未关闭、无未关闭阻塞项且未分配的子任务；认领使用 `gh issue edit <number> --add-assignee @me`。
- 解决后记录结果、关闭子任务，并在 map 的 Decisions-so-far 补充结论与链接。
