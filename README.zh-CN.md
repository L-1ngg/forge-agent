# Forge Agent

[![CI](https://github.com/L-1ngg/forge-agent/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/L-1ngg/forge-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**通用单 Agent 项目,目前处于个人开发中。**

Forge Agent 提供自研执行内核、可嵌入的 Bun SDK 与终端应用。可以直接用 CLI 完成 coding 任务,通过 SDK 装配工具与提示词,或 fork 后构建专用 Agent。

[English](README.md) · [SDK 接入](docs/sdk.md) · [贡献说明](CONTRIBUTING.md)

## 当前能力

- **自研执行循环:**模型流、工具执行、权限、单次 invocation 内的 steering/follow-up、取消与会话提交。
- **可嵌入 SDK:**实例独立,工具、提示词、权限和存储由宿主提供;CLI 与 SDK 复用同一执行路径。
- **Coding CLI:**读取、写入、编辑和 shell 工具,支持交互 TUI 与 JSON 事件输出。
- **终端界面:**流式 transcript、工具和 diff 展示、权限卡片、输入排队、自有 cell renderer。

模型传输与认证由 [pi-ai](https://github.com/earendil-works/pi) 提供,执行循环与 TUI renderer 由本项目维护。资料调研与报告是后续扩展方向,尚未交付。

## 快速开始

需要 **Bun 1.3.12** 和模型供应商账号。自动化验证面向 Linux/macOS;尚未承诺原生 Windows 或 Node.js 支持。

```bash
git clone https://github.com/L-1ngg/forge-agent.git
cd forge-agent
bun install --frozen-lockfile

# 以 xAI 为例,运行前在 shell 环境中配置密钥。
export FORGE_AGENT_PROVIDER=xai
export FORGE_AGENT_MODEL=grok-4.6
bun run forge-agent
```

使用 `FORGE_AGENT_API_KEY` 或供应商原生变量(如 `XAI_API_KEY`)传入密钥,不要提交凭据。其他模型使用 pi-ai 支持的 provider/model 标识符。

Headless JSON 事件输出:

```bash
bun run forge-agent -- -p "Read package.json and summarize it" --json
```

配置依次加载 `~/.config/forge-agent/config.json`(设置 XDG 时为 `$XDG_CONFIG_HOME/forge-agent/config.json`)、`.forge-agent/config.json`、`FORGE_AGENT_PROVIDER` / `FORGE_AGENT_MODEL` / `FORGE_AGENT_API_KEY`。CLI 参数覆盖 provider/model/session 选择。项目配置可以引用环境变量:

```json
{
  "provider": "xai",
  "model": "grok-4.6",
  "apiKey": "$FORGE_AGENT_API_KEY"
}
```

可选 `baseUrl` 指向兼容代理。字段区分大小写,未知顶层字段会被拒绝。会话默认写入 `.forge-agent/session.jsonl`,可用 `--session PATH` 指定其他文件。

## 嵌入 Agent

包是**仓库内私有 workspace 包**,尚未发布 npm。在本 monorepo 的宿主 package 中声明 `"@forge-agent/core": "workspace:*"`,通过 `@forge-agent/core/sdk` 导入。仓库根目录示例使用相对路径:

```ts
import { createAgent } from "./packages/core/src/sdk.ts";

const agent = await createAgent({
  provider: "xai",
  model: "grok-4.6",
  ...(process.env.FORGE_AGENT_API_KEY ? { apiKey: process.env.FORGE_AGENT_API_KEY } : {}),
  systemPrompt: "Answer concisely.",
  cwd: process.cwd(),
});
try {
  for await (const event of agent.runTurn("Hello")) {
    if (event.type === "message_delta" && event.contentType === "text") {
      process.stdout.write(event.delta);
    }
  }
} finally {
  await agent.dispose();
}
```

SDK 默认使用内存历史,不装配 coding 工具。[自定义工具示例](examples/embedded-agent.ts) 显式提供工具和授权规则:

```bash
bun examples/embedded-agent.ts
```

示例宿主读取 `FORGE_AGENT_PROVIDER`、`FORGE_AGENT_MODEL` 及可选的 `FORGE_AGENT_API_KEY` / `FORGE_AGENT_BASE_URL`。长期宿主接入前先读 [存储、权限与生命周期](docs/sdk.md)。

## 架构

| 包 | 职责 |
|---|---|
| `@forge-agent/protocol` | 事件、请求、响应与展示数据 |
| `@forge-agent/core` | ExecutionCore、模型适配、权限、会话与 SDK |
| `@forge-agent/tools` | 工具契约与内置 coding 工具 |
| `@forge-agent/tui` | cell compositor 与终端交互,只依赖 protocol 和 Node 内置模块 |
| `@forge-agent/cli` | 配置、凭据、工具与存储装配,TUI/headless 入口 |

依赖门禁禁止 core 引入 UI,pi-ai 仅允许从模型适配器导入。Team 编排、消息路由、多 Agent dashboard 归外部宿主项目。

## Roadmap

| 阶段 | 方向 |
|---|---|
| **Now** | 内核与 SDK 真实任务验收,补齐剩余验收项 |
| **Next** | 工具和 Skills 扩展,来源可追溯的资料调研与报告 |
| **Later** | 上下文管理、恢复与长任务可靠性,之后是服务 API 与分发 |

[开发规划](docs/plan.md) 是行动项真相源。以上是方向,不承诺发布日期。

## 开发状态与限制

个人持续开发中,API 与配置可能变化。自动化通过不代表完整真实供应商与人工终端验收通过。

- 当前只提供 Bun SDK,不承诺 npm 分发、稳定 API 或进程级沙箱。
- 自定义工具需配合取消;工具副作用不会回滚。
- JSONL 不保证断电或部分写入时的事务性;提交开始后取消需等待结算。
- TUI 使用 alt-screen,滚轮与 OSC 52 剪贴板尚未实现。
- 源码预发布是开发快照,不是可安装二进制或生产发行版。

## 开发与文档

```bash
bun run check
bun run test:headless
bun run typecheck:examples
```

[中文 SDK](docs/sdk.md) · [English SDK](docs/sdk.en.md) · [贡献说明](CONTRIBUTING.md) · [内部文档](docs/README.md)

维护者可在双平台验证后创建 [源码预发布草稿](docs/release.md),公开发布仍是单独的手动操作。

参考项目:[pi](https://github.com/earendil-works/pi)、[grok-build](https://github.com/xai-org/grok-build)、[clowder-ai](https://github.com/zts212653/clowder-ai)。各自代码适用其上游许可证;本地 pi-ai patch 保留上游归属。

## 许可证

[MIT](LICENSE),copyright 2026 L1ngg。
