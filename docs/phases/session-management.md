---
doc_kind: plan
created: 2026-09-09
---

# 会话新建、清屏与恢复

> 状态:已完成(2026-09-09)。产品规格与验收标准已发布到 [GitHub #27](https://github.com/L-1ngg/forge-agent/issues/27)，本文件记录实现与验证；已按 operator 的 implement 授权完成本地实现、自动化与真实 PTY 验证；operator 已确认 WSL 下验证通过，尚未推送或发布。规格与任务归属遵循 [Issue tracker](../agents/issue-tracker.md)。

## Why

改动前 CLI 默认打开固定 `.forge-agent/session.jsonl`，启动即创建文件。用户希望默认启动独立新会话，无交互时不保留，通过 `/resume` 主动选取旧会话。保留 Forge 的 `/clear` 只清屏语义，不照搬 Codex 同名命令。

术语见根目录 [CONTEXT.md](../../CONTEXT.md)。现有保存与生命周期约束见 [SDK 接入](../sdk.md)、[ADR-010](../decisions/010-input-ownership-and-interruption.md) 和 [ADR-014](../decisions/014-pi-aligned-context-management.md)。

## 规格归属

已确认交互、完整用户故事、范围边界和 AC-1 至 AC-14 统一维护在 [GitHub #27](https://github.com/L-1ngg/forge-agent/issues/27)。包括最后确认的 CLI `--session` 与配置 `sessionPath` 移除、SDK `storage` 保留；不再将显式路径兼容作为待决产品行为。

## 施工方向

- **TUI**：在 `packages/tui/src/app.ts` 处理命令、选择器和切换状态；通过宿主接口请求会话切换。清屏不操作 Core 历史。
- **CLI 宿主**：在 `packages/cli/src/` 管理会话发现、路径、延迟创建与实例切换。`main.ts` 已通过 `SessionHost` 完成装配，具体接口见本轮施工选择。
- **Core / SDK**：优先复用创建、取消、等待收尾、存储与释放契约；不引入 slash command 解析。延迟创建不得降低 `SessionStorage.append()` 成功后可重载的保证。
- **资源释放**：当前 SDK 的 `dispose()` 还会释放实例拥有的请求总线，切换需连同权限请求订阅与界面事件绑定重新装配，不能只替换消息数组。
- **保存范围**：保持原始消息、压缩记录及未知工具副作用的既有语义；恢复不自动重放工具。

## 工程边界

- 项目目录和排序数据来源已确定，见本轮施工选择。
- `--session` / `config.sessionPath` 已从参数和配置中移除，帮助、README、SDK 指南、烟测与 headless 回归同步；旧默认文件按项目发现，不覆盖或删除。
- 目标实例在旧实例释放前准备，加载失败保留旧实例；宿主和 TUI 均阻止重入切换，选择当前会话不触发释放。保存故障停止切换，实例保持停用，需检查历史后重新启动。
- 恢复列表按需只读扫描，没有索引数据库；`SessionStore.open({ create: false })` 防止缺失文件被重新创建，`appendable` 检查阻止直接续写损坏或缺末尾换行的文件。

## 验证归属

本轮以宿主会话生命周期、TUI 命令及选择器、文档与端到端验证作为一个提交范围完成。

测试接缝、批准状态、既有测试先例与失败注入要求见规格的 Testing Decisions。后续任务引用 AC 编号，不在本文件复制验收清单。真实 TUI 操作验证与自动化分开记录，仅测试通过不代表真实交互验收。

## Release / Rollback

功能出口按规格 AC 验证，证据见下文；operator 已确认 WSL 验收通过并授权关闭对应 Issue；未执行源码推送或功能发布。

实现应保持既有 v4 会话可读，不原地转换或删除旧文件。代码回退保留新产生的会话数据；匹配旧 CLI 时可使用旧版显式路径能力，或通过 SDK SessionStore 读取新目录中的 v4 文件。不清理会话目录来回退功能。

## 当前证据

- 已只读核查 CLI 装配、TUI `/clear`、AgentSession 保存、SessionStore 和 SDK 生命周期契约。
- 已实现并通过局部回归：CLI 新会话/首条保存、TUI 清屏/新建/恢复/草稿、运行中工具收尾、保存故障阻止切换、worktree 隔离、旧默认文件和压缩历史恢复。
- 真实 CLI + Bun.Terminal PTY 已通过空退出、清屏、新建、恢复、活动取消与重启流程；模型服务使用本地可控 HTTP 响应，没有调用外部真实 provider。
- 反向验证：临时使新实例错误复用旧会话存储，TUI 上下文隔离回归失败；恢复实现后通过。
- Ran：`bun run check` 完整通过，485 pass / 0 fail，70 个测试文件；含依赖边界、workspace 与 automation 类型检查。`bun run test:headless` 和 `bun run typecheck:examples` 均通过。
- Standards / Spec 两轴初审分别发现 1 / 2 项问题（共享一项压缩保存故障保护问题）。已修复压缩故障不阻止切换及原 cwd 删除后会话丢失的问题，新增两项先红后绿回归；最终两轴复审均无剩余可执行问题。
- Not run / Why：Agent 自动化与 PTY 验证没有调用外部真实 provider，状态与故障使用本地可控 HTTP 复现；未执行 macOS 或断电验证，也未记录长期使用验收，本轮环境为 WSL/Linux。operator 的模型/provider 与逐项测试场景未提供，不推定其覆盖范围。
- Risk：JSONL 沿用非断电事务存储边界；不配合取消的工具可能延长切换等待。大型项目的旧文件发现仍使用目录扫描，尚无大规模性能基准。

验证定位：`packages/cli/test/session-host.test.ts` 覆盖持久化、项目归属和上下文恢复；`packages/cli/test/session-ui.test.ts` 覆盖真实宿主与 App 输入/显示/故障切换；`tests/tui-integration/session-management.test.ts` 直接启动 CLI 并通过 Bun.Terminal 操作。既有 SDK runtime-session、session-conversion 与增量保存回归随完整套件运行。

## Operator 人工验证

2026-09-09，operator 针对实现提交 `4a7cd20` 反馈：“上述实现我以wsl下验证通过”。据此记录本次实现的 WSL 人工验证通过；未提供逐项测试清单、模型/provider 或长期使用时长，不将此反馈扩展为其他平台、外部 provider 矩阵或断电验证通过。

## 本轮施工选择

- CLI 新增 SessionHost，公开 current/list/switchTo/dispose；TUI 通过结构化会话视图接入，不依赖 Core 包。switchTo 先只读验证目标、创建未执行的候选实例，再通知 TUI 暂停输入队列并等待执行流收尾，释放旧实例后发布新视图。退出与切换串行结算，失败销毁候选实例。
- 每个项目根的 `.forge-agent/sessions/` 保存独立 v4 JSONL。首次 append 以排他创建写入 header 和首条 entry，此前无文件副作用；后续复用 SessionStore。header 使用稳定会话身份，cwd 保留实际工作目录；恢复不改变当前工具 cwd。
- Git 项目根使用规范化 worktree 根，非 Git 使用规范化启动目录。恢复扫描新目录及项目内旧 `.forge-agent/session.jsonl`，跳过依赖和 Git 元数据目录；按旧文件所在目录核对项目归属，新目录按受管项目根归属，原 header cwd 仅是历史工具目录。列表从消息时间提取最近活动，不因读取更新时间。旧格式/损坏会话报告诊断，不原地修复。
- TUI 保持一个终端 Host，切换更新 Agent 和请求总线；事件订阅绑定会话代次，避免旧事件污染。恢复选择器使用上下键/Enter/Esc，明确空列表、读取错误和当前会话；原会话未提交输入按身份在内存暂存。
- 命令行可在独立首行输入 `/new` 或 `/resume`，其余编辑内容作为未提交草稿保留；因此空会话有草稿的确认可从键盘到达，不要求额外快捷键。
- 测试优先使用 CLI 宿主 + App 公共输入输出 + 本地 HTTP provider + 临时目录的集成边界。SDK 存储/取消回归沿用现有测试；真实 PTY 验证另行记录。
- 本轮不引入新 schema、数据库或执行引擎；回退代码不删除会话目录。新数据继续可由 SDK SessionStore 读取。
