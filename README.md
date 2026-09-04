# my-coding-harness

> 状态:Phase 2 M1-M6 代码与自动化验收已完成，待人工 UX 验收与 5 天 dogfooding(2026-09-02)。Phase 1 与 Phase 2 E1-E3 按 operator 指示暂缓实测并按豁免处理;AC-14 未实测。行动项见 [docs/plan.md](docs/plan.md)。

个人 coding harness:一个自己拥有的 AI 编程助手。技术栈 **TypeScript + Bun**。

## Why

设计吸取三个不重叠的参考项目:[pi](https://github.com/earendil-works/pi)(依赖底座)、[grok-build](https://github.com/xai-org/grok-build)(TUI 设计)、[clowder-ai](https://github.com/zts212653/clowder-ai)(协作语义、记忆、文档系统)。四条核心决策与论证见 [docs/plan.md](docs/plan.md) §0。

## 架构

monorepo 五包:`protocol`(事件类型,零依赖)→ `core`(编排)→ `cli` / `tui`(只认 protocol)→ `tools`。依赖方向与铁律见 [docs/plan.md](docs/plan.md) §1。

## 路线图

Phase 0 底座验证 → Phase 1 每天能用 → Phase 2 TUI 升级 → Phase 2.5 Team → Phase 3 产品化。
各 Phase 施工图:[docs/phases/](docs/phases/)。

## 运行

```bash
bun install --frozen-lockfile
MYH_PROVIDER=provider-id MYH_MODEL=model-id MYH_API_KEY=secret bun run myh
```

也可以在 `.myh/config.json` 配置 `provider`、`model`、可选的 `baseUrl` 与 `apiKey`;`apiKey` 支持 `"$ENV_VAR"` 和 `"!command"`。`baseUrl` 用于把内置 provider 指向兼容代理。Headless 模式:

```bash
bun run myh -- -p "read package.json and summarize it" --json
```

会话默认写入 `.myh/session.jsonl`;可用 `--session PATH` 指定其他 v3 JSONL 文件。

## 文档

- [docs/README.md](docs/README.md) —— 文档系统入口:目录分工、命名规范、写作纪律
- [AGENTS.md](AGENTS.md) —— AI 协作者入口
- [docs/SOP.md](docs/SOP.md) —— 开发协作流程
