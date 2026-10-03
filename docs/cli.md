# CLI 使用指南

[English](cli.en.md) · [项目 README](../README.zh-CN.md) · [SDK 指南](sdk.md)

本指南介绍交互式终端与 headless CLI。首次使用先按[快速开始](../README.zh-CN.md#快速开始)安装依赖、配置模型；在应用中嵌入 Forge 则使用 SDK 指南。

[终端操作](#终端操作) · [会话](#会话) · [JSON 输出](#headless-模式) · [配置](#配置) · [Skills](#skills) · [MCP](#mcp-服务) · [记忆](#记忆)

## 在项目中运行

在 Forge checkout 内运行 `bun run forge-agent` 即可启动终端。要处理其他项目，先进入目标目录，再通过绝对路径调用源码入口：

```bash
cd /path/to/your-project
bun /path/to/forge-agent/packages/cli/src/main.ts
```

当前目录决定工具的工作路径和项目配置位置。会话与项目 Skills 按 Git worktree 根目录归属，无 Git 时使用启动目录。模型凭据通过环境变量或[用户/项目配置](#配置)提供。

在 Forge checkout 内运行 `bun run forge-agent --help` 可查看 CLI 参数。下文命令默认在该 checkout 内运行；处理其他项目时替换为绝对路径入口。

## 终端操作

输入任务后按 Enter。Forge 会显示流式回复、工具调用、结果、文件差异和权限卡片。用 `/help` 查看可用命令，输入 `@` 可补全文件引用。

| 操作 | 按键或命令 |
|---|---|
| 发送消息；任务执行中则排队 | 输入框内按 Enter |
| 取消当前任务，等待收尾后发送当前输入 | Ctrl+Enter |
| 浏览输出或返回输入框 | Tab；以页脚当前快捷键为准 |
| 滚动对话 | PageUp/PageDown 或鼠标滚轮 |
| 停止当前任务，前提是没有卡片或其他界面层占用 Esc | Esc |
| 退出 | Ctrl+C 或 `/quit` |

权限卡片有独立焦点和快捷键。Esc 可暂存权限卡片并进入历史浏览，`c` 返回输入框，Tab 或 `i` 回到卡片。打开选择器、详情或表单时，以当前显示的快捷键为准。

TUI 使用终端 alternate screen。对话与详情视图都支持 Markdown；窄表格转为带标签的记录，长代码行折行，复制操作保留 Markdown 源文。LaTeX 保持字面文本。剪贴板优先使用可用的原生渠道，OSC 52 是依赖终端支持的回退方式。可用 `bun scripts/markdown-preview.ts` 预览渲染，无需模型或会话。

## 会话

每次启动进入新对话，首次输入被消费前不保存。之后会话写入 Git worktree 根目录的 `.forge-agent/sessions/`，无 Git 时写入启动目录。

| 命令 | 效果 |
|---|---|
| `/new` | 沿用当前模型、工具和配置，开始独立对话 |
| `/resume` | 浏览并恢复当前项目的历史会话 |
| `/clear` | 清空可见对话，保留当前模型上下文 |

在 `/resume` 中用上下方向键选择，Ctrl+E 展开近期用户/助手片段，Enter 打开会话。Esc 先收起预览，再退出选择器。预览有长度限制，完整内容需恢复会话后阅读。浏览过程不请求模型、不写入历史，也不打断当前任务；选定其他会话才会切换。

任务中开始新会话或切换会话，会先取消任务，等待工具清理和保存完成。保存失败则停止切换，工具需要配合取消。恢复历史不会重放未完成的工具；待处理审批只在当前进程内续接。

已保存会话的未发送草稿和排队输入，在当前进程内保留。回到该会话时恢复为可编辑文本，不自动发送。要携带草稿切换，可把 `/new` 或 `/resume` 放在独立首行；丢弃空会话中的草稿前会要求确认。草稿不在退出时保存。

同一 worktree 及其子目录共享会话，不同 worktree 隔离。既有 `.forge-agent/session.jsonl` 仍可发现。当前没有 `--session` 参数或 `sessionPath` 配置项。损坏文件需通过 [SDK 副本转换流程](sdk.md#存储)检查后再使用。JSONL 保存不保证崩溃或断电时的事务性。

## Headless 模式

通过 `--json` 和 prompt 启动无 TUI 任务。Stdout 按行输出 JSON 事件：

```bash
bun run forge-agent --json -p "读取 package.json 并概括它的内容"
```

单独传 `-p` 不会切换到 headless。JSON 模式不等待交互审批：需要人工决定的请求会被保守拒绝或取消，并返回对应退出码。脚本应同时检查事件与进程退出码。

| 退出码 | 含义 |
|---|---|
| `0` | 任务成功或以 deferred 状态结束 |
| `1` | 启动/运行失败，或输出达到长度上限 |
| `2` | 参数错误，或缺少 provider/model 选择 |
| `20` | 工具权限需要人工决定 |
| `21` | 取消确认需要人工决定 |
| `22` | 问题需要人工回答 |
| `23` | 计划需要人工审批 |
| `24` | 需要 OAuth 交互 |
| `25` | 需要 MCP Elicitation |
| `130` | 任务被取消 |

一次任务出现多种交互请求时，首个此类请求决定交互退出码。事件与权威结果语义见 [SDK 执行结果与配置](sdk.md#执行结果与配置)。

管理入口示例：

```bash
bun run forge-agent --json -p '/skills'
bun run forge-agent --json -p '/skills reload'
bun run forge-agent --memory 'list'
bun run forge-agent --mcp 'status'
```

Skills 管理不调用模型、不创建会话历史，但普通启动仍需 provider/model 凭据。独立记忆文件操作和 MCP 管理无需模型凭据；MCP 操作可能连接已配置的服务或要求单独授权。`--mcp 'use-prompt ...'` 和 `--mcp 'use-resource ...'` 会提交任务输入，需要模型。

## 配置

配置按以下顺序加载，后者覆盖前者：

1. `~/.config/forge-agent/config.json`；设置 XDG 后为 `$XDG_CONFIG_HOME/forge-agent/config.json`。
2. 启动目录下的 `.forge-agent/config.json`。
3. `FORGE_AGENT_PROVIDER`、`FORGE_AGENT_MODEL`、`FORGE_AGENT_API_KEY`。
4. CLI 的 `--provider` 和 `--model` 参数，覆盖 provider/model 选择。

例如在项目配置中选择模型，并引用环境变量中的密钥：

```json
{
  "provider": "xai",
  "model": "grok-4.6",
  "apiKey": "$FORGE_AGENT_API_KEY"
}
```

没有显式 key 时，可以使用供应商原生环境变量，例如 `XAI_API_KEY`、`OPENAI_API_KEY`。字段区分大小写，未知顶层字段会被拒绝。模型 ID 需在内置目录中，兼容代理需要接受所选模型的协议；代理地址通过 JSON 中的 `baseUrl` 设置。修改配置文件后重启 CLI。

常用可选字段：

| 字段 | 用途 |
|---|---|
| `systemPrompt` | Agent 的主提示词 |
| `thinkingLevel` | 请求的推理级别，受模型支持范围限制 |
| `maxTokens` | 模型输出上限 |
| `contextWindow` | 覆盖声明的上下文窗口 |
| `permissionMode` | `default`、`accept-edits` 或 `deny-all`，见下文 |
| `cacheHints` | 添加已支持的任务缓存参数，默认 `true` |
| `skills`、`mcp`、`memory`、`context` | 功能配置，见下文对应章节 |

主任务向 xAI Responses 提供稳定的会话缓存 key，向 Anthropic Messages 提供默认 ephemeral 缓存控制。兼容代理不接受这些参数时，可设置 `cacheHints: false`。该开关不关闭供应商隐式缓存，Forge 也不会静默移除参数后重试。摘要和记忆整理不自动携带任务缓存提示。会话标识、token 计量和命中边界见 [Prompt cache](sdk.md#prompt-cache)。

## 工具权限

CLI 自动允许普通 `read` 调用。除此之外，默认策略在没有前序规则决定结果时询问用户。通过权限卡片批准或拒绝；拒绝原因会返回模型，让它调整后续操作。

通过配置设置 `permissionMode`：

| 模式 | 前序策略未作决定时的行为 |
|---|---|
| `default` | 询问用户 |
| `accept-edits` | 允许普通 `write`/`edit`，其他未决定的调用仍询问 |
| `deny-all` | 拒绝尚未决定的普通工具调用 |

`deny-all` 不是沙箱，也不是关闭所有工具的总开关：CLI 内置 read 规则等前序授权仍然有效。可信 Skills 和记忆工具在该模式下仍无需交互授权。Skill 加载不授权 shell 命令或安装依赖，工具副作用不会回滚。完整策略与审批合同见 [SDK 权限](sdk.md#权限)。

## Skills

CLI 按以下顺序发现包含 `SKILL.md` 的目录：

| 来源 | 默认位置 |
|---|---|
| 项目 | `<project>/.forge/skills` |
| 用户 | `~/.forge/skills` |
| 内置 | Forge checkout 中的 `packages/cli/builtin_skills`，目前为空 |

`<project>` 是 Git worktree 根目录，无 Git 时为启动目录。同名条目以先发现的来源为准。默认根缺失时视为空，格式不合规的条目由发现流程报告或跳过。

添加名为 `code-review` 的 Skill 后，可使用：

```text
/skills reload
/skills
/skill code-review 请审查当前补丁。
```

`/skill` 提供名称补全，按 Enter 接受名称后输入任务。它在提交一次用户输入前加载正文；失败输入返还草稿。Headless 调用使用 `--json -p '/skill code-review 请审查当前补丁。'`。

模型初始只看到名称和用途，按需加载正文。`disable-model-invocation: true` 禁止自动选择，仍允许显式 `/skill`。Skill 可在 `references/`、`assets/` 中提供资料；加载资源不执行脚本、不安装依赖，也不会通过 `allowed-tools` 获得授权。

使用 `--no-skills`、设置 `skills.enabled: false` 可以关闭 Skills，也可以在 JSON 中覆盖目录。相对路径按启动目录解析，显式指定的根缺失会报错：

```json
{
  "skills": {
    "enabled": true,
    "roots": { "workspace": "./team-skills", "user": "/home/alice/shared-skills" }
  }
}
```

重新加载的 Skills 在当前运行结束后生效。SDK 要求显式提供 roots，不自动采用 CLI 的发现路径；宿主配置与调用方式见 [SDK Skills](sdk.md#skills)。

## MCP 服务

Forge 支持本地 stdio、远程 Streamable HTTP 和旧版 SSE 服务。在用户或项目配置中添加服务；项目配置按同名 server 整条覆盖。把示例命令和 URL 替换为实际服务的值：

```json
{
  "mcp": {
    "servers": {
      "files": { "transport": "stdio", "command": "your-mcp-server", "args": [] },
      "remote": { "transport": "http", "url": "https://example.com/mcp", "auth": { "type": "oauth", "scopes": ["read"] } }
    }
  }
}
```

```text
/mcp status
/mcp login remote
/mcp resources files
/mcp use-prompt files review --args '{"topic":"change"}' -- 审查这个变更
```

`login` 显式启动浏览器授权，`use-prompt` 把服务提供的 Prompt 与任务一起作为上下文提交。Tools 遵循权限策略；同时提供 Resources、URI templates、Prompts、订阅、OAuth 和 form/URL Elicitation。详见 [SDK MCP](sdk.md#mcp)和[目录示例](../examples/mcp-client.ts)。

`--no-mcp` 禁用连接。需要持久修改时，使用 `bun run forge-agent --mcp 'disable files --scope project'`，也可选择 `--scope user`。TUI 中不带 scope 的 enable/disable 只影响当前 Agent。

CLI OAuth 凭据使用系统凭据库。Linux 默认要求 Secret Service；显式设置 `mcp.credentialStore: "linux-keyutils"` 时使用当前 Linux/WSL 实例，重启后可能需要重新登录，不静默回退。SDK 凭据默认保存在实例内存。外部服务和平台覆盖见 [MCP 验收记录](phases/mcp-client-acceptance.md)。

## 记忆

Forge 用普通 Markdown 主题和短 `MEMORY.md` 索引保存偏好与项目笔记。CLI 在运行开始时召回记忆，任务结束后可能额外请求一次模型整理有用内容。整理失败不改变主任务结果，当前指令优先于历史笔记，笔记不产生工具授权。

用 `/memory` 查看帮助、当前开关和目录位置：

```text
/memory list
/memory save project workflow.md 本项目使用 Bun。
/memory read project workflow.md
/memory edit project workflow.md 本地开发使用 Bun，生产环境尚未确定。
/memory pin project workflow.md
/memory sources project workflow.md
/memory delete project workflow.md
```

Markdown 文件也可直接在编辑器中修改。`search <scope> <words>` 搜索笔记，`read <scope> <path> <offset>` 从返回的 `nextOffset` 继续读取，`unpin` 取消置顶。`import <session-path>` 显式读取一份当前项目会话的有界片段，再请求模型整理。启动不会扫描历史会话生成记忆。

文件位于 `$XDG_DATA_HOME/forge-agent/memory`，默认 `~/.local/share/forge-agent/memory`，存放在 checkout 之外。用户偏好与项目笔记分别作用于各自 scope。新 worktree 首次复制主 worktree 的项目 Markdown，之后独立演进，Git merge 不同步这些副本。删除笔记不会删除会话历史。

记忆召回与 deferred 整理默认分别开启。持久关闭两者：

```json
{
  "memory": { "autoUpdate": false, "injection": false }
}
```

`/memory auto off` 和 `/memory inject off` 只影响当前进程，在当前 Agent 的本次运行结束后生效。即使两者关闭，仍可显式管理记忆。`bun run forge-agent --memory 'read project workflow.md'` 无需模型即可读取已保存的笔记。

`memory` 保存事件报告 skipped、saved 或 failed；模型提供整理 usage 时一并报告。主题与索引分别写入。SDK 只有在宿主提供 store 时才启用记忆，配置与存储行为见 [SDK 记忆](sdk.md#持久记忆)。

## 上下文管理

CLI 与 SDK 默认启用上下文压缩：向模型保留简短任务笔记和证据引用，完整记录仍在会话历史与检查点中。Agent 可以用 `search_context` 搜索，再用 `read_context` 读取原文；两者遵循既有权限策略，不重放历史工具。

用 `/compact` 请求压缩，也可在后面追加需要保留哪些内容的说明。配置可以显式开启或关闭自动压缩：

```json
{
  "context": { "enabled": true }
}
```

关闭自动压缩后，任务请求仍需通过最终输入/输出预算检查。压缩和缓存不保证每个任务都减少 token 或费用。容量与恢复行为见 [SDK 上下文管理](sdk.md#上下文管理)，应用自行控制投影见[宿主上下文变换](sdk.md#宿主上下文变换)。迁移细节和已有数据格式由 SDK 指南说明。

## OpenTelemetry

启动 CLI 前配置 OTLP endpoint 即可导出 trace：

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_SERVICE_NAME=forge-agent bun run forge-agent --json -p "检查这个项目"
```

CLI 使用 OTLP HTTP/JSON。通用 endpoint 自动追加 `/v1/traces`，`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 指定精确 URL。支持标准 OTLP headers/timeout 和 resource 环境变量，service name 默认 `forge-agent`。未配置 endpoint 时关闭导出，`OTEL_SDK_DISABLED=true` 可显式禁用。

正文捕获默认关闭；`FORGE_OTEL_CAPTURE_CONTENT=true` 会包含提示词、回复、工具参数与结果，即使关闭，异常消息也可能带有正文。正常退出会等待 exporter shutdown，导出失败不改变任务结果或 JSON stdout，强制终止可能丢失缓冲 span。

CLI 只导出 trace。SDK 宿主还可提供 meter 和脱敏回调。接入见 [SDK OpenTelemetry](sdk.md#opentelemetry)及离线 [OTel 示例](../examples/otel.ts)。
