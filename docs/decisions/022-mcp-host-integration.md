---
doc_kind: decision
created: 2026-09-21
---

# ADR-022: 官方 MCP client 与 Forge 宿主接入

> 状态:已批准(2026-09-21)，其中不替换 pi-ai 的施工期范围由 [ADR-024](024-incremental-tanstack-ai-adoption.md) 修订。需求范围见 [Issue #36](https://github.com/L-1ngg/forge-agent/issues/36)，具体接口及验收映射见[完整施工设计](../phases/mcp-client.md)。operator 于 2026-09-21 在实施启动指令中明确确认本设计；批准不表示产品已实现。
> 参与者:operator 提出完整交付和优先复用要求；Codex 完成调研、探针与设计。

## 背景

Forge 已有公开 SDK、统一工具权限、配置提交、输入归属和会话存储，但没有 MCP client。operator 要求本地与远程一起支持，并明确“一次性全做”“尽可能用官方套件/第三方库”。因此 Tools、Resources、Prompts、OAuth、Elicitation 和管理体验共同交付，不能只完成 Tools 就将其他范围转为未来任务。

设计基线为 `e049505f1015623a334b50439daae15ce6e3479b`。本决策补充 [ADR-008](008-general-agent-positioning.md) 的能力扩展方式，保留 [ADR-015](015-pi-core-source-migration.md) 的内核所有权、[ADR-010](010-input-ownership-and-interruption.md) 的输入归属及 [ADR-021](021-host-context-transform-and-request-budget.md) 的预算顺序。

## 决策

### 官方协议实现，Forge 持有宿主语义

- 使用 `@modelcontextprotocol/client@2.0.0`，以发布产物和 Bun 探针为依据；协议、transport、版本协商、分页、输出校验、OAuth 协议及 MCP 交互轮次全部复用 SDK。
- MCP 模块放在 Core 宿主装配侧，工具仍经 `HarnessTool` 和现有权限执行；不替换 Pi runtime/pi-ai，不引入第二套 Agent loop。
- 公开接入为 `createAgent({ mcp })` 和返回实例的 `agent.mcp`。CLI/TUI 复用同一控制接口。CLI 无模型配置的 MCP 管理命令可以直接装配同一个内部管理模块，但不建立另一条业务执行路径。
- 每个 Agent 拥有自己的连接、目录快照、交互和释放职责；不会跨 Agent 或跨会话隐式共享活动连接。持久凭据可以由宿主显式共享，但不因此共享授权决定、取消信号或模型上下文。
- 服务目录快照与活动连接状态分开。配置准备不能关闭旧连接；当前模型响应及整批工具完成后，才提交新的有效工具集合和释放不再引用的旧连接。

### 单次输入承载远端模板证据

MCP Prompt 可返回多条 user/assistant 消息。将它们作为多个独立 append 写入，会在中途失败时留下半个模板；把它们压成 system prompt，又会改变角色与权限意义。

选择一次用户输入保存一个带来源的完整模板封套，使用现有单条 `SessionStorage.append` 和 `processed` 语义；请求投影展开有序消息。原始封套保留远端角色、内容、参数及来源，压缩和恢复都能解释它；投影中的模板 assistant 消息不是本次模型生成、用量或任务完成证据。通用输入装配逻辑留在会话层，不向执行内核增加 MCP 分支。

### 凭据后端显式，平台限制可见

- 选择成熟 `@napi-rs/keyring@2.1.0` 的异步接口。Linux 默认显式指定 Secret Service，macOS 使用 Keychain；禁止采用库在 Linux 上的自动 fallback。
- 对没有 Secret Service 的 WSL，允许用户显式选择 `linux-keyutils`。它支持当前 Linux/WSL 实例内跨进程使用；关闭 WSL 或系统重启后可能丢失，需要重新登录。它不构成跨重启持久保存承诺。
- SDK 可注入凭据存储；默认 SDK 内存后端不声称持久化。持久 SDK 宿主可以复用 CLI 的系统后端或自有后端。
- 不自写加密算法，不在项目配置或会话内存放 token。跨进程刷新互斥使用成熟文件锁库；锁文件只存非秘密标识，不能把锁当作凭据库。

### 单一完成出口

Issue #36 的全部 AC 是一个交付出口。内部编码顺序、提交组织与可回退点不拆成对用户的交付批次。自动化、真实服务、OAuth/模型实测和平台证据分别记录；缺少必要证据时不把整个功能标记完成。

## 备选方案

| 方案 | 取舍 |
|---|---|
| 自写协议/transport/OAuth | 重复官方能力，协议升级和边界维护成本最高，不采用 |
| Vercel `@ai-sdk/mcp` | 与 AI SDK Tool 的转换便利无法直接消除 Forge/Pi 适配，增加另一套工具类型，未选 |
| `@mcp-use/client` 接管生命周期 | 多 server 和 OAuth helpers 有价值，但与 Forge 所有权、配置提交重叠；官方 SDK 已覆盖多数协议工作，未选为底座 |
| CLI 全局连接池跨会话共享 | 减少重连，但取消、权限、目录与远端隐式状态隔离复杂；本次选择每 Agent 所有权 |
| 每次工具调用临时启动 server | 破坏连接复用，重复探测/认证与进程启动，不采用 |
| Bun.secrets | 零额外依赖，但当前 Bun 标为 experimental；本机缺 libsecret，且不能提供显式 keyutils 选择。保留为未来可替换 adapter，不是本次默认 |
| 无后端时自动保存明文或 keyutils | 改变持久性和保存位置，用户无法判断真实后端，不采用 |
| 多条消息分别持久化 Prompt | 中断/存储失败存在半提交；选择单封套、投影展开 |

## 后果

- 增加必要的连接管理、输入/内容映射和凭据 adapter，协议复杂度仍由官方 SDK 承担。
- 会话切换会重新连接，优先确保隔离与可解释释放；需要测试旧会话释放、新会话准备失败及短暂并存。
- 新封套仍使用 v4 message 记录和可阅读 content；老版本只能看到降级文本，不能宣称具备新版本的角色投影。回退必须停止使用 MCP，保留原始文件，不原地迁移历史。
- 当前 WSL 的系统凭据后端不可用；显式 keyutils 已有合成数据探针，但实际 OAuth、macOS Keychain 和 Forge 集成仍须按施工图验收。
- 同步当前文档导航和路线入口；公开 SDK/README 仅在实现时更新为已支持，避免设计稿冒充产品合同。

## 依据

- [官方 SDK Bun 探针](../research/mcp-client/README.md)、[凭据与依赖设计证据](../research/mcp-host-design.md)。
- [SDK 版本协商](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)、[列表/调用](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/calling.md)、[OAuth provider](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/oauth.md)。
- [keyring](https://github.com/Brooooooklyn/keyring-node)、[proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)。外部 main 文档可能变化，验收以锁定发布产物为准。
