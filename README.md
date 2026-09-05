# forge-agent

> 定位与复用边界见 [ADR-008](docs/decisions/008-general-agent-positioning.md),路线见 [docs/plan.md](docs/plan.md)。既有交付与未测项见 [Phase 2.2](docs/phases/phase-2.2.md),不因重新定位重开该阶段。

一个可独立运行、可分层复用、可派生定制的通用单 Agent 项目。技术栈 **TypeScript + Bun**。Coding 是已有能力,资料调研与报告是首个非 coding 验证场景。

支持直接运行 CLI/TUI、通过仓库内 Bun SDK 嵌入应用、fork 后定制完整 agent。CLI 默认提示词和工具仍面向 coding;SDK 由宿主显式装配能力。包仍为仓库内私有包,通用能力扩展与对外发布尚待实现。SDK 接入见 [docs/sdk.md](docs/sdk.md),示例见 [examples/embedded-agent.ts](examples/embedded-agent.ts)。

## Why

设计吸取三个不重叠的参考项目:[pi](https://github.com/earendil-works/pi)(依赖底座)、[grok-build](https://github.com/xai-org/grok-build)(TUI 设计)、[clowder-ai](https://github.com/zts212653/clowder-ai)(协作语义、记忆、文档系统)。历史论证见 [docs/design-rationale.md](docs/design-rationale.md),当前边界以 ADR-008 为准。

## 架构

monorepo 五包的职责如下。运行时依赖由 `scripts/check-deps.ts` 检查;`pi-ai` 的导入仅允许出现在 `packages/core/src/pi-port.ts`。

| 包 | 职责 |
|---|---|
| `protocol` | 自有事件、请求、响应与展示数据契约 |
| `core` | 自研 `ExecutionCore`、权限、会话、生命周期与 SDK;依赖 `protocol`、`tools` |
| `tools` | 工具契约与内置 coding 工具;业务能力由宿主装配 |
| `tui` | 自有 cell compositor 与终端交互;只依赖 `protocol` 和 Node 内置模块 |
| `cli` | 配置、凭据、coding 能力与存储装配,连接 SDK、headless 和 TUI |

按 [ADR-009](docs/decisions/009-self-owned-agent-core.md),已移除 `pi-agent-core`,保留 `pi-ai` 的模型调用、认证与流解析。SDK 入口为 `@forge-agent/core/sdk`,同实例一次运行一个 invocation,多个实例可独立运行。输入接收、取消和提交契约见 [SDK 接入](docs/sdk.md);施工与验证见 [自研执行内核](docs/phases/owned-core.md) 和 [SDK 施工图](docs/phases/sdk.md)。

## 路线图

自研执行内核 → 通用内核与 SDK → 能力扩展与调研报告 → 长任务可靠性 → 服务 API 与分发。
本项目聚焦单 agent;Team 调度、消息路由、任务板和 dashboard 归外部项目。同进程 SDK 不提供进程级沙箱。
各 Phase 施工图:[docs/phases/](docs/phases/)。

## 运行

```bash
bun install --frozen-lockfile
FORGE_AGENT_PROVIDER=provider-id FORGE_AGENT_MODEL=model-id FORGE_AGENT_API_KEY=secret bun run forge-agent
```

也可以在 `.forge-agent/config.json` 配置 `provider`、`model`、可选的 `baseUrl` 与 `apiKey`;字段名区分大小写,未知顶层字段(如 `api_Key`)会在启动时被拒绝。`apiKey` 支持 `"$ENV_VAR"` 和 `"!command"`,也可直接使用 `FORGE_AGENT_API_KEY` 或 provider 的原生环境变量(如 `XAI_API_KEY`)。缺少凭据会在进入 TUI 前报错。`baseUrl` 用于把内置 provider 指向兼容代理。Headless 模式:

```bash
bun run forge-agent -- -p "read package.json and summarize it" --json
```

会话默认写入 `.forge-agent/session.jsonl`;可用 `--session PATH` 指定其他 v3 JSONL 文件。

交互宿主为 alt-screen;`ui.host = "main"` 当前也是 alt 的别名。`Enter` 按 FIFO 排队,空输入框 `Up` 取回队尾编辑;普通 `Esc` 停止续发并恢复草稿,`Ctrl+Enter` 等当前任务收尾后仅发送指定输入,其余队列恢复草稿。提交失败保留待发内容并暂停续发,`Ctrl+C` 取消执行并退出。卡片 `Esc` 为 park,`Tab` / `Space` 返回;`PgUp` / `PgDn` 滚动卡片内容或 transcript。提交与取消边界见 [ADR-010](docs/decisions/010-input-ownership-and-interruption.md)。滚轮与 OSC 52 尚未实现。

`bun run check` 运行依赖门禁、workspace typecheck 和全部测试,包括本地 HTTP provider replay 与 Linux/macOS PTY 交互回归。Headless 的 provider error 返回 1,取消返回 130,交互请求仍保留 20-24 的既有退出码。

## 文档

- [docs/README.md](docs/README.md) —— 文档系统入口:目录分工、命名规范、写作纪律
- [AGENTS.md](AGENTS.md) —— AI 协作者入口
- [docs/SOP.md](docs/SOP.md) —— 开发协作流程
