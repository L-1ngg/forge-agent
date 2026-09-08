# Pi 内核对齐：工具与宿主接入面

> 状态:调研草稿，待 operator 确认；不是施工授权(2026-09-08)。

本报告基于 Forge `34a5ebff17bbc77606c31c728f98a079de140ea2` 与 earendil-works/pi `9767ba275f3e9a5ee0f5c5342249b629ab1b2282` 的源码，只讨论基础执行循环之外的接入差异。上下文策略沿用 ADR-014，不重新设计截断、压缩、恢复。这里的「必须」指若承诺对应层高保真，这一项不能遗漏，不表示已经批准修改。

## 结论

Forge 目前具有四种同名基础工具，但模型实际收到的 schema、结果和文件修改行为并不等同于 Pi。最先要补齐的是原生工具结果与更新通路，其次是四工具可观察契约。动态模型/工具配置属于运行时接入能力；skills、extensions、会话导航属于 coding-agent 宿主层，应列为明确范围选项。新 AgentHarness 又是 durable session / lanes 架构，不能因为同在 pi 仓库就默认为本次目标。

## 1. 原生结果、图片与更新：必须

Pi [AgentToolResult/AgentTool](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/types.ts#L362) 将模型内容 `content: (TextContent | ImageContent)[]` 与日志/UI 的 `details` 分开；`execute(toolCallId, params, signal, onUpdate)` 可发部分结果，工具失败采用 throw。它还包含 tool usage、`addedToolNames`、`terminate`、参数兼容钩子与执行策略，这些字段不能用一个 JSON string 等价替代。

Forge [HarnessTool](../../packages/tools/src/types.ts#L18) 返回 `ToolOutcome<TOutput>`，没有更新回调；[pi-port.ts:435](../../packages/core/src/pi-port.ts#L435) 将成功 value 或结构化 error 序列化成模型 text，并另将 value 当作执行 details。`details` 因此与模型可见结果相同，不能表达「只给 UI 的信息」。[SessionMessage](../../packages/protocol/src/events.ts#L38) 没有工具 details 字段；执行事件的 update/end 又只收 string。协议已有 ImageBlock，但不能从现有 HarnessTool 直接产出原生图片。不能误写为整个 Forge 协议完全不支持图片。

验收建议：自定义工具返回 text + image + 仅含 UI 字段的 details，断言下次 provider 输入有原生图片、没有 details 泄入文本；工具每次运行发两次 update，final result 只入会话一次，settle 后 update 不再有效；会话保存/恢复保持最终结果和必要展示数据。旧 ToolOutcome 通过兼容适配迁移，避免一次性破坏所有宿主工具。

## 2. 基础工具的实际差异

| 面 | 固定 Pi 行为及证据 | Forge 行为及证据 | 范围与验收 |
|---|---|---|---|
| 默认工具 | [SDK:256](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/sdk.ts#L256) 默认 `read,bash,edit,write`；[tools/index.ts:195](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/index.ts#L195) 同顺序 | [tools/index.ts:15](../../packages/tools/src/index.ts#L15) 为 `read,write,edit,bash`；CLI [main.ts:100](../../packages/cli/src/main.ts#L100) 注入；SDK 省略 tools 时 [pi-port.ts:387](../../packages/core/src/pi-port.ts#L387) 是空集 | 工具集合已基本齐全；高保真需比较完整 schema/description/顺序。SDK 默认是否也给四工具需要确认，通用 SDK 空集可能是有意边界 |
| read | [read.ts:73](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/read.ts#L73) 支持图片附件，带尺寸处理；可注入 ReadOperations | [read.ts:51](../../packages/tools/src/read.ts#L51) 一律 UTF-8 文本；结果是 JSON value | 若对齐 coding 工具则必须；PNG 返回 image，纯文本返回原生 text；截断继续沿用 ADR-014 |
| edit schema | [edit.ts:21](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/edit.ts#L21) 是 `{path, edits:[{oldText,newText}]}`，prepareArguments 兼容旧单项输入 | [edit.ts:6](../../packages/tools/src/edit.ts#L6) 是 `{path,old_text,new_text,replace_all?}` | 必须；不能按过时的 Pi 单 oldText/newText 接口施工。多个 disjoint edits 应针对原始文件一次应用，overlap/重复匹配/无变化失败 |
| edit 文件语义 | [edit.ts:159](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/edit.ts#L159) 有文件 mutation queue、BOM/换行保留、diff/patch details；[edit-diff.ts:300](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/edit-diff.ts#L300) 有 fuzzy normalization fallback | [edit.ts:38](../../packages/tools/src/edit.ts#L38) 是直接字符串替换后 write，无同文件队列 | 工具高保真必须；CRLF/BOM、模糊字符、重叠修改、同文件并发都用上游样例做差分；不能只重命名参数 |
| write | [write.ts:24](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/write.ts#L24) operations 可注入，递归 mkdir；[write.ts:78](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/write.ts#L78) 自动创建父目录 | [write.ts:40](../../packages/tools/src/write.ts#L40) 父目录不存在失败，并额外支持 `mode:create` | coding 工具高保真必须；写入新嵌套路径成功。是否保留旧 mode 仅作宿主兼容需确认 |
| bash | [bash.ts:24](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L24) timeout 单位秒，无默认 timeout；[bash.ts:241](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L241) 有 onUpdate、可注入执行 operations | [bash.ts:8](../../packages/tools/src/bash.ts#L8) `timeout_ms`，另有 description；[bash.ts:60](../../packages/tools/src/bash.ts#L60) 默认 120 秒，上限 600 秒，无 onUpdate | coding 工具高保真必须；验收秒单位、无默认超时配置、非零退出保留输出、取消终止进程树、运行中更新。不是重新设计输出截断 |

Pi [all tools](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/index.ts#L181) 另有 `grep/find/ls/powershell`，但不是默认四工具。将它们列为可选扩展即可，不能声称少了这些就连默认集也没对齐。工具 operations 注入是隔离文件系统/远端执行的良好接缝；是否开放成 SDK 公共契约应单独决定。

## 3. 动态配置、资源与会话

Pi 的基础 [Agent state](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent.ts#L72) 持有可更新的 systemPrompt/model/thinkingLevel/tools/messages。coding-agent 的 [AgentSession.setModel](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L1658)、[reload](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L2818) 负责更高层的切换和资源重载。Forge [CreateAgentOptions/Agent](../../packages/core/src/agent.ts#L12) 只有创建时这些参数，运行时仅公开 configureContext 等接口；[createModelPort](../../packages/core/src/pi-port.ts#L385) 捕获静态模型和工具数组。

建议把运行时更新模型、thinking、工具和 system prompt 纳入内核接入的必须项，明确在何种 turn 边界生效。验收：同一实例连续两轮切模型/工具后，provider 输入反映新配置、历史仍可转换、首轮工具结果不丢失；进行中修改的接受或拒绝行为写成明确契约。是否精确复制 Pi 的 API 名称、直接可变 state，需 operator 确认；语义一致并不要求把可变对象原样暴露给所有 Forge 宿主。

Pi [createAgentSession options](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/sdk.ts#L39) 注入资源、会话、settings、custom tools；[ResourceLoader](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/resource-loader.ts#L38) 管理 extensions/skills 等；[extensions API](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/extensions/types.ts#L1308) 有 registerTool，并在 [1486](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/extensions/types.ts#L1486) 注册 provider。Forge 当前 [config allowed keys](../../packages/core/src/config.ts#L53) 与 [SDK exports](../../packages/core/src/sdk.ts#L1) 没有相应加载器或扩展 ABI。模型侧 [createPiPort](../../packages/core/src/pi-port.ts#L488) 仅查 builtin catalog，baseUrl override 不等同于注册未知模型或自定义 provider。

这些是宿主范围待确认项：若承诺 coding-agent SDK 生态兼容，就需要它们；若只对齐执行内核，则不必先实现 Pi 完整扩展 UI、资源路径和包管理。可验收最小切片是注入未知模型/自定义 provider、注册一项工具，并在重新加载后只执行新定义；skills loader 若进入范围，验证发现/诊断/显式调用，不重开上下文预算设计。

会话方面，Forge [SessionStore.branch](../../packages/core/src/session-store.ts#L89) 已能选择 parent/leaf，[session-storage](../../packages/core/src/session-storage.ts#L38) 已重建分支，不能写作「没有树结构」。但 [Agent 公共接口](../../packages/core/src/agent.ts#L37) 没有 Pi [navigateTree](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L3113) 对应的宿主编排能力。高级导航/分支摘要是可选宿主范围；选择做时验收旧节点导航、后续输入只附新分支、取消导航不损坏当前会话。

新 [AgentHarness](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/agent-harness.ts#L587) 提供 lanes、工具设置和 durable session runtime；这与基础 Agent + coding-agent AgentSession 不是同一个迁移目标。ADR-014 已排除搬入新 AgentHarness。若用户现在想推翻此边界，必须先另行确认，不可把 lanes/durable recovery 偷带进单 Agent 高保真计划。

## 4. pi-ai 版本与 Responses patch

Forge [package.json](../../package.json) 锁定 `@earendil-works/pi-ai@0.84.4`，固定 Pi [ai/package.json](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/package.json#L3) 是 `0.85.1`。这是独立兼容面，不能从源码相似推导依赖升级安全。

Forge [Responses patch](../../patches/@earendil-works%2Fpi-ai@0.84.4.patch) 在 `response.completed`/`response.incomplete` 后 `break`，避免等待 HTTP EOF。固定上游 [openai-responses-shared.ts:741](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/api/openai-responses-shared.ts#L741) 仍只 `finalizeResponse(event.response)` 而没有 break。因此不得把「升级 0.85.1」当成「上游已经修好，可以删补丁」的证据。

建议先在现有版本完成不依赖新增 provider API 的语义对齐；若上游 Agent/工具源码移植要求 0.85.1，则单开依赖批次。必须针对实际安装包重新跑 [responses-terminal.test.ts](../../packages/core/test/responses-terminal.test.ts#L5) 的 completed/incomplete/failed/missing terminal 用例，并跑 provider replay、签名/usage、结构化工具结果与 typecheck。原补丁定位在 dist 文件，升级需要重新核验目标文件与源逻辑，不能复用版本绑定的 patch 声明。自定义 provider 注册、模型 catalog、stream 返回类型和新增结果字段也需要真实编译/差分证据。

## 验证记录

- Ran：只读检查上述固定源码与本地契约，核验行号、schema、默认参数、结果转换和 Responses terminal 分支。
- Not run：产品测试、真实模型/网络请求、0.85.1 升级或试装、运行时差分测试。
- Why：本任务交付可审查调研方案，施工尚待 operator 确认；运行测试由主研究流程统一负责。
- Risk：本报告的验收条目是候选测试规格，不能当作已验证兼容。并行完成的[上游研究](pi-core-upstream-semantics.md)已比对官方发布包 sourcemap 所含源码，agent 90/90、ai 177/177 与目标快照一致；该证据不代替 Bun 安装、构建产物和全部传递依赖的兼容验证。
