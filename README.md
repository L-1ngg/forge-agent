# my-coding-harness

> 当前为自有 compositor 的 Phase 2.2;operator 阶段验收结论、交付边界和验证证据见 [施工图](docs/phases/phase-2.2.md),后续事项见 [docs/plan.md](docs/plan.md)。体验与其余优化按 operator 后续要求安排。

个人 coding harness:一个自己拥有的 AI 编程助手。技术栈 **TypeScript + Bun**。

## Why

设计吸取三个不重叠的参考项目:[pi](https://github.com/earendil-works/pi)(依赖底座)、[grok-build](https://github.com/xai-org/grok-build)(TUI 设计)、[clowder-ai](https://github.com/zts212653/clowder-ai)(协作语义、记忆、文档系统)。四条核心决策与论证见 [docs/plan.md](docs/plan.md) §0。

## 架构

monorepo 五包:`protocol` 定义事件;`core` 使用 pi `Agent` 与 `tools`;`tui` 只依赖 `protocol` 和 Node 内置模块;`cli` 连接两侧。依赖方向与铁律见 [docs/plan.md](docs/plan.md) §1。

## 路线图

Phase 0 底座验证 → Phase 1 每天能用 → Phase 2 TUI 升级 → Phase 2.5 Team → Phase 3 产品化。
各 Phase 施工图:[docs/phases/](docs/phases/)。

## 运行

```bash
bun install --frozen-lockfile
MYH_PROVIDER=provider-id MYH_MODEL=model-id MYH_API_KEY=secret bun run myh
```

也可以在 `.myh/config.json` 配置 `provider`、`model`、可选的 `baseUrl` 与 `apiKey`;字段名区分大小写,未知顶层字段(如 `api_Key`)会在启动时被拒绝。`apiKey` 支持 `"$ENV_VAR"` 和 `"!command"`,也可直接使用 `MYH_API_KEY` 或 provider 的原生环境变量(如 `XAI_API_KEY`)。缺少凭据会在进入 TUI 前报错。`baseUrl` 用于把内置 provider 指向兼容代理。Headless 模式:

```bash
bun run myh -- -p "read package.json and summarize it" --json
```

会话默认写入 `.myh/session.jsonl`;可用 `--session PATH` 指定其他 v3 JSONL 文件。

交互宿主为 alt-screen;`ui.host = "main"` 当前也是 alt 的别名。`Enter` 按 FIFO 排队,`Ctrl+Enter` 取消当前 turn 并替换待发送队列,`Ctrl+C` 取消执行并退出。卡片 `Esc` 为 park,`Tab` / `Space` 返回;`PgUp` / `PgDn` 滚动卡片内容或 transcript。滚轮与 OSC 52 尚未实现。

`bun run check` 运行依赖门禁、workspace typecheck 和全部测试,包括本地 HTTP provider replay 与 Linux/macOS PTY 交互回归。Headless 的 provider error 返回 1,取消返回 130,交互请求仍保留 20-24 的既有退出码。

## 文档

- [docs/README.md](docs/README.md) —— 文档系统入口:目录分工、命名规范、写作纪律
- [AGENTS.md](AGENTS.md) —— AI 协作者入口
- [docs/SOP.md](docs/SOP.md) —— 开发协作流程
