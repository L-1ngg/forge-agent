# Agent Skills 社区方案核查

> 状态:已归档(2026-09-21)。下文保留当时设计与验证，不作为当前实施依据；现行入口见[当前合同与设计](../../phases/skills.md)。历史未测、豁免及中止结论保持原意。

> 历史状态:调研完成（2026-09-19）。这是候选与证据附件，不代表已采用或已实现；综合建议见 [Skills 接入方案](skills-integration-options.md)。

## 结论

社区已经有可直接复用的格式、安装器、解析库和加载实现，Forge 无须重新设计 `SKILL.md` 格式或安装生态。但它们职责不同，不能把安装器当作运行时 SDK。

- **格式采用 Agent Skills；安装优先兼容 Vercel `skills` 的目录产物。** 两者已有明显的跨客户端生态证据。
- **真实的轻量 TypeScript 库存在：`agent-skills-ts-sdk@2.5.0`。** 它能解析、校验、管理 catalog、生成 prompt/tool schema、按需读取正文和资源；只依赖 `yaml`。本次使用 npm 发布产物在 Bun 1.3.12 实测通过基础 smoke。但它缺少文件系统发现层，公开采用规模证据薄弱，不能仅因版本为 2.x 就称为成熟首选。
- **官方 `skills-ref` 明确不用于生产。** 它是 Python reference/validator，适合作为格式与 conformance 依据，不适合作为 Forge 运行时依赖。
- **OpenSkills 是 CLI 加载方案；TanStack 是框架集成方案。** 两者都有真实实现，前者不是稳定 library API，后者携带另一个 AI 框架；均不优于 Forge 当前同源 Pi 模块复用路径。Pi 的固定源码核查与 Bun 验证见综合报告。

## 核查范围与固定快照

网络读取日期为 2026-09-19。下表中的成熟度是证据边界，不是评分。

| 候选 | 核查版本 / 源码 | 实际职责 | License / 依赖 | 成熟度证据与限制 |
|---|---|---|---|---|
| `agentskills/agentskills` | `69ef37e9424c0a7ea9dd2293b559e43ec8176379`；`skills-ref` 0.1.0 | 格式、接入指南、Python parser/validator/prompt reference | 代码 Apache-2.0；文档 CC-BY-4.0；Python >=3.11，`click`、`strictyaml` | 官方标准和多客户端采用；reference 自述仅 demonstration |
| `vercel-labs/skills` | npm 1.7.0；`7407f3893ad4dceab546ac002c3ef806e4000c73` | 安装、发现仓库技能、列表、更新、删除，以及临时 `use` CLI | MIT；声明 Node >=22.20.0；发布 manifest 的 dependencies 为 `tar`、`yaml`，另有构建时打包依赖 | 当日约 31,970 stars；9/18 有更新；仓库有跨平台、symlink、lock、路径穿越测试。测试存在不等于本次运行通过 |
| `agent-skills-ts-sdk` | npm 2.5.0；tag 对应 `8cb7480815ec39334095cbf2d2516ea7e8554620` | 独立 parser、validator、registry、prompt、read tool schema 与处理器 | MIT；ESM；Node >=22.12；唯一运行时依赖 `yaml ^2.9.1` | npm 从 2026-02 持续发布，9/17 最新；该 SHA CI/Release 成功；GitHub 当前 0 stars、npm 单 maintainer，缺少大规模采用证据 |
| `numman-ali/openskills` | npm 1.5.0；发布 `gitHead` 为 `3251f0ad436996c392ba0d5e1bfc7e1700149995`；当前 main `57d933a4f0d5c8659bd8b285f50fb9554360f0b3` | 安装 CLI、扫描、向 `AGENTS.md` 同步 catalog、`read` 输出正文 | manifest 与 LICENSE 声明 Apache-2.0；Node >=20.6；`ora`、`chalk`、`commander`、`@inquirer/prompts` | 当日约 10,762 stars；最后 push 为 1/18；有 tests，但当前解析策略较简化 |
| `@tanstack/ai-skills` | npm 0.1.4；发布 tag commit `299953fdfebcf8e9cd8b7a345609a5c83b785d6e`；另读 main `bffdd186afee12d3bbd71986e9cc2793c8aeded6` | `chat()` middleware、文件系统 source、catalog、activation tools | MIT；Node >=18；依赖及 peer `@tanstack/ai ^0.55.0`，peer `zod`；可选测试 peer `vitest` | 有组织维护与正式包，但本组件仍 0.1.x；未验证 Bun，与 Forge 无同源优势 |

来源：[Agent Skills README][as-readme]、[skills-ref manifest][as-pyproject]、[Vercel npm][vercel-npm]、[WebMCP npm][web-npm]、[OpenSkills npm][open-npm]、[TanStack npm][tan-npm]。stars/pushed 状态来自当日 GitHub 仓库 API，仅作规模/活跃信号，不能证明正确性。

## Agent Skills 标准与官方 reference

固定规范要求 `SKILL.md` 使用 YAML frontmatter，必填 `name`、`description`；允许 `license`、`compatibility`、`metadata` 和 experimental `allowed-tools`。正文为 Markdown，附属资源可放 `scripts/`、`references/`、`assets/`。规范不强制安装位置。[规范][as-spec]

官方接入指南描述三层渐进加载：启动时 catalog，激活时正文，引用时资源。已有文件读取工具的 Agent 可以直接读 `SKILL.md`；专用 `activate_skill` 工具是另一种可选接法。显式 `/skill` 或 `$skill` 由宿主查找并注入，不要求模型再次做选择。[接入指南][as-integration]

该指南将 `.agents/skills` 列为跨客户端惯例，并建议 project 优先于 user、碰撞可诊断、元信息加载与正文激活分离。**这是实现指南，不是格式标准强制所有客户端采用的目录契约。** 同时它建议宽容接入部分非标准 skill，故生产 loader 与严格 validator 的职责应区分。[接入指南][as-integration]

`skills-ref` 暴露 `validate`、`read_properties`、`to_prompt`，但 README 原文为：**“This library is intended for demonstration purposes only. It is not meant to be used in production.”** 不建议为复用这几项能力让 Bun 产品额外依赖 Python 环境。[README][as-ref]

## Vercel `skills`：复用安装生态

npm manifest 只声明 CLI `bin`，没有 library `main`/`exports`。源码中的 `discoverSkills` 等内部函数不能据此视为有稳定契约的 SDK。可复用方式是让用户用其 CLI 管理 skill 文件，Forge 发现同一目录；不在运行时 import 该工具。[manifest][vercel-npm]、[源码树][vercel-tree]

1.7.0 支持 `add`、`list`、`update`、`remove`，以及将技能下载到临时目录、生成 prompt 的 `use`。安装支持 canonical copy + symlink 或复制；已支持 `universal` agent。不要将其已有 `forgecode` 条目误认成本项目 Forge Agent。[README][vercel-readme]、[agents.ts][vercel-agents]

**当前版本有一个必须处理的路径差异：** `--agent universal` 的 project 路径为 `.agents/skills`，global 路径为 `$XDG_CONFIG_HOME/agents/skills`，默认 `~/.config/agents/skills`。它不是官方指南举例的 `~/.agents/skills`。若只扫描后者，用户使用 `skills add -g -a universal` 安装后可能看不到技能。方案阶段应明确兼容这两个用户目录，并制定碰撞规则。[agents.ts][vercel-agents]

本次未执行安装、更新或 `use`，也未写用户 global skills。CLI 可以独立推荐；不必立刻实现 Forge 自己的安装命令。

## `agent-skills-ts-sdk`：可直接依赖的轻量候选

这不是 Agent Skills 官方维护的 SDK。发布包实际有 root exports、`.d.ts`、ESM 产物；功能和依赖已从 npm 与源码核实。[manifest][web-npm]、[index.ts][web-index]

`SkillSource` 定义 `id`、`fingerprint`、`list()`、`load()`、可选 `readResource()`/`refresh()`。`createSkillRegistry` 按 source 顺序 first-wins，重复记录 warning，source list 失败跳过并记录 warning。空 catalog 的 `systemPrompt()` 返回 `null`；`readTool()` 生成 JSON Schema；`read()` 返回正文或资源内容。宿主仍需把这个声明与 handler 转为 Forge SDK 的 `HarnessTool`，并决定注入位置。[registry.ts][web-registry]

`skillSourceFromEntries` 接收内存文件集合，可读取正文中显式引用且实际提供的资源；**它不是磁盘扫描器**，也不负责执行脚本。Forge 仍需实现目录发现、范围/优先级、symlink/realpath 去重、诊断与刷新。该包不管理会话恢复和上下文压缩，因此“加一个 dependency”不等于完整接入完成。[registry.ts][web-registry]

默认 validation 严格拒绝未知字段；README 提供 `allowedFields` / `unknownFields: "allow"` 扩展。若采用它，必须明确兼容 Pi/Claude 额外 frontmatter 的策略；不应把所有扩展字段都作为 invalid。[README][web-readme]

可审查的维护证据：有 parser/validator/prompt parity、registry、integration、packed-consumer 等 tests；CI 使用 Node 22/24，包含 reference drift 与 package integrity。该 SHA 的 [CI run][web-ci-run] 返回 success。本次没有运行其完整 test suite，不据此推断 Bun 全面支持。[CI 配置][web-ci]

### 本次 Bun 实测

从 npm 精确下载 `agent-skills-ts-sdk-2.5.0.tgz` 与 `yaml-2.9.1.tgz`，在独立 `/tmp` 目录手动解包；未执行安装脚本。`bun run smoke.ts` 在 Bun **1.3.12** 下 exit 0，验证：

- YAML block scalar description 被正确解析；缺 description 的 validation 返回问题。
- catalog 包含 metadata，不包含正文。
- 两个同名 source first-wins，记录一个 duplicate warning。
- `registry.read({name:"example"})` 返回正文；指定 `resource:"details"` 返回 `DETAILS`。
- 未知 skill 返回 `SKILL_NOT_FOUND`；`../secrets` 资源名返回 `RESOURCE_NOT_FOUND`。

最后一项只证明内存 registry 拒绝未注册资源，不等于验证磁盘路径 containment 或 symlink 安全。没有真实模型调用、磁盘适配器、并发刷新、Windows/macOS 或 Forge 端到端验证。临时源码和 smoke 产物已清理。

建议：保留为**轻量直接依赖备选**。若目标更看重低维护成本，它值得在施工前与 Pi 模块复用比较；若目标优先成熟实战与同源行为，则现有证据不足以让它取代 Pi。这里没有下“社区不存在可用库”的结论。

## OpenSkills 与 TanStack 的取舍

OpenSkills `readSkill()` 查找目录后将 `Base directory` 与完整文件输出 stdout，找不到时 `process.exit(1)`；发布入口也是 CLI。它可以通过 shell 调用接入现有 Agent，但不是适合嵌入 Forge 的无副作用函数库。[read.ts][open-read]、[manifest][open-npm]

其 `findAllSkills()` 使用目录名作 skill 名，`extractYamlField()` 为逐行正则，没有真正解析完整 YAML block scalar；搜索路径为单数 `.agent/skills` 和 `.claude/skills`，顺序是 project `.agent` → global `.agent` → project `.claude` → global `.claude`。这与当前 `.agents/skills` 惯例、统一 project-first 策略均不同。故不推荐 fork 它作为 Forge loader。[skills.ts][open-skills]、[yaml.ts][open-yaml]、[dirs.ts][open-dirs]

TanStack 的 root export 包含 parser、walk、combinators、catalog 与 `withSkills`；`/node` 的 `skillDirectory()` 已实现磁盘 source 和资源读取。然而 `withSkills` 直接使用 `@tanstack/ai` 的 `defineChatMiddleware`、capability、Tool 类型；完整集成是替换/引入一套框架接缝。单独 import `/node` 也不能消除 package manifest 中声明的框架依赖。[root][tan-index]、[node][tan-node]、[middleware][tan-middleware]、[manifest][tan-npm]

本次读源码的位置固定为 main SHA，发布版本与 tag 单独记录，未声称二者所有文件完全一致。它适合 TanStack AI 用户，不建议 Forge 为 skill 功能增加该框架。

## 验证边界

- **Ran：** 官方规范/README/固定源码读取；npm exports/engines/dependencies/license/tag 核对；WebMCP 该 SHA 的远程 CI 状态查询；npm 发布包 Bun smoke。
- **Not run：** 第三方完整 suite、安装 CLI、真实模型 skill 选择/遵循质量、Forge 接入、跨平台。
- **Why：** 本任务是方案研究；保留现有执行内核，未授权产品实现或安装第三方技能。
- **Risk：** SDK 可用性 smoke 不能证明成熟度；安装路径与额外 frontmatter 是接入时的明确兼容缺口；skill 的模型遵循质量需要另行真实模型验收。

[as-readme]: https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/README.md
[as-spec]: https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx
[as-integration]: https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/client-implementation/adding-skills-support.mdx
[as-ref]: https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/README.md
[as-pyproject]: https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/pyproject.toml
[vercel-npm]: https://registry.npmjs.org/skills/1.7.0
[vercel-tree]: https://github.com/vercel-labs/skills/tree/7407f3893ad4dceab546ac002c3ef806e4000c73/src
[vercel-readme]: https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/README.md
[vercel-agents]: https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/src/agents.ts
[web-npm]: https://registry.npmjs.org/agent-skills-ts-sdk/2.5.0
[web-readme]: https://github.com/WebMCP-org/agent-skills-ts-sdk/blob/8cb7480815ec39334095cbf2d2516ea7e8554620/README.md
[web-index]: https://github.com/WebMCP-org/agent-skills-ts-sdk/blob/8cb7480815ec39334095cbf2d2516ea7e8554620/src/index.ts
[web-registry]: https://github.com/WebMCP-org/agent-skills-ts-sdk/blob/8cb7480815ec39334095cbf2d2516ea7e8554620/src/registry.ts
[web-ci]: https://github.com/WebMCP-org/agent-skills-ts-sdk/blob/8cb7480815ec39334095cbf2d2516ea7e8554620/.github/workflows/ci.yml
[web-ci-run]: https://github.com/WebMCP-org/agent-skills-ts-sdk/actions/runs/35168702880
[open-npm]: https://registry.npmjs.org/openskills/1.5.0
[open-read]: https://github.com/numman-ali/openskills/blob/3251f0ad436996c392ba0d5e1bfc7e1700149995/src/commands/read.ts
[open-skills]: https://github.com/numman-ali/openskills/blob/3251f0ad436996c392ba0d5e1bfc7e1700149995/src/utils/skills.ts
[open-yaml]: https://github.com/numman-ali/openskills/blob/3251f0ad436996c392ba0d5e1bfc7e1700149995/src/utils/yaml.ts
[open-dirs]: https://github.com/numman-ali/openskills/blob/3251f0ad436996c392ba0d5e1bfc7e1700149995/src/utils/dirs.ts
[tan-npm]: https://registry.npmjs.org/@tanstack%2fai-skills/0.1.4
[tan-index]: https://github.com/TanStack/ai/blob/bffdd186afee12d3bbd71986e9cc2793c8aeded6/packages/ai-skills/src/index.ts
[tan-node]: https://github.com/TanStack/ai/blob/bffdd186afee12d3bbd71986e9cc2793c8aeded6/packages/ai-skills/src/node/index.ts
[tan-middleware]: https://github.com/TanStack/ai/blob/bffdd186afee12d3bbd71986e9cc2793c8aeded6/packages/ai-skills/src/middleware.ts
