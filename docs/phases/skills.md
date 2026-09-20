---
doc_kind: plan
created: 2026-09-19
---

# Pi Skills 首轮接入施工图

> 状态:草稿，待 operator 确认施工设计(2026-09-19)。尚未实现或验收。
> 需求与任务级验收唯一来源：[Issue #35](https://github.com/L-1ngg/forge-agent/issues/35)。本文定义施工接口、提交时序与验证批次，不复制 Issue 的 AC。

## Why 与当前基线

在现有单 Agent 执行路径接入本地 Instruction Skills，提供分层发现、按需加载、显式调用和刷新。路线入口为 [plan.md](../plan.md)，本轮不含安装器、MCP、脚本执行或第二套 Agent loop。

核查基线为 `1d37dc1d08d79a94c11036257d2bdb09e0e3fd4a`：

- `createAgent` → `createPiPort` → `AgentSession` 已统一 SDK 与 CLI 的执行、权限和存储。
- `createPiPort` 保存 desired configuration；`AgentSession.updateConfiguration` 串行准备，`applyConfigurations` 在空闲或请求边界应用。当前模型响应及整批工具使用原配置。
- `prepareSessionTools` 已统一参数重写、schema 校验、hooks、权限及结果复制；持久记忆与上下文读取工具从 session 侧装配。
- `HostedAgent` 的 `AgentTurn.id`、`InputAcceptance.processed` 与 TUI `generation` 管理输入归属。Skills 的异步读取不能绕开这些边界。
- `config.ts` 拒绝未知顶层配置；CLI 默认目录、slash 分发和 headless 需要同时接线，不能只注册补全。
- 初始用户改动：`docs/plan.md` 一处未暂存修改；两份未跟踪文件 `docs/research/skills-integration-options.md`、`docs/research/skills-community-options.md`；暂存区为空。这些是上下文，不属于本任务提交。

## Entry Criteria

| 检查 | 通过标准 | 不通过怎么办 |
|---|---|---|
| 范围 | #35 为本轮规格；沿用既定三层目录、Pi 来源与测试边界 | 对照 Issue 修正施工图，不重开既定选型 |
| 设计 | operator 确认本施工图的公开接口及提交时序 | 保留草稿，不进入生产代码与依赖修改 |
| 来源 | 固定 Pi/spec SHA 可读取，记录完整迁入文件和测试的原始 SHA-256、MIT 许可 | 不用其他版本悄悄替代 |
| 基线 | 记录 HEAD/status，能够区分本次文件和用户改动 | 不覆盖、暂存或提交原有改动 |

## What：模块与来源

在 `packages/core/src/skills/` 内集中实现，保持 Core 不依赖 CLI/TUI：

| 文件职责 | 施工内容 |
|---|---|
| `upstream/`、`upstream.json`、`LICENSE`、`LOCAL_CHANGES.md` | 迁入 Pi scanner、frontmatter/text 与必要路径/来源/诊断类型；记录原始校验值及每类适配 |
| `catalog.ts` | 三层发现、严格校验、稳定排序、冲突/真实路径处理；返回不含正文的不可变 catalog |
| `load.ts` | 按有效名称查找、有界读取、修订检查、共享自动/显式加载结果 |
| `tools.ts` | `load_skill` schema、工具包装、成功/错误模型可见内容 |
| `types.ts` | SDK 导出的配置、目录、诊断、显式输入与错误类型 |

Pi 固定提交为 `36b60d2e8985899743c4cf5bd5f8929832a3f05d`。本次只读核对得到：

- `packages/coding-agent/src/core/skills.ts`：`055dbfde974fd1951267dd6f9204b5d713ff0004e0991eb870fce9158c6e359a`。
- `packages/coding-agent/src/utils/frontmatter.ts`：`99142d78b94e658e0be65cf05046be8069b3700168a683e0af64219ad903bcd6`。

迁入时补全依赖闭包、上游测试与 fixtures 的来源清单；运行依赖限所需的 `yaml@2.9.0` 与 `ignore@7.0.5`，不引入完整 coding-agent。不改变现有 runtime 的上游 SHA。

标准依据固定为 Agent Skills `69ef37e9424c0a7ea9dd2293b559e43ec8176379` 的 `docs/specification.mdx`。Forge 严格适配拒绝缺失或无效 `name`/`description`，核对实际根目录名，并校验 `license`、`compatibility`、`metadata`、`allowed-tools` 的标准类型/限制。未知扩展保留但不执行其语义；`disable-model-invocation` 必须为 boolean。Pi 的目录名回退、仅警告继续启用、顶层普通 Markdown 发现等行为不沿用，差异逐项记录并更新对应测试期望。

### 发现与目录身份

来源固定为 workspace → user → builtin；层内按相对来源根目录的路径排序，统一分隔符为 `/`，使用确定的字符串比较，不使用文件枚举顺序或 locale。先建立优先级，再按真实入口去重、按名称 first-wins。无效候选只产生诊断，不占用名称或遮蔽有效候选。

每个目录有 `SKILL.md` 即结束该目录的递归，包括入口无效时，避免将其 references 当作新 Skill。分组目录递归；真实路径 visited 集合阻断环路，符号链接别名不改变实际 Skill 根目录名。分别记录入口展示路径、真实入口和真实 base directory。

沿用 Pi 的 `.gitignore`、`.ignore`、`.fdignore` 规则及子目录规则组合；规则范围从每个配置的来源根开始，不继承来源根之外的忽略文件。始终排除 `.git` 和 `node_modules`；忽略文件读取失败可诊断。符号链接指向外部目录允许作为已配置来源的内容，应用入口扫描路径下的忽略范围，以真实路径控制重复/环路。

缺失的默认来源为空；显式来源缺失/非目录/不可读属于来源扫描失败。断链、无效 YAML、坏候选文件为局部诊断，其余候选继续。无法枚举来源或分组子树属于整体扫描失败，不用不完整空目录覆盖旧 catalog。创建时失败显式报错；刷新时失败保留旧状态及其 revision。

## SDK 接口草案

下列接口经 `packages/core/src/sdk.ts` 导出，内部通过 `AgentPort` 到 session；旧的字符串输入调用保持兼容。

```ts
type SkillLayer = "workspace" | "user" | "builtin";
interface SkillRoot { path: string; optional?: boolean; }
interface SkillsOptions {
  enabled?: boolean; // 配置对象存在时默认 true
  roots: Partial<Record<SkillLayer, SkillRoot>>;
}
interface SkillInvocation {
  kind: "skill";
  name: string;
  task: string; // 原始任务文字，不 trim、重新分词或重复追加
}
type AgentInput = string | SkillInvocation;

// CreateAgentOptions.skills?: SkillsOptions
// ConfigurationPatch.skills?: SkillsOptions | false
// Agent.runTurn(input: AgentInput): AgentTurn
// Agent.steer(input: AgentInput, expectedTurnId: symbol): InputAcceptance
// Agent.followUp(input: AgentInput, expectedTurnId: symbol): InputAcceptance
// Agent.getSkills(): SkillsSnapshot
// Agent.refreshSkills(): Promise<ConfigurationReceipt>
// AgentTurn.inputId?: string
// InputAcceptance 在 accepted:true 时增加 inputId?: string
```

显式 Skill 输入由 SDK 生成字符串 `inputId`，在对应 `AgentTurn` 或 accepted receipt 上提供，现有 `AgentTurn.id: symbol` 继续用于 turn 归属。`SessionEvent` 增加 `skill_input` 拒绝事件，包含 `phase: "rejected"`、`inputId`、`name`、结构化 `code`/`message`；读取或权限失败先发出该事件，再将该输入的 `processed` 结算为 false。初始输入失败的 turn 正常结算为 error，不将实例标记为存储故障。取消/释放时仍以 result/processed 的既有结算为准，不依赖已关闭事件流投递通知。宿主按 inputId 关联原文，不从自然语言错误反解析输入。

SDK 不提供 `skills` 时完全禁用；显式 `enabled: false` 不扫描。`roots` 未给出的层为空，相对路径以 `CreateAgentOptions.cwd` 解析，Core 不调用 `homedir()`。启停/来源变化用现有 `updateConfiguration`，`refreshSkills` 对现有 desired 来源重新发现，走同一串行队列，返回既有 accepted/applied/canceled receipt。

`SkillsSnapshot` 为宿主可安全复制的视图，至少含 `enabled`、生效配置 `revision`、`entries`、`diagnostics`。每项含 name、description、layer、entry、baseDirectory、contentRevision、自动调用标志，以及 `available`/`shadowed`/`invalid`/`duplicate` 状态与原因；坏 YAML 未必有 name。遮蔽项指明胜出入口。`getSkills()` 只返回当前 applied 状态，不能把 accepted 候选提前公开为有效目录。

自动目录只显示可自动调用项的名称与描述，并转义元数据；不含文件路径或正文。固定指引说明通过 `load_skill` 按名称加载，以及额外资料需要宿主已有的读取能力。catalog 为空时不生成空目录块；启用时仍注册加载工具以提供确定的未知名称错误。

### 只读加载与错误

`load_skill` 参数仅 `{ name: string }`，禁止额外路径/命令字段；名称匹配仅查有效 catalog，不在失败后尝试路径读取。工具闭包绑定当前 applied snapshot。启用时拒绝宿主工具同名冲突；停用撤下该工具。

成功结果含 name、layer、entry、baseDirectory、contentRevision 与完整 Markdown body；正文指 YAML frontmatter 之后的内容，保持原始文字，不因 Pi 的 trim/newline normalization 改写。标准元数据另行表示，加载不会读取 references。修订使用原始入口文件内容的 SHA-256，记录为 `sha256:<hex>`，不以 mtime 代替内容身份。

激活通过文件句柄分块读取并检查取消；解析 YAML/正文边界后，正文只允许累计到 50 × 1024 UTF-8 字节加一个判溢字节。上限按原始正文 UTF-8 字节核对；发现时可流式计算整文件 hash，不把全部正文长期保存在 catalog。frontmatter 另设 64 KiB 资源上限并明确诊断，防止无限 header 占用；这属于 Forge 资源限制，不冒称标准字段要求。大正文可列举，但激活必须拒绝，不截断为成功。

错误码至少区分 `skills-disabled`、`unknown-skill`、`explicit-only`、`permission-denied`、`missing`、`changed`、`too-large`、`invalid-skill`、`read-failed`、`canceled`。超长内容提示拆分 references，内容变化提示刷新。实际路径被替换、symlink 目标改变或文件内容改变均不能用旧元数据加载新正文。

## 配置、显式输入与权限提交

### 原子配置

`createPiPort` 保留基础 `systemPrompt` 与宿主原始 tools；准备出的 `SessionAssembly` 同时持有 catalog snapshot、组合后的 prompt 和装配工具。每次从基础 prompt 组合，不能把上一次组合结果当基础。模型切换或基础 prompt 更新复用当前 desired catalog，只有来源变化、启停或明确刷新才重新扫描。

刷新与普通 patch 共用 `AgentSession.configurationQueue`，失败不更新 desired/applied。`applyConfigurations` 一次切换 options、catalog、prompt、tools 和计量依据。当前响应及工具批次继续持有旧 snapshot；下一模型请求前才使用新状态。`dispose` 取消未应用 receipt，并等待扫描/准备收尾，禁止释放后继续发布状态。

### 显式输入

CLI 将 `/skill <name> [task]` 解析为 `SkillInvocation`；SDK 使用同一输入形状。显式输入在队列中保存选择与原始 task，在消费点才加载，不在用户打字或补全时读取正文，也不将 prepared string 暂存到全局。

在输入进入模型上下文/历史之前完成以下顺序：

1. 核对所属实例、活动 turn 和取消状态；应用当前请求边界已经接受的配置。
2. 固定本次请求使用的 applied snapshot，执行参数校验、权限判断（含 PermissionContext hooks）及共享正文加载。准备期间新接受的配置等待后一个请求边界，不能拆开切换 prompt/catalog。
3. 将有来源与修订标识的正文及原始 task 形成一条 user message，保存成功后按既有路径请求模型。显式选择允许 `explicit-only`；自动工具通道没有这个标志或旁路参数。
4. 成功进入输入处理后才确认 `processed`；读取/权限失败、取消、旧 turn 拒收将未处理原始输入返还宿主。失败零模型提交，不把未经展开的 slash 文本当成功输入。

优先复用现有 session 输入队列与 runtime 接缝。现有 runtime 会在 user `message_start`/`message_end` 附近更新状态，因此需要一个窄的异步输入准备接缝：对初始、steering、follow-up 输入均在写入 runtime context/历史和确认 receipt **之前**调用 session 提供的准备逻辑；普通字符串原样通过。准备失败通过明确的输入错误结果结束/返还该输入，不作为存储故障永久停用实例，不产生半条 user 历史。这个接缝不新增执行循环或独立排队系统；若涉及 runtime 本地修改，记录到其既有本地差异说明，并保留普通输入、one-at-a-time 与取消回归。

自动加载仍完整经过 `prepareSessionTools`，包括 `ToolHooks` 与参数重写。显式调用复用纯参数校验、`PermissionContext`/`RequestBus` 权限预检及加载服务，以 `load_skill` 和所选 name 判断同一权限规则，但作为 host input 提交，不伪造 assistant tool_call/tool_result。现有 `ToolHooks` 上下文要求真实 `assistantMessage`，因此只用于自动工具调度，显式输入不调用它或模型专用 `toolInputRewrites`；显式通道的权限 hooks 仍来自 `PermissionContext`。显式选择本身不绕过 deny 规则；`allowed-tools` 不生成授权。CLI 对 `load_skill` 按现有只读工具策略装配 built-in allow，优先级仍低于 hooks/deny rules；SDK 不自动注入该 allow。若需额外 `read`/`bash` 而宿主没提供，加载指引如实说明，不能自行注册。

### 预算、压缩与恢复

组合后的 prompt 与最终 tool schema 经现有 compaction/usage 路径计量。发送前核验固定文本与本次完整输入能否进入实际预算；即使上下文压缩关闭也不能超预算直发 Skills 请求。失败提示减小来源或拆分内容，不静默删除 catalog 项，不把正文截短。

压缩只改变请求投影，不改写原始历史。恢复时重新发现当前 catalog，旧 user/tool 记录保持原有正文、来源与 revision；历史检索仍读旧证据。当前文件变化不在恢复阶段伪装成已加载新正文。两个 Agent 的 snapshot、配置队列、权限和历史完全按实例持有。

## CLI/TUI 与配置

- `HarnessConfig.skills` 接受 `enabled` 及三层路径覆盖；配置文件仍放在现有位置。配置中的路径按启动 cwd 解析并在文档说明；默认 workspace 根使用 Git worktree root，无 Git 时用启动目录。
- 默认根为 `<project>/.forge/skills`、`~/.forge/skills`、CLI 产品资源 `builtin_skills/`。默认缺失根标记 optional；用户显式覆盖的根不标记 optional。内置集合本轮为空，保持可定位的资源目录及分发路径测试。
- `/skills` 展示有效项、遮蔽/重复项和诊断；`/skills reload` 报告 accepted，再按 receipt 展示 applied/canceled。普通列举不创建 user 历史，也不调用模型。
- `/skill <name> [task]` 只消耗命令与名称分隔符，task 剩余文字保持原文。TUI 完成命令及技能名补全，名称来源只读当前 catalog；不在候选中漏掉可显式调用项。
- headless 支持 `--json -p '/skills'`、`--json -p '/skills reload'` 和 `--json -p '/skill name task'`；新增 `--no-skills` 覆盖 CLI 配置。管理命令无模型调用，列举/诊断输出为 JSON 对象行，错误走既有 JSON error 通道，不混入普通日志。
- TUI 异步准备绑定 `generation`、session id、输入 id 与取消信号；会话切换/退出取消旧准备，迟到结果不得提交到新实例。未处理输入按既有草稿/队列机制返还，不能简单清空输入框。
- 同步 `README.md`/`README.zh-CN.md`、`docs/sdk.md`/`docs/sdk.en.md` 及配置示例；公共说明只在对应能力实现并验证后更新。

## Batches 与 Test plan

测试直接沿用 #35 的 Testing Decisions：主边界为真实公开 SDK、生产装配、受控 HTTP/SSE provider、临时目录和真实存储；CLI/headless/PTY 只补宿主接线。沿用 [现有测试施工](testing-system-implementation.md) 的 Linux OS 断网与 macOS fixture 兼容性边界。真实模型选用效果单列，不作为确定性软件出口。

每批纵向按 TDD 推进，一条可观察失败测试 → 最小实现 → 类型检查/目标测试，不先铺满内部 helper 单测。

| 批次 | 改动与验证 | Issue 验收映射 |
|---|---|---|
| B1 | 来源/许可与 Pi 复用测试；真实目录覆盖、标准字段、symlink/忽略规则；SDK 最小创建/查询/禁用 | AC-1–5、AC-13 |
| B2 | 自动工具与显式输入贯穿 SDK 请求、权限、取消、完整正文/修订和真实历史；50 KiB 的 ASCII/多字节边界 | AC-6–9、AC-11 |
| B3 | 受控屏障保持响应/工具批次运行，刷新及配置交错；失败保旧、dispose receipt、两实例并发、压缩及重开历史 | AC-10–13 |
| B4 | 正式 CLI/headless/真实 PTY 的命令、补全、禁用、权限失败、取消/排队/切会话/恢复；双语接入说明 | AC-8、AC-14 |
| B5 | 反向验证、必要全量门禁、两轴代码审查、修复后复查，仅提交已审查的本任务文件 | AC-15 |

SDK 主用例拟放 `packages/core/test/sdk-skills.test.ts`，复用 `tests/support/` 的 Scenario/HTTP fixture/barrier；模块复用测试另列，CLI 实际进程与 PTY 放 `tests/tui-integration/`。严格检查多余/缺失 HTTP 请求；失败保存请求、事件和历史诊断。不得用内部 Map 或 mock loader 替代这些证据。

反向验证至少一次临时颠倒 workspace/user 覆盖，确认 SDK 可观察正文与来源用例变红，然后恢复并重跑目标用例。检查脚本执行哨兵始终不存在，发现/刷新/恢复无副作用。

日常运行相关单文件及 `bun run typecheck`/`bun run typecheck:tests`。末尾运行一次 `bun run check`（含正式离线全量测试），并运行 `bun run typecheck:examples`、`git diff --check`。只有新修改、失败或未解决疑点才重复对应检查；macOS 若未实跑，报告未验证，不用 Linux 结果代替。

## Release 与 Rollback

软件出口是 #35 AC-1–15 的对应证据齐全、门禁通过及审查问题已处理。真实模型小规模探针、人工长期使用、原生 Windows/Node.js 兼容不作为这个软件出口，仍须分别报告 Ran / Not run / Why / Risk。

`implement` 收尾前以起始 SHA 和本任务文件/hunk 范围做 Standards/Spec 双轴审查；原始用户改动只作上下文。修复后刷新审查输入，再检查暂存 diff，提交到当前分支。本请求未要求 push 或关闭 Issue，远端动作不纳入本次本地提交。

配置 `skills.enabled: false`/CLI `--no-skills` 为运行时退出路径：撤下目录和加载工具，保留已经保存的历史证据。源码回退按依赖逆序 B4 → B3 → B2 → B1；每批保持编译和既有测试通过。关闭功能不删除用户 Skill 文件、历史或既有配置目录。

## Risk 与当前证据

| 风险 | 验证/防护 |
|---|---|
| Pi 的宽松行为被误当标准实现 | 固定规范、严格适配差异表、上游用例与 Forge 集成证据分列 |
| 显式输入在异步准备后失去归属 | 请求快照、输入消费接缝、processed 与取消/切会话屏障测试 |
| 新 catalog 与旧 prompt/tools 混用 | 一份 SessionAssembly、同一配置队列、运行中双版本请求断言 |
| 大目录/大文件占用或超预算 | 有界激活、元数据资源限制、完整固定文本预算，不静默截断 |
| 当前正文覆盖历史证据 | 原始历史不改写，持久化来源及 SHA-256，重开文件变化用例 |

本次草稿的 Ran：读取 #35、现行 SOP/输入与配置合同、相关 SDK/CLI/runtime 源码，核对上述两份固定 Pi 源文件 SHA-256。Not run：生产实现、类型检查、测试、真实模型、macOS。Why：当前只完成需确认的施工设计。Risk：本文是设计，不是功能完成或验收证据；实现阶段按上述公共边界逐批证明。
