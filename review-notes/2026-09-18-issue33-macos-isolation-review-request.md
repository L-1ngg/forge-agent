---
doc_kind: review-request
created: 2026-09-18
---

# 任务交接：Issue #33 与 macOS 离线隔离

> 状态:已接续完成（2026-09-18）。operator 后续确认 Linux 强制断网、macOS 仅做完整 fixture 兼容性验证；简化方案双平台验收已通过，并已获正式提交推送授权，Issue 保持 OPEN。下文为接续前的历史快照，旧的 macOS 隔离要求与待授权事项已被后续决定覆盖；当前结果见[施工记录](../docs/phases/testing-system-implementation.md)，执行与授权记录见[诊断入口](2026-09-18-issue33-actions-diagnostic-plan.md)。

Target: `/home/l1ngg/dev/forge-agent` 当前未提交工作区，重点为 `scripts/test-offline.ts`、`tests/support/network-probe.ts`。

SHA-or-Doc-Version: 基线 `3892705a585e50d49a1bb46bedf1ade108aae0eb`；本交接绑定 2026-09-18 的工作区快照，具体文件 SHA-256 见 `.git/task-backups/issue33-handoff-20260918/workspace-manifest.json`。这是未完成工作的交接，不能当作验收通过。

## 原始需求

以下均为 operator 在本会话的原话，按最新约束执行：

> 好的，现在请你从第一性原理出发，分析一下macOS 隔离问题失败的原因，然后修复它并验收，先不要提交
> 目前只有 GitHub Actions
> 你不是未能完成任务吗？我看这个会话窗口上下文差不多了，我打算新建一个窗口来跑，请你做一下任务交接

## What / Why

原任务是实现并验收 [Issue #33](https://github.com/L-1ngg/forge-agent/issues/33)。确定性测试支撑已写入工作区，Linux 完整门禁通过；macOS Seatbelt 隔离却会偶发拒绝 fixture 所需的回环 socket。后续目标是解释并修复此故障，保留外部网络限制，完成真实 macOS 验收。最新指令覆盖最初的 commit/push 授权。

先读 [AGENTS.md](../AGENTS.md)、[SOP](../docs/SOP.md)、[施工与证据](../docs/phases/testing-system-implementation.md)，再按需要看 Issue。规格入口为 [testing-system.md](../docs/phases/testing-system.md)；Issue 是需求与验收标准的真相源。不要重做 Issue #33 设计，也不要把隔离问题扩大成通用安全沙箱项目。

## Git 状态与必须保留的改动

交接时重新核验：

- 当前分支 `master`，本地 HEAD 与 GitHub `refs/heads/master` 均为 `3892705a585e50d49a1bb46bedf1ade108aae0eb`。
- 暂存区为空；Issue #33 的实现和文档在未暂存/未跟踪工作区。`git diff` 不会显示未跟踪文件的正文，不能由其小统计量误判实现丢失。
- Issue #33 为 OPEN，未获关闭授权。
- 生产 `packages/` 源码、`bun.lock` 无改动，没有新增依赖。变异验证对生产源码的修改均已恢复。

此前 agent 在 macOS 验收未通过时，向 `master` 连续提交/推送了 13 次实现与诊断。用户对此明确不满，随后明确授权清理远端历史。清理已完成，保留工作区全部内容，不要再做一遍：

- 本地备份分支 `backup/issue33-before-history-cleanup-20260918` 指向 `bce029af0a67f86fffc7814f72585a1421f44d8a`，保留全部旧诊断提交，未推送此备份分支。
- 清理前快照：`.git/task-backups/issue33-before-history-cleanup-20260918/`。当时验证 386 个工作区路径未改变。
- macOS 新一轮诊断前快照：`.git/task-backups/issue33-macos-fix-20260918/`。
- GitHub 上旧 Actions 运行记录仍保留，用户没有授权删除它们。
- 不运行 hard reset、clean 或再次 force-push；不通过持续推送 `master` 试错。

原任务开始前，operator 已修改这三个文件：`docs/README.md`、`docs/plan.md`、`docs/phases/testing-system.md`。原始差异保存在 `/tmp/forge-issue33/initial.patch`、`initial-testing-system.md`，已另存到下文的 evidence 目录。共享的 `testing-system.md` 只有本次状态行更新属于 agent；其他原始编辑保留，后续若允许提交也不能误收用户改动。

## 当前实现入口

| 文件/目录 | 已有内容 |
|---|---|
| `scripts/test-offline.ts` | contract/integration/cli 互斥分组；Linux network namespace；macOS Seatbelt；环境白名单；JUnit/日志/耗时记录 |
| `tests/support/network-probe.ts` | 原生 socket 外网拒绝、Bun 网络检查、100 次 PTY/HTTP 回环生命周期、Bun/真实 Bash/正式 CLI 子进程检查 |
| `tests/support/{scenario,http-fixture,controlled-tool}.ts` 及自检 | 场景资源、屏障、顺序证据、严格 HTTP 脚本、受控工具 |
| `tests/fixtures/` | 两协议族字节 fixtures、结构化请求 matcher、matcher 自检与来源说明 |
| `tests/integration/` | 真实 SDK 协议、重试、取消、生命周期属性序列 |
| `tests/tui-integration/permission.test.ts` | 正式 CLI/PTY 权限代表流程 |
| `scripts/live-probe*.ts` | 独立供应商探针、外层请求/时间预算、受控本地测试 |
| `tsconfig.tests.json`、`package.json` | 测试类型检查与运行入口 |
| `.github/workflows/verify.yml` | 正式双平台门禁和 evidence 上传，无临时诊断步骤 |

完整批次映射、风险边界、反向验证和命令见施工与证据文档，不在此复制规格。

## 已确认的 macOS 故障

失败环境为 macOS 14.8.9 / arm64，GitHub 镜像 `20260831.0302.1`，Bun 1.3.12。

1. Bun 的 `EADDRINUSE errno:0` 是监听启动失败时的包装；原生拦截捕获真正失败为 `listen = -1, errno=EPERM`，并有 Sandbox 的 `network-inbound` 拒绝记录。不能继续按端口占用问题修。
2. 独立 Python 原生 `socket()`（默认 AF_INET）绑定 `127.0.0.1` 后也在 `listen` 失败，例如端口 `49165`、`49179`。因此 Bun、PTY 或 IPv4-mapped IPv6 都不能作为唯一根因。
3. Bun 原生记录还包含 `listen local=127.0.0.1:52343` 和 `connect remote=127.0.0.1:53800`、`:53325` 的 EPERM。只放开 inbound 不能解决所有故障。
4. 不同独立 runner 表现不同；有的 2,000 次循环全过，有的失败。不能以重跑转绿、重试换端口或单次绿灯当作修复。
5. Apple XNU 公开代码在实际监听/连接前调用 MAC 策略检查；这只能支持故障层级判断。尚未定位 Seatbelt 内部为何拒绝 localhost，不能把地址元数据、策略缓存或其他宿主策略的假设写成已证实事实。

当前正式策略仍为：

```scheme
(version 1)
(allow default)
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind)
```

当前 `network-probe.ts` 的 Python 原生外网检查仅接受 `ENETUNREACH`、`EHOSTUNREACH`、`EPERM`、`EACCES`。Bun 的 `node:net` 层还接受 `ECONNREFUSED`，因为其错误映射不同，但受前述原生检查独立约束。不要只放宽 errno 来制造绿灯。

## Tradeoff：无效尝试与候选边界

以下尝试已有失败证据，不要无新证据重复：

- 移除 bind 地址过滤，仍有 listen/connect 拒绝。
- 允许全部 inbound、保留 localhost outbound，仍有回环 connect 拒绝。
- 显式 `127.0.0.1:*`，Seatbelt 解析器拒绝此 host 写法，仅接受 `*`/`localhost`。
- `deny network* (with no-log)`、将 `ip` 换成 `tcp`，均未解决。
- 将 deny 缩小到 IP 端点、使用 `require-not localhost`，仍可在 Python 的 bind 阶段失败。

PF 只是未完成验证的候选。运行 `35329973689` 在三台临时 runner 用独立 `com.apple/forge-offline-<pid>` anchor，规则为 `block return out quick on ! lo0 proto { tcp udp } user 501`。每台原生端口扫描和 2,000 次 Bun 回环循环通过，TCP PF 命中计数增加；但原生探针因 `ECONNREFUSED` 提前终止，尚无完整 UDP、子进程和正式门禁证据。

PF 的限制：UDP sendto 成功不代表数据包实际离开；需要捕获/规则计数等相称证据。UID 规则影响该用户全部进程，且该实验只覆盖指定方向及 TCP/UDP。不能直接把此实验当作完整替代，也不能只扩大允许 errno。临时 anchor 清理和 enable reference token 释放是必须验证的后置条件。

“在一次性 CI VM 关闭非 loopback 网卡”仅在思考中出现，没有选型、实现、授权或验证；不要误当既定方案。

上游已核对：Codex `7498521d288b9b3b96ffba4eedf089d8d6e06a84` 的 `codex-rs/sandboxing/src/seatbelt.rs` 使用类似 localhost 条件；sandbox-runtime `e7d967974452273bb8ee26eb2e434e7899e6f9e1` 的 `src/sandbox/macos-sandbox-utils.ts` 讨论 IPv4-mapped IPv6 不匹配。这些不是本例 AF_INET 失败的解释。来源链接见施工与证据文档，源码副本见 evidence。

## 验证证据与文件索引

最近一次完整本地验证，WSL2 Linux `6.18.33.2-microsoft-standard-WSL2` / x64 / Bun 1.3.12：

| 验证 | 结果 |
|---|---|
| `bun run check` | 623 pass / 0 fail；依赖边界及包/automation/测试类型检查通过 |
| contract | 495 tests / 63 files / 17.597s |
| integration | 116 tests / 18 files / 6.444s |
| cli | 12 tests / 9 files / 16.713s |
| `bun run test:headless`、`bun run typecheck:examples` | 先前执行通过；本次交接没有重复运行 |
| 反向验证 | matcher、权限保护、保存屏障、retry、probe 预算、invocation id 绕过均使对应测试变红；恢复后通过 |
| macOS 修复后完整验收 | **未执行，也没有已验证修复** |
| 真实供应商、质量/费用评估、人工验收、Windows/Node | 未运行；目标/额度未授权或不在本期范围 |

此前两个 review 发现并已修复：HTTP 并发请求跨 await 复用同一 fixture 的竞争；续轮请求仅匹配子串导致假绿。相关新增回归已包含在 623 tests 内。旧子 Agent 的运行状态不能跨窗口依赖；新修复需要新的审查。

原始材料在 `/tmp/forge-issue33/`。为新窗口续接，关键材料已复制至仓库本地目录 `.git/task-backups/issue33-handoff-20260918/evidence/`，文件名保持一致；证据不进入 Git 提交。优先读以下文件，避免遍历全部日志：

| 文件名 | 用途 / GitHub run |
|---|---|
| `issue.md` | Issue #33 完整正文快照；当前仍 OPEN，必要时重新读远端 |
| `initial.patch`、`initial-testing-system.md` | operator 原始改动归属 |
| `clean-local-check.log` | 最新 623-pass 完整本地门禁 |
| `three-runners.log` | 最关键：原生 AF_INET listen 和实际回环地址 connect 拒绝；`35326840586` |
| `native-diagnostic3.log` | 原生 listen EPERM；`35323361603` |
| `filter-rules.log` | 原规则/no-log/tcp 均可失败；`35327755090` |
| `endpoints-3192.log` | 缩窄 IP 规则仍失败；`35328690620` |
| `pf-diagnostic.log` | PF 部分成功及证据缺口；`35329973689` |
| `macos-ci.log`、`macos-ci-attempt2.log` | 首次 CI 失败；`35318909475` |
| `stress-profiles.log`、`port-scan.log` | 说明某些 runner 偶然全过，不是确定性修复 |
| `B1-*.log`、`B2-*.log`、`B3-*.log`、`B4-*.log` | 反向验证原日志 |
| `upstream-seatbelt.rs`、`upstream-macos.ts` | 上述固定上游源码；不是 Mac 实测 |
| `bun-server.zig`、`uipc_syscalls.c` 等 | 调用路径调查，Apple 文件未绑定实际故障内核版本 |

历史诊断代码可从本地备份提交只读取出，例如 `git show 9da5163:tests/support/network-diagnostic.py`；不要 checkout 或 cherry-pick 整批旧诊断提交。

当前最小复现材料在 Git 忽略的 `.test-results/macos-isolation/`，另已备份到 `.git/task-backups/issue33-handoff-20260918/reproducer/`：

```sh
python3 .test-results/macos-isolation/reproduce.py --plain --cycles 2000
python3 .test-results/macos-isolation/reproduce.py --profile .test-results/macos-isolation/current.sb --cycles 2000
python3 .test-results/macos-isolation/reproduce.py --profile .test-results/macos-isolation/current.sb --start-port 49152 --cycles 16384
```

该脚本仅用原生 socket；按 bind/listen/connect/accept/exchange 阶段报告实际地址、errno、成功次数。固定端口模式仅跳过真正的 EADDRINUSE，并统计跳过数；非预期错误立即失败，无重试。可加 `--family ipv6`。`--profile` 在非 macOS 拒绝运行，不降级。

已在 Linux 验证新复现器的控制组：普通 IPv4/IPv6 各 2,000 次交换通过；network namespace 内 2,000 次交换通过，IPv4/IPv6 TCP 和 IPv4 UDP 外网尝试均返回原生 errno 101。结果文件为 `linux-control-ipv4.jsonl`、`linux-control-ipv6.jsonl`、`linux-isolated.jsonl`。**这个新复现器尚未在 Mac 跑过，不能把它说成已经建立了新一轮 macOS 红绿循环。**

## Open Questions：唯一可用环境与授权边界

operator 已答复只有 GitHub Actions，没有可提供的 Mac 主机。交接时 `gh api repos/L-1ngg/forge-agent/actions/runners` 返回 `total_count: 0`。不要再问同一个环境问题。

现有 `.github/workflows/ci.yml` 支持无输入 `workflow_dispatch`，调用 `verify.yml` 检出 `github.sha`；没有执行未提交补丁的入口。`prerelease.yml` 是发布流程，不能挪作任意脚本执行入口。不能通过利用输入注入、创建 release 或其他变相远端变更绕开“先不要提交”。

被中断前只提出了如下方案，**尚未获得允许，也尚未创建 workflow 文件、临时分支或提交**：

1. 本地先准备可审查的临时诊断 workflow，在隔离 checkout 中验证。
2. 请求一个明确且有限的例外：仅在临时诊断分支提交/推送一次 bootstrap workflow；不改 `master`。GitHub Actions 运行记录仍会显示，不能承诺删除分支就抹除所有远端记录。
3. 后续每个实验通过手动 dispatch 输入传递压缩的补丁及脚本，在 runner 工作区应用并执行，从而不为每次试验产生提交。最终代码仍留在本地，是否交付提交由 operator 之后决定。
4. 诊断与验收结束后，临时分支的清理也应在明确约定范围内进行。

已确认 `gh workflow run --help` 支持 `--ref` 选择 workflow 版本；远端执行方式尚未验证。可考虑在临时分支改已有 `ci.yml`，避免新 workflow 必须先注册到默认分支的问题，但需实际核实 dispatch 行为。

只做过一次内存中的补丁大小测量：排除三个 operator 文档及 `ci.yml`，其余 tracked diff 加 untracked 实现为 96,110 bytes，gzip+base64 为 41,060 bytes。未落盘 payload；不能据此宣称传输和执行已经可用。准备时需重新生成、核对输入限制、保持 source/patch 哈希证据、以 `git apply --check` 防止基线漂移。不要把明文凭据写入输入或 artifact。

## Next Action

1. 核对工作区和此交接；必要时先读 `three-runners.log` 的 EPERM 片段及已失败策略。保留已有实现与 operator 改动。
2. 先把上节临时诊断环境方案在本地具体化并验证，再就 bootstrap commit/push 的有限例外询问 operator；说明需要询问源于用户最新“先不要提交”要求。当前答复“只有 GitHub Actions”不等于已授权该例外。
3. 环境获准并可运行后，在同一 Mac、同一 Python/内核/地址族下做 plain 与现策略对照；每次只改变一个因素。优先获得能稳定触发故障的最小循环，然后区分假设，避免重演逐次盲改 profile。
4. 实施由证据支持的最小修复。必须同时证明外网被阻止、fixture 回环可用、CLI/工具后代继承限制；不关闭 macOS 门禁、不降级成 fetch mock、不重试隐藏 EPERM。
5. 以原生复现、真实 Bun/PTY/子进程探针、完整 macOS `check`/headless/example types 构成验收；按改动范围复核 Linux。保留失败→修复→通过的证据，解释偶发性的控制方式。
6. 同步施工证据并清理临时诊断代码；在用户另行授权前保持不提交、不推送最终实现、不关闭 Issue。

本次交接仅整理与备份证据，没有进一步修改隔离算法，没有启动新的 Actions 运行，也没有创建新的 Git 提交。
