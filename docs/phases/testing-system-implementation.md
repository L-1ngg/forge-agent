---
doc_kind: plan
created: 2026-09-18
---

# 确定性测试体系施工与证据

> 状态:已完成（2026-09-19 核对）。实现与 Linux、三台 macOS 验收证据见下文；Linux 强制断网，macOS 仅提供完整 fixture 兼容性证据，PF 接入已撤回。[Issue #33](https://github.com/L-1ngg/forge-agent/issues/33) 已于 2026-09-18 关闭，需求与验收以该 Issue 为准；规格入口见 [testing-system.md](testing-system.md)。

## Entry 与设计

以下保留 Issue 关闭前的施工背景。基线 `3892705a585e50d49a1bb46bedf1ade108aae0eb`，Bun 1.3.12、pi-ai 0.85.1、fast-check 4.3.0。operator 确认：保留 Linux 强制断网，macOS 使用本地 fixtures、假凭据和独立配置目录运行完整测试；撤回 PF 接入，不再追查 Seatbelt 内部问题。验收完成后 operator 明确授权「可以，你可以提交并push了」，当时尚未授权关闭 Issue。此前临时诊断分支的一次 bootstrap 提交及结束后的分支清理已按有限授权执行。开始时 `docs/README.md`、`docs/plan.md`、`docs/phases/testing-system.md` 有未暂存改动，作为上下文保留，不混入该批实现提交；最后一份文件当时仅提交了状态行更新。

2026-09-19 的资源结算更新见 [Issue #34 施工记录](architecture-responsibilities.md)：Scenario 场景使用 `scenario.httpFixture(id, exchanges)` 创建 fixture，无需手动配对关闭或完整性断言。`withScenario` 成功退出包含全部预期请求核验；它先解除屏障、等待执行资源，再验证并关闭 fixture。取消/hold/断流允许响应未完整送达，但不豁免请求匹配；断言失败保持为主错误，结算故障保留为次要诊断。独立 HttpFixture 自检仍使用 `assertComplete()` 与 `close()`。

测试侧增加 `tests/support/`：场景资源与有界屏障、顺序证据、严格 HTTP fixtures；生产执行仍使用 SDK 默认装配，属性测试只在模型流边界注入脚本。受控工具必须显式声明预期调用。存储仍使用生产接口，必要时在 append 前暂停或失败。支撑层不复制 Agent 状态机。

Linux 离线入口新建只有 loopback 的 network namespace，限制由测试进程及 CLI、工具子进程继承；原生 socket 与 Bun/Bash/CLI 越界探针在每次测试组运行前验证内核拒绝。隔离不可用时明确失败，不降级；Linux CI 必要时仅通过 sudo 创建命名空间后降权回 runner 用户。

macOS 使用相同测试分组与完整门禁，直接运行本地 fixtures；不调用 Seatbelt/PF，不运行外网拒绝探针，也不要求相关系统权限。日志明确记录未启用操作系统网络隔离，测试通过只作为平台兼容性证据。两平台均传递白名单环境、隔离 XDG 配置/数据，使用假凭据，普通测试不调用真实供应商。Linux 的网络隔离也不承诺同宿主资源、文件系统或任意恶意代码沙箱。

协议 fixtures 由可审查手写字节构成，包含固定 provider/protocol/pi-ai 版本、来源、匹配条件和动态字段规则。严格比较场景相关消息、工具、参数、身份及顺序；无匹配、额外和缺失请求均失败。每段可以在显式屏障前后发送，结束、断开、错误终态分开建模；不假定 TCP 读取边界。普通运行只读，不录制，不更新。

## Batches 与风险映射

| 批次/风险 | Issue AC | 复用与新增证据 | 分组/边界 |
|---|---|---|---|
| B1 意外联网、fixture 放行、资源泄漏 | 1/2/9/10/11/14 | 新增离线入口、主/子进程越界探针、场景和 HTTP 支撑层自检 | contract / OS、HTTP |
| B2 状态归属、取消、保存及副作用 | 3/4/5/6 | 复用 `runtime-tools`、`runtime-session`、`incremental-session`、`input-ownership`；新增真实 SDK 场景和 fast-check 操作序列 | integration / SDK、生产会话 |
| B3 协议解析与重试 | 7/8/9 | 复用 `provider-replay`、`responses-terminal`、`runtime-retry`；新增 Anthropic/Responses 公共分段、取消、截断及严格多轮回放 | integration / 默认 SDK + HTTP |
| B4 交互和探针预算 | 12/15 | 保留全部 CLI/PTY、cell golden、headless；独立 live probe 及本地预算/分类测试 | cli / 正式 CLI、probe / 显式目标 |
| 各批拦截能力 | 13 | 人为绕过权限保护、保存屏障、严格网络匹配，目标测试必须失败，恢复后通过 | 本地临时变异，不进入产品 |

## Verify / Release

每片先运行目标测试与类型检查；交付前完整门禁一次，失败先定位而非自动重跑。完整入口覆盖旧测试发现范围，分组为互斥集合并核对无遗漏。CI 在 Ubuntu/macOS 跑相同入口，保存 Bun 原生报告、环境和耗时。操作序列失败保留 fast-check seed/path（命令模型适用时 replayPath），场景失败先提取事件/请求/工具/存储顺序再清理，清理失败不得替换主错误。

真实探针独立入口，要求明确 provider/model/key/request/time 预算，外层代理统计所有上游 HTTP 尝试（含重试），外层时限终止。只做隔离输入、受控工具续轮和取消，不做质量评价。operator 本次未指定真实目标和额度，因此真实执行 Not run，不计作真实供应商或人工验收通过，也不阻塞确定性支撑交付。

## Rollback

按文件撤回测试支撑及脚本、恢复 package/CI 入口即可回退；没有数据迁移、公开 SDK 新能力或依赖升级。若测试暴露产品 bug，单独记录有效契约与最小修复，不降低断言。

## 执行与诊断

| 命令 | 范围 | CI |
|---|---|---|
| `bun run check` | 依赖边界、包/automation/测试类型检查、以下三组完整测试 | Ubuntu/macOS 必跑 |
| `bun run test:contract` | 工具、cell golden、纯契约及支撑层自检 | 完整检查的 contract 组 |
| `bun run test:integration` | 真实 SDK、会话、HTTP 协议、属性序列、probe 的本地控制测试 | 完整检查的 integration 组 |
| `bun run test:cli` | 全部 PTY，包括正式 CLI 权限、取消和恢复 | 完整检查的 cli 组 |
| `bun run test:network` | Linux 本进程/原生 socket/Bun 子进程/真实 Bash 工具/正式 CLI 越界探针 | 每次 Linux 测试组开始前必跑；macOS 明确报仅支持 Linux |
| `bun run test:headless` | 原有 headless smoke；Linux 强制断网，macOS 使用 fixture 环境 | 双平台必跑 |
| `bun run typecheck:examples` | 公开 SDK 示例 | 双平台必跑 |
| `bun run test:live` | 显式真实目标的独立有限协议探针 | 不自动运行 |

`scripts/test-offline.ts` 按 Bun 支持的 test/spec 后缀发现测试，按 `testGroup` 互斥分组；未单列的用例归 contract，不删除旧测试。直接 `bun test <file>` 仍可用于局部开发，但不构成 OS 离线证据。Linux 需要 `unshare`、`ip` 和 Python 3，隔离不可用时入口失败；macOS 直接运行相同测试，不配置防火墙或进程网络沙箱。

`.test-results/{contract,integration,cli}.xml` 为 Bun JUnit；同名 `.log` 保存原始输出（含失败场景的顺序 trace 和 fast-check 参数）；`network.log` 在 Linux 保存越界探针结果，在 macOS 明确写入 `NETWORK_ISOLATION_NOT_ENFORCED`。`timings.json` 记录分组文件数、耗时、Bun/OS/架构及 `networkIsolation`（Linux 为 `network-namespace`，macOS 为 `none`）。CI 即使失败也上传 `test-evidence-<os>`，同时保留 Actions 日志。目录被 Git 忽略，正常测试不会更新 fixture。Linux/macOS 结果分别报告。

属性序列通过真实 SDK 的默认 HTTP 装配执行，不使用参考模型执行器。示例复现：`FORGE_TEST_SEED=33004 FORGE_TEST_PATH='0:2:2:2' bun test tests/integration/lifecycle.property.test.ts`；离线复现用相同环境加 `bun run test:integration`。数组任意值支持 seed/path 缩减，本期未使用 command model，故无 `replayPath`。旧 `abort-machine` 自检保留并明确标注非生产覆盖。

live probe 要求 `FORGE_PROBE_PROVIDER`、`FORGE_PROBE_MODEL`、`FORGE_PROBE_API_KEY`、`FORGE_PROBE_BASE_URL`、`FORGE_PROBE_MAX_REQUESTS`、`FORGE_PROBE_TIMEOUT_MS`。URL 为供应商 API 根（例如 Anthropic 不附加 `/v1/messages`，Responses 不附加 `/responses`），不能含凭据、query 或 fragment。所有模型及重试请求经外层代理计数，达到额度后禁止下一请求；所有阶段共享时间上限，超限杀掉 worker 并取消上游连接。目标 API key 只存在父进程，子进程只接触代理假 key；报告仅有分类、请求数、时间、HTTP 状态码。支持 `passed/refused/budget_exceeded/timeout/authentication/environment/protocol_failure`；取消用第二次任务的首个实际 delta 触发。普通离线测试仅使用回环假凭据验证此入口，不授权真实执行。

## 验证记录

当前简化版本的 `bun run check`、`bun run test:headless`、`bun run typecheck:examples` 在以下环境全部通过；各次 check 均为 623 pass / 0 fail（495 contract、116 integration、12 CLI）。没有自动重跑掩盖失败。

| 环境 | contract / integration / cli 耗时 | 网络证据 |
|---|---|---|
| WSL2 Linux / x64 / Bun 1.3.12 | 18.121s / 6.595s / 16.951s | namespace 内原生 socket、Bun/Bash/CLI 子进程外连被拒绝，回环可用 |
| macOS 14.8.9 / arm64 / Bun 1.3.12，runner 1 | 14.626s / 5.158s / 15.003s | `networkIsolation: "none"`，完整 fixture 兼容性 |
| 同上，runner 2 | 19.259s / 6.224s / 17.285s | 同上 |
| 同上，runner 3 | 15.827s / 5.798s / 15.579s | 同上 |

macOS 证据为 [Actions 35346406650](https://github.com/L-1ngg/forge-agent/actions/runs/35346406650)（`fixtures-platform-09`，三台独立 runner）。额外验证 `test:network` 明确非零退出并说明仅支持 Linux；日志记录 `NETWORK_ISOLATION_NOT_ENFORCED`，三组报告均为 `networkIsolation: "none"`。这证明新范围的兼容性通过，不表示 Seatbelt 根因已修复或 macOS 外网已被阻止。

本地证据根目录为 `.git/task-backups/issue33-actions-bootstrap-20260918/`：`linux-simplified-{check,headless,examples}.log` 保存 Linux 输出；`experiments/fixtures-platform-09/` 保存 dispatch、补丁、manifest、下载的三台 artifacts、Actions 日志及验证汇总。验收 payload SHA-256 为 `683bf61db37c6376cc31162323d96a14de02db3dc8e4a268c6562048e8ffdc24`；三台 artifact 的源文件 manifest、补丁及当前工作区的 26 个实现文件均核对一致。生产 `packages/` 与 `bun.lock` 无改动。

本轮简化版本审查：Standards 轴 0 项发现，Spec 轴 0 项发现；范围为平台入口、Linux 探针及相关 package/CI/贡献说明/双语 README，冻结版本见证据根目录 `simplified-review/manifest.json`。

以下为既有审查、反向验证和已停止调查的历史记录：

- Review：规范轴发现 HTTP 并发请求跨 await 复用同一 fixture 的假绿；新增双 socket + headers 屏障回归，修复前明确失败、修复后通过。规格轴发现续轮正文 matcher 仅比较子串；改为结构化完整消息/工具 schema 比较，仅去除声明的 cache 字段；增加工具参数、结果 ID、顺序、schema 被破坏时必须失败的双协议自检。修复后 14 个相关测试及测试类型检查通过；新增 3 个测试纳入后续 CI。
- B1：绕过 `HttpFixture` 正文 matcher，匹配失败测试变红（退出 1）。B2：绕过 `pi-port` 权限拒绝、移除 assistant 保存等待，现有真实 SDK 拒绝/保存屏障测试分别变红（退出 1）。
- B2 序列敏感性：去掉 `HostedAgent` 的 invocation id 检查后，seed `33004` 在第 1 组失败，缩减 3 次得到 `[["stale","run"]]`、path `0:2:2:2`；恢复后原 seed 的 50 组通过。
- B3：将生产 `resolveRetryPolicy` 的 maxRetries 强制为 0；B4 绕过外层代理请求预算判断，两者均使对应测试变红（退出 1）；恢复后重试及 probe 的 16 个回归通过。变异未提交，生产源码保持不变。
- 历史 macOS Seatbelt 验收失败：首次 CI `35318909475` 的 attempt 1/2 出现不固定位置的 loopback 监听失败。原生诊断 `35323361603` 确认 Bun 的 `EADDRINUSE` 包装下实际为 `listen → EPERM`；`35326840586` 在三台独立 runner 中进一步捕获 Python 与 Bun 对 `127.0.0.1` 的原生 listen/connect 拒绝，排除了 Bun/PTY 作为唯一原因。移除 bind 地址过滤、关闭日志、TCP 过滤和仅限制 IP 端点均未解决，不能记作修复。
- PF 候选诊断 `35329973689`：三台 runner 的原生端口扫描及每台 2,000 次 Bun 回环生命周期通过，TCP 规则有命中计数；现有原生探针因 PF 返回 `ECONNREFUSED` 提前停止，未获得完整 UDP、子进程及隔离边界证据。PF 仅是候选，未替换正式后端，不计作 AC-2 通过。
- 交付流程纠正：未完成双平台验收就向 `master` 连续推送诊断提交，是本次执行错误。临时 workflow 步骤还触发了已有精确列表断言；这些失败与网络故障分开记录。临时 C/Python 诊断、额外 CI 副本及诊断步骤已从当前工作区清除。后续在完成修复、审查和验证前，不再提交或推送试探性改动。
- Not run：真实供应商调用、模型质量/费用评价、人工验收、原生 Windows/Node.js。Why：未获真实目标与额度授权且不在确定性交付范围。Risk：离线字节 fixtures 不能证明真实服务长期兼容或模型任务质量；macOS 不强制阻止意外外连，网络边界证据仅来自 Linux，且不构成通用进程/文件系统沙箱。

## macOS 调查与范围调整

原 AC-2 要求两平台同时证明外部网络被阻止、回环可用及子进程继承。operator 现已明确收窄为 Linux 提供强制断网证据、macOS 提供完整 fixture 兼容性证据；Issue #33 的 Implementation Decision 9、AC-2 和决策来源已同步。以下为已停止调查的事实记录，不再构成本次 macOS 出口条件。

已确认的故障链是 `Bun.serve → 原生 listen → EPERM`，并有 Sandbox 的 `network-inbound` 拒绝日志。Bun 启动监听失败时可包装成 `EADDRINUSE`，因此上层错误不能证明端口占用。原生 Python 的 `socket()` 默认为 `AF_INET`，绑定 `127.0.0.1` 后仍在 `listen` 失败；这排除了 Bun/PTY 或 IPv4-mapped IPv6 作为唯一原因。另有 Bun 原生 `connect` 到 `127.0.0.1` 被拒绝的记录，所以只放开 inbound 也不足以修复。

关键原始证据来自 [三台 runner 对照运行](https://github.com/L-1ngg/forge-agent/actions/runs/35326840586)：Python 在端口 `49165`、`49179` 的 `listen` 返回 errno 1；Bun 在 `127.0.0.1:52343` 的 `listen` 和 `127.0.0.1:53800`、`:53325` 的 `connect` 返回同样错误。本地原日志为 `/tmp/forge-issue33/three-runners.log`。故障环境为 macOS 14.8.9 / arm64，镜像 `20260831.0302.1`。

Apple XNU 的公开调用路径在 `solisten` 前执行 `mac_socket_check_listen`，在连接前执行 `mac_socket_check_connect`，与策略拒绝发生于系统调用阶段相符；公开源码未绑定故障机器的精确内核构建，不能据此断言 Seatbelt 内部哪一处分支有缺陷。目前尚未证明地址匹配、策略缓存或宿主其他策略中的哪一个是根因。

上游配置仅作对照：[Codex 的 Seatbelt 实现](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/sandboxing/src/seatbelt.rs) 使用类似的 localhost 条件；[sandbox-runtime 的 macOS 实现](https://github.com/anthropic-experimental/sandbox-runtime/blob/e7d967974452273bb8ee26eb2e434e7899e6f9e1/src/sandbox/macos-sandbox-utils.ts) 说明 IPv4-mapped IPv6 的 localhost 匹配限制。这些不能解释本例的原生 AF_INET 失败，也不能代替目标环境验证。

接续实验 [35342384624](https://github.com/L-1ngg/forge-agent/actions/runs/35342384624) 用纯原生 `bind/listen` 扫描，在三台 Mac 中两台捕获 `EPERM`；普通运行与仅 `(allow default)` 的 Seatbelt 对照通过。同端口占用的独立对照未复现拒绝，未确认 Seatbelt 内部根因。更早的完整交换扫描触发普通运行的临时端口耗尽，不能当作原故障证据。

PF 的三台边界原型 [35343687658](https://github.com/L-1ngg/forge-agent/actions/runs/35343687658) 通过原生/Bun/Bash/CLI 与规则清理检查，但正式接入因 anchor 名称长度限制失败；审查还指出现有规则提前放行和安装期信号清理缺口。operator 随后拒绝该复杂度并确认简化方案。因此 PF 接入与专用探针已撤回，不再继续 PF、系统 DNS 或 Seatbelt 调查，不将原型结果记作正式验收。

operator 已授权一次临时分支 bootstrap 提交 `bd9919d091a91412b8e943150a14da91817e65b2`，后续通过 dispatch 输入传递未提交补丁，避免反复提交。入口与运行记录见 [诊断入口方案](../../review-notes/2026-09-18-issue33-actions-diagnostic-plan.md)。最终验收后已删除临时诊断分支和 bootstrap checkout，复现器移入本地证据备份；Actions 记录与必要实验材料保留在 `.git/task-backups/issue33-actions-bootstrap-20260918/`。清理时本地与远端 `master` 均保持基线；其后 operator 授权正式提交推送，交付版本以 Git 历史及对应 CI 运行记录为准。
