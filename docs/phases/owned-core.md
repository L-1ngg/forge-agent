# 自研执行内核施工图

> 状态:实现中(2026-09-05)。review 的三项修复及 ADR-010 输入归属修复已通过自动化回归,完整内核验收仍待完成;本批落实 [ADR-009](../decisions/009-self-owned-agent-core.md),不重开 Phase 2.2。

## Entry

原始要求:“请你按照这份规划的文档实现,你可以自主决策是否有必要多agent来提效”。按路线顺序先完成执行内核替换,SDK 与后续能力另批施工。既有工作区文档和图片删除保留,不自动提交。

替换前 `bun run check` 基线:240 pass / 0 fail。旧人工验收豁免不作为新内核证据。

## Design

- `packages/core/src/execution-core.ts` 拥有上下文、模型/工具循环、事件与实例队列;仅依赖自有协议,通过注入回调调用模型和工具。
- `packages/core/src/pi-port.ts` 保留 pi-ai 的模型目录、认证、流解析与消息转换,连接同一自研内核;真实和 faux provider 共用生产执行路径。
- 工具校验后执行改写与权限策略;授权对象与实际执行对象一致。并行调用独立收集结果,单项失败不能丢失其他结果。
- `length` 消息中的工具调用全部生成失败结果,不进入改写、授权或执行;结果序列化异常也作为单项工具失败收集,整批完成前不结束调用或释放实例。
- 仅当非空工具批次的所有结果都要求 `terminate` 时停止自动工具循环;混合允许/拒绝批次继续交给模型处理。停止工具循环后仍按顺序处理已排队的 steering 和 follow-up。
- steering 在工具批次后、下一次模型请求前进入上下文;follow-up 在当前循环结束后按 FIFO 继续。按 [ADR-010](../decisions/010-input-ownership-and-interruption.md),队列只属于活动执行,结束时同步关闭接收并结算未处理确认。取消清空内核队列并恢复调用前上下文,宿主依据确认恢复未处理草稿;SDK 提交开始后不承诺撤销存储。具体契约及验收见 [SDK 施工图](sdk.md)。
- `AgentRunner` 继续负责完整调用的原子持久化;提前关闭迭代器必须等待运行清理。供应商 continuation 字段原样保留。
- 不引入永久双引擎、Run/Step、预算、检查点、SDK 公共接口、Team 或 TUI 美化。

## Batches

1. 锁定契约:新增真实生产路径的工具失败、权限取消、队列、实例隔离测试。
2. 切换核心:实现执行内核与 pi-ai 适配,保持 CLI/TUI 接入契约。
3. 收口:移除 pi-agent-core 依赖、加依赖门禁、更新 lockfile 与当前状态文档。

## Verify / Release

出口逐项对应 ADR-009 AC-CORE-01 至 AC-CORE-08。运行 focused loop/core tests,再运行 `bun run check`、frozen install、受控真实 provider 请求。PTY、HTTP replay、Responses 终态和 usage 回归必须继续通过。真实请求仅使用空历史与无副作用工具,不读取项目内容或输出凭据。

反向验证:新增权限等待取消终态测试在旧内核失败(错误终态而非 aborted),替换后必须通过;依赖门禁 fixture 注入旧内核包与导入,必须拒绝。

- [ ] 自研路径通过全部执行契约与取消/隔离测试。
- [ ] 依赖门禁、typecheck、完整测试与 frozen install 通过。
- [ ] 受控真实 provider 文本和工具循环验证,记录未测范围。
- [ ] 状态文档与实际实现一致,后续路线不冒充已交付。

本次 review 修复验收:

- [x] AC-REVIEW-01:`length` 携带合法工具参数时也不执行,每个调用均有失败终态与配对结果。
- [x] AC-REVIEW-02:`BigInt`、循环引用和抛异常的 `toJSON()` 不影响其他工具收尾,批次完成前拒绝实例重入。
- [x] AC-REVIEW-03:混合权限批次继续模型回复;全部拒绝时不自动重试,已排队输入仍在当前调用中处理。

## Rollback

不更改会话格式或配置格式。提交前由 operator 审核差异,之后以独立提交作为回退点;本轮不自动创建提交。若回退需整体恢复执行适配、依赖和 lockfile,保留 pi-ai Responses 补丁,不通过运行期开关长期维持双引擎。

## Evidence

- Ran:替换前 `bun run check`,240 pass / 0 fail。本次 review 修复先增加 6 个回归用例,修复前 focused 测试为 7 pass / 5 fail,失败分别命中截断调用、序列化收尾、混合权限和两类队列,全拒绝无队列的对照用例通过。
- Ran:修复后 `bun test tests/loop-contract packages/core/test`,64 pass / 0 fail;最终 `bun run check`,依赖门禁、全部包 typecheck 通过,255 pass / 0 fail(含 PTY、HTTP replay、Responses 终态与 usage);`git diff --check` 通过。
- Not run:本次未运行 frozen install、真实 provider 请求、长期真实任务和多供应商实测。
- Why:本次范围为已确认的三项调度回归,使用 faux provider 驱动同一生产内核并以完整自动化检查验证;未修改依赖或模型适配。
- Risk:序列化失败按工具错误返回,不会撤销工具已发生的副作用。同进程取消仍需工具配合 AbortSignal;本批不提供进程隔离或强制杀死任意宿主工具。完整内核验收不能仅据本次自动化结果声明通过。
