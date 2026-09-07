# Domain docs
> 状态:生效(2026-09-07)

采用 single-context，所有 workspace 包共享领域词汇与架构决策。

## 探索前读取
- 遵循根目录 `AGENTS.md` 的真相源层级。
- 根目录 `CONTEXT.md`：领域概念与术语；不存在时继续工作，不主动要求补建。
- `docs/decisions/`：读取与当前任务有关的 ADR；命名沿用 `NNN-slug.md`，模板见 `docs/templates/adr.md`。
- `CONTEXT.md` 由 domain-modeling 在术语实际确定时按需创建；ADR 统一写入现有 `docs/decisions/`。

## 消费规则
- Issue、设计建议、假设与测试名称使用领域文档定义的术语，避免同义词漂移。
- 缺少术语时先核对现有代码与文档；确有概念缺口时交由 domain-modeling 梳理。
- 与现有 ADR 冲突的建议必须指出具体 ADR 与重新讨论的理由，遵循项目既有决策变更流程。
