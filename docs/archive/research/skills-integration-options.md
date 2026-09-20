# Skills 接入方案调研

> 状态:已归档(2026-09-21)。下文保留当时设计与验证，不作为当前实施依据；现行入口见[当前合同与设计](../../phases/skills.md)。历史未测、豁免及中止结论保持原意。

> 历史状态:调研完成，首轮规格见 [Issue #35](https://github.com/L-1ngg/forge-agent/issues/35)(2026-09-19)。本文保留选型时的比较与建议，不代表功能已实现；用户后续指定的首轮范围、目录与验收以该 Issue 为准，Vercel 安装器和备用 SDK 不进入首轮。Forge 核查基线 `1d37dc1d08d79a94c11036257d2bdb09e0e3fd4a`；社区候选的补充源码、版本与验证证据见 [社区方案核查](skills-community-options.md)。

## 结论

按“优先社区已有、成熟方案”的要求，推荐 **Agent Skills 标准 + 固定版本的 Pi Skills 小模块复用 + Forge 宿主适配**。安装与更新优先使用现有社区 CLI，不自建 Skill 市场或下载器。

这里的复用是保留上游实现、许可证、测试与提交来源，只适配目录和宿主接口。它仍产生少量本地维护责任，但能复用已有的解析、发现、诊断、去重和提示词格式化逻辑。没有必要重新设计 Skill 格式，也不建议为了这些函数引入完整 Pi coding-agent 应用。

如果要求“必须通过包依赖复用，不接受维护任何上游源码”，则 **`agent-skills-ts-sdk@2.5.0` 是可行备选**：它是可独立使用的轻量 TypeScript 库，发布包在 Bun 下烟测通过；其社区使用与维护规模证据弱于 Pi，目录扫描和 Forge 会话接入也仍需宿主完成。不能把独立发布、版本号 2.x 或一次烟测当作成熟度保证。

## 一、候选比较

| 候选 | 实际提供的能力 | 对 Forge 的意义 | 建议 |
|---|---|---|---|
| Agent Skills 标准 | `SKILL.md`、YAML 元数据、渐进加载约定 | 与现有社区 Skill 文件互通 | 采用格式和交互原则 |
| 官方 `skills-ref` | Python 示例解析、校验和 prompt 生成 | 参考与互操作校验 | 不作生产运行时；官方明确是 demonstration library |
| Pi `skills.ts` | 目录发现、解析、校验诊断、真实路径去重、名称碰撞、catalog 格式化 | 与 Forge 的 Pi 来源和 `read` 工具模型最接近 | 首选固定源码复用 |
| 完整 `@earendil-works/pi-coding-agent@0.85.1` | 上述函数，以及 AgentSession、ResourceLoader、CLI/TUI、扩展和包管理 | 可公开导入函数，但安装边界远大于需求 | 不推荐作为 Forge 依赖 |
| `agent-skills-ts-sdk@2.5.0` | parser、validator、registry、systemPrompt、读资源接口/tool 定义 | 真正可直接依赖的轻量库，存储由宿主提供 | 直接依赖备选；成熟度证据有限 |
| `@tanstack/ai-skills@0.1.4` | Skill 发现、上下文和工具集成 | 绑定 `@tanstack/ai` 与其工具抽象 | 不为 Skills 引入另一套 AI 框架 |
| Vercel `skills@1.7.0` | 安装、列举、更新及多宿主目录分发 | 可以承担外部安装工作 | 采用外部 CLI；不是 Forge loader |
| `openskills@1.5.0` | 安装、read、sync 等 CLI 工作流 | 能通过命令读取 Skill，适合 CLI 互操作 | 可选外部工具；不作为 SDK 内置运行时 |

社区候选来源及包结构见 [社区方案核查](skills-community-options.md)。以下对 Pi 与 Forge 的判断来自固定源码和本次实测。

## 二、为什么优先 Pi 小模块

### 2.1 已有能力与维护证据

Pi 官方将 Skills 用在自身 coding-agent 中，采用“元数据常驻，正文按需读”的方式，并提供显式 `/skill:name` 调用。[P1][P2][P5]

核查的源码快照为 `36b60d2e8985899743c4cf5bd5f8929832a3f05d`；npm `0.85.1` 元数据的 `gitHead` 是 `d981de1229ef899957bbe968bc8dcda02a21f477`。两者的 `skills.ts` 内容相同，SHA-256 为 `055dbfde974fd1951267dd6f9204b5d713ff0004e0991eb870fce9158c6e359a`。这不表示其他文件也全部相同。[P2][P3]

该模块已有 28 个上游测试；近期变更包括 2026-09-03 的 bash-only 加载支持修复，以及 2026-08-17 的 root Markdown 发现修复。仓库持续维护、有实际宿主使用，是本次判断其相对成熟的依据；仓库热度不能证明 Forge 集成后的可靠性。[P4][P7]

### 2.2 直接依赖完整包的代价

`0.85.1` 的包根导出 `loadSkills`、`loadSkillsFromDir` 和 `formatSkillsForPrompt`，但 `exports` 没有 `./skills` 这样的独立子路径。依赖清单同时包含 `pi-agent-core`、`pi-tui`、`chord`、图像处理与应用层依赖，总计 19 个直接依赖，包展开大小约 21.9 MB。这是包元数据大小，不是最终安装总量或内存测量。[P3]

所以“只 import 一个函数”不等于“只安装 Skills 模块”。未经完整 import 运行与打包分析，也不能假定 tree shaking 可以消除入口副作用或依赖安装成本。

Forge 已本地维护执行内核，依赖边界检查禁止直接依赖/import `pi-agent-core`。完整 coding-agent 的传递依赖未必被当前脚本直接拦截，但会引入另一套 Agent 与 UI 组件，偏离本次需要的能力边界。依据见 [当前上游来源](../../../packages/core/src/runtime/upstream.json)、[依赖检查](../../../scripts/check-deps.ts)、[SDK](../../sdk.md)。

### 2.3 最小复用单元

建议保留或迁入的上游逻辑：

- `core/skills.ts`：发现、解析入口、校验提示、碰撞和 prompt 格式化。
- `utils/frontmatter.ts` 与 `utils/text.ts`：使用社区 `yaml` 包解析，不手写 YAML parser。
- 所需路径辅助函数与诊断/来源类型：仅保留被 Skills 使用的部分，避免带入 Pi 自更新、包管理、进程启动等应用代码。
- `test/skills.test.ts` 与 fixtures：保留归属；测试运行器适配到项目现有 Bun。
- `LICENSE`、固定 commit、文件校验值与本地差异说明：沿用 Forge 当前内核源码复用的来源记录方式。

外部运行时依赖可收敛到 **`yaml` 与 `ignore`**。本次验证使用 `yaml@2.9.0`、`ignore@7.0.5`。这是一条已验证可运行的拆分路径，不是已经发布的独立 Pi Skills 包。[P2][P6]

需要 Forge 自己负责的部分是目录策略、SDK/CLI 接线、显式输入提交、上下文预算和刷新时机；换任何社区 loader 都不能免除这些宿主职责。

## 三、建议的 Forge 接入方式

### 3.1 加载与执行流程

```mermaid
flowchart LR
  A[本地 Skill 目录 / 外部安装器] --> B[复用的 Pi loader]
  B --> C[Skill catalog + diagnostics]
  C --> D[基础 systemPrompt + 元数据目录]
  D --> E[Forge 现有 Agent]
  E --> F[现有 read 工具按需读 SKILL.md]
  F --> G[现有工具与权限路径执行任务]
```

发现阶段只将名称、描述、路径放进模型上下文。Pi 实现实际上会读取整个 Markdown 文件来解析 frontmatter，但不会把正文全部塞进 prompt；不能把“渐进披露”误称为“启动时磁盘只读取 YAML”。正文、references 和 scripts 由后续需要驱动读取。[P2]

自动选用 Skill 依赖模型根据 description 判断，社区 loader 不提供确定性的任务分类器。显式调用保证选定的指令进入请求，不保证模型正确执行任务。

### 3.2 目录与冲突

建议的首批目录约定：

- 项目 `.agents/skills/`；用户目录兼容 `~/.agents/skills/` 和 `$XDG_CONFIG_HOME/agents/skills/`（未设置时为 `~/.config/agents/skills/`）。后者是 Vercel `skills@1.7.0` 的 `universal` 全局安装落点，只支持前者会漏掉该安装产物，证据见 [社区核查](skills-community-options.md)。
- 允许显式传入文件/目录；`.claude/skills`、`.codex/skills` 和其他路径通过配置接入。
- CLI 负责解析用户目录、项目/worktree 根目录；SDK 宿主可以传目录或预加载 catalog，不要求所有宿主扫描本机 home。
- 名称冲突建议采用 **显式路径 → 项目 → 用户 `~/.agents` → 用户 XDG** 的优先级，并输出胜出/被遮蔽路径。两个用户目录的次序是待施工图冻结的 Forge 策略。相同真实文件通过 symlink 重复出现时去重。

这些是 Forge 的建议策略，不是 Agent Skills 标准强制要求。Pi 的 `loadSkills` 默认顺序实际为 user → project → 显式路径，且 first-wins；若采用上述优先级，应以 `includeDefaults: false` 加入排好序的显式路径，不能照用默认值后声称“项目覆盖用户”。[P2]

还需注意：Pi 完整应用支持 `.agents` 目录的约定，但裸 `loadSkills` 默认只处理自身 `agentDir/skills` 和 `cwd/.pi/skills`。仅复制该函数不会自动获得整个 ResourceLoader/PackageManager 的路径行为。[P1][P2][P8]

### 3.3 SDK 与上下文

现有 [CreateAgentOptions](../../../packages/core/src/agent.ts) 已接收 `systemPrompt` 和 `tools`，并支持 `updateConfiguration`。推荐将 catalog 的生成放在执行 loop 之外，通过一个公开、无 TUI 依赖的适配入口给 SDK 与 CLI 共用；具体 API 名称留给施工设计，不在调研中新增正式契约。

接线约束：

1. 保存原始基础 prompt，生成 `basePrompt + skillCatalog`；刷新时重新组合，避免重复追加。
2. Skills 生效后的实际 prompt 必须经过现有配置更新路径，使 [上下文预算](../../../packages/core/src/context/coordinator.ts) 与 usage 使用同一份内容。不要只在 provider 调用前临时拼接。
3. 只有宿主提供可用的文件读取能力时才向模型暴露对应的路径读取说明。Pi 支持 `read`，缺失时使用 `bash`；SDK 可以完全不装配这两个工具，不能无条件给出不存在的工具名。[P5]
4. 技能加载后仍复用 [工具权限和 hooks](../../../packages/core/src/session-tools.ts)。`allowed-tools` 是标准中的实验性元数据；Pi loader 没有将其实现成 Forge 权限规则。第一版应明确它不会授予额外工具权限。[P2]
5. 当前 [read](../../../packages/tools/src/read.ts) 有 2000 行 / 50 KiB 截断和续读指示；长 Skill 必须继续读取或明确报告未完整加载，不可用“工具成功”代表指令已读完。

### 3.4 显式调用、刷新和恢复

建议首批支持显式选择一个 Skill，并附带用户任务。可以采用 Pi 的 `/skill:name` 语法，但 Forge 当前 [slash parser](../../../packages/core/src/input/slash.ts) 不接受命令名里的 `:`，输入补全与提交分发也需一起接线。不能只注册补全项。

Pi 的实现把正文包装为带 name/location 的文本再进入用户输入，相关代码在 AgentSession 中，而不在 `skills.ts`。若采用这个交互，需要移植小范围展开逻辑并走 Forge 已有输入提交边界；CLI/headless/SDK 应共享能力，保持任务参数、排队和取消语义。[P5]

建议第一版仅在新建会话或显式刷新时重新扫描，不先实现文件监听。对运行中的刷新沿用现有配置更新提交边界；Skill catalog 与显式调用解析必须来自同一版本，避免新旧路径混用。

上下文压缩后，system prompt 中的 catalog 仍可用，但历史 `read` 返回的正文可能被压缩；仅接入 loader 不会自动重新加载全部“已启用 Skill”。第一版应明确按需重读路径，使用现有历史证据检索恢复过去结果，不承诺 Skill 正文永久常驻。恢复会话时建议重新扫描当前目录并报告失效路径，历史记录不重写；若要求完整重放旧版本 Skill，则需额外的内容版本/快照设计，不能算 loader 自带能力。

## 四、首批范围与验收建议

首批交付可限制为：本地 Skill 发现、标准元数据和诊断、catalog 注入、现有工具按需读取、显式调用、手动刷新、SDK/CLI 一致行为。脚本依赖安装、远端获取和升级由既有外部工具处理；不需要自建市场、语义检索路由或新的执行引擎。

应验证的产品边界：

| 验收方向 | 可观察结果 |
|---|---|
| 发现与优先级 | 不存在路径、无效 YAML、缺失 description、同名与 symlink 都有确定结果；明确忽略规则与目录范围 |
| 渐进加载 | 首个请求只有元数据，选择后才有正文；references 的相对路径基于 Skill 所在目录 |
| 显式调用 | 指定 Skill 与用户参数准确进入一次提交；未知 Skill 不伪装成已加载；TUI/headless/SDK 路径一致 |
| 权限 | Skill 中要求的读写和脚本执行经过原权限/hooks；frontmatter 不新增授权 |
| 上下文与刷新 | catalog 计入预算，刷新不重复追加，当前请求与排队输入行为明确，正文截断可见 |
| 压缩与恢复 | catalog 可用、历史正文缺失时可以重读；文件修改/删除有可解释结果 |
| 多实例 | 两个 SDK 实例的目录、catalog 和刷新互不串扰 |

目录遍历还需要测试 symlink 环路和扫描失败：上游扫描会跟随 symlink，但该递归函数没有显式 visited-directory 集合，且部分扫描异常被静默忽略。这是已读源码中的具体边界，本次未实测环路行为，不能将文件级 realpath 去重等同于防循环遍历。[P2]

软件测试与真实模型效果分开：前者检查上述确定性契约；后者用少量固定任务验证模型会不会正确选择、完整读取和遵循 Skill，以及 catalog 的实际 token 成本。测试通过不能替代模型选用效果证据。

## 五、本次验证与限制

### Ran

- 读取官方规范、维护者源码、npm 包元数据与固定 commit；Context7 仅用于定位 Pi 官方文档，关键 API 以固定源码复核。
- 在 `/tmp` 中隔离复用 Pi 模块，用 **Bun 1.3.12** 验证，未修改 Forge 的依赖或生产源码。
- 保持 `skills.ts`、frontmatter、text、source-info 与诊断模块原样；将 Pi config 替换为目录常量/函数，将 paths 截取到所需辅助函数并移除无关的进程调用 import。该 probe 只验证运行时，不进行完整 TypeScript 构建；source-info 中未用到的类型引用不影响 Bun 运行，不代表最终移植可以省略类型整理。
- 下载同一 commit 的 **16 个 fixtures**；上游测试只将 `vitest` import 改为 `bun:test`：**28 pass / 0 fail，73 assertions**。
- 追加四项隔离检查：真实 loader 的 first-wins 碰撞、symlink 真实路径去重、prompt 不带正文、重新加载可见描述修改：**4 pass / 0 fail，10 assertions**。补充实际碰撞检查是因为上游相应测试自行模拟 Map，并未直接覆盖 `loadSkills` 碰撞入口。
- 轻量 SDK 发布包的 Bun 烟测及源码边界见 [社区核查](skills-community-options.md)。

### Not run / Why / Risk

- 没有将 Skills 接入 Forge、没有修改生产配置/依赖，也没有 commit、push 或创建 Issue；本次请求为方案调研。
- 未运行真实模型、Forge 完整集成、原生 Windows/macOS 路径矩阵、性能或大目录扫描测试。当前结果证明所选模块可在本机 Bun 隔离运行，不证明最终 Forge 产品已支持 Skills。
- 未执行社区 Skill 脚本、安装真实用户 Skill 或运行外部安装器；安装器兼容性目前为源码/包契约证据。
- 未完整执行 Pi 的 Vitest 工程或轻量 SDK 的全部上游测试；不宣称两套项目全量测试通过。

复现 Pi probe 的关键输入已经固定：`36b60d2...` 的上述源码、`test/skills.test.ts`、`test/fixtures/skills*`，只安装 `yaml@2.9.0` 与 `ignore@7.0.5`，使用 `bun install --ignore-scripts` 和 `bun test`。临时下载与实验目录在报告完成后清理；正式实施时应将采用的测试与来源元信息纳入版本控制。

## 六、下一步建议

以 Pi 小模块方案编写施工图，先冻结目录/冲突、显式调用、刷新和压缩后行为；随后按现有 SDK 路径做最小闭环，再验收工具权限、恢复和模型效果。若选直接包方案，则用 `agent-skills-ts-sdk` 替换 loader/registry 部分，宿主接线与上述验收仍然保留。

该建议无需推翻通用单 Agent 定位；实际采用范围应进入施工图或 ADR 后再实施，不把本研究改写成已批准契约。

## 来源

- [P1 Pi Skills 官方文档，固定源码](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/docs/skills.md)
- [P2 Pi skills.ts，固定源码](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/src/core/skills.ts)
- [P3 npm pi-coding-agent 0.85.1 元数据](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/0.85.1)；[发布提交 package.json](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/package.json)；[根导出](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/src/index.ts)
- [P4 上游 Skills 测试](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/test/skills.test.ts)
- [P5 system-prompt.ts](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/src/core/system-prompt.ts)；[AgentSession 显式展开](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/src/core/agent-session.ts#L1430)
- [P6 Frontmatter parser](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/src/utils/frontmatter.ts)；[MIT license](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/LICENSE)
- [P7 bash-only 修复](https://github.com/earendil-works/pi/commit/1d6dbf9e3d60f129bf8ee513c82a98f222c57788)；[目录发现修复](https://github.com/earendil-works/pi/commit/8c2529daebe0eac5aecb54424b607b4c88d55e15)
- [P8 ResourceLoader](https://github.com/earendil-works/pi/blob/36b60d2e8985899743c4cf5bd5f8929832a3f05d/packages/coding-agent/src/core/resource-loader.ts)
