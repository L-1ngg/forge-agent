---
doc_kind: review-request
created: 2026-09-18
---

# Issue #33：临时 macOS 诊断入口

> 状态:已按 operator 确认的简化范围完成验收：Linux 强制断网、macOS 完整 fixture 兼容性。临时远端分支已删除，operator 后续已授权正式提交并推送，Issue #33 保持 OPEN（2026-09-18）。

承接 [任务交接](2026-09-18-issue33-macos-isolation-review-request.md)。用户本轮要求为「请你读取文件内容，然后完成任务交接，执行他未完成的任务」。operator 最初对下文有限远端操作答复「可以」，当时例外仅覆盖临时诊断入口；验收完成后又明确授权「可以，你可以提交并push了」。下文的暂缓提交要求属于当时历史，当前以该后续授权为准。

operator 后续表示「你搞的太复杂了，不需要那么复杂的方案」，并确认收窄平台要求。PF 接入已撤回，停止 PF/Seatbelt 内部根因与系统 DNS 调查；当前结论和完整验收证据见[施工记录](../docs/phases/testing-system-implementation.md#验证记录)。下文保留临时入口的设计与执行历史，不恢复已经取消的 macOS 强制断网要求。

## 可审查内容

所有临时执行材料保存在本地 Git 内部目录 `.git/task-backups/issue33-actions-bootstrap-20260918/`，不混入 Issue #33 产品改动：

| 文件 | 用途 |
|---|---|
| `ci.yml` / `bootstrap.patch` | 临时分支唯一的提交内容：替换现有 `.github/workflows/ci.yml` |
| `pack.py` | 从固定基线生成未提交实现补丁与源文件哈希，不改变 Git 状态 |
| `dispatch.json` | 第一轮原生 socket 对照实验的完整 dispatch 请求 |
| `workspace.patch` / `manifest.json` | 人可读实现补丁及 26 个源文件的 SHA-256 |
| `run.sh` | 第一轮实验；沿用交接的原生复现器与原策略，未修改隔离机制 |
| `transport-validation.json` | 成功还原与四类失败拒绝的本地验证结果 |
| `linux-transport-*.log` / `linux-transport-validation.json` | 隔离 checkout 从 payload 还原后的 Linux 门禁证据 |

workflow 固定检出 `3892705a585e50d49a1bb46bedf1ade108aae0eb`，Bun 固定为 1.3.12；只有 `workflow_dispatch` 触发器，token 为 `contents: read`，checkout 不保留凭据。每轮使用三台独立 `macos-14` runner，每台最多 20 分钟。补丁与实验通过压缩输入传送，后续实验无需新提交。执行前核验 payload SHA-256、基线 SHA、`git apply --check` 和源文件 SHA-256，失败即停止。

仅临时分支的 workflow 改变；runner 检出的是固定基线，因此正式 CI 配置断言仍针对正式文件。基线校验失败时不得擅自改检出目标。输入不含凭据；输入、源码补丁和日志属于可公开代码材料。每次运行保存 source/patch/实验/输出，artifact 保留 7 天，关键结果应及时下载到本地证据目录。

## 第一轮实验与判据（历史）

同一 runner、同一 Python、同一地址族下比较 plain 与现 Seatbelt 策略：IPv4/IPv6 各执行 2,000 次临时端口交换和 16,384 个固定端口扫描。固定端口只跳过真正的 `EADDRINUSE`，记录跳过数量；每个案例遇到首个非预期错误即失败，失败案例不会重试。其余独立案例继续收集证据，任一失败使该 job 失败。

记录 OS/内核/Python/Bun/端口范围、socket 失败阶段与实际地址，收集相称的 Sandbox 拒绝日志。三台机器用于观察宿主差异，不能把其中一台或一次绿灯写成修复通过。此轮只建立新复现器的 macOS 对照，不包含 PF 替换或改变网卡状态。

第一轮之后曾继续 Seatbelt 对照与 PF 原型；operator 后续终止该方向。最终验收调整为 Linux 保留网络边界探针、macOS 运行完整 `check`、headless 与示例类型检查，并明确报告未启用系统网络隔离。

## 本地检查

- 接续时核验交接 manifest 的 385 个文件，全部一致；暂存区为空，本地与远端 `master` 均为指定基线，Issue #33 仍 OPEN。
- actionlint 1.7.12 校验 workflow 通过；bootstrap patch 的 `git apply --check` 通过，改动范围只有 `.github/workflows/ci.yml`。
- 第一轮 dispatch 的输入 JSON 为 35,012 字符，低于 GitHub 文档上限 65,535；payload SHA-256 为 `f0c5f93f73d7353a1468fc8b7d60714251cb67e6c4302cee9e2b37fa960ccc28`。
- 在隔离 checkout 执行从 workflow 提取的实际还原代码，26 个源文件与当前工作区逐字节一致。错误 payload 哈希、错误基线、补丁冲突、错误源文件哈希四个变异均退出 1。
- 在同样从 payload 还原的独立 checkout 执行 `bun install --frozen-lockfile`、`bun run check`、`bun run test:headless`、`bun run typecheck:examples`，全部退出 0；check 为 623 pass / 0 fail（495 contract、116 integration、12 CLI），分别耗时 18.161s / 6.663s / 17.075s。网络探针验证 100 次 PTY/回环生命周期与原生、Bun/CLI/Bash 子进程越界拒绝。此证据为 WSL Linux / x64 / Bun 1.3.12，不代表 macOS 已通过。
- 上述为 bootstrap 前的本地检查；授权后的真实 dispatch 和最终 macOS 验收已完成，见远端执行记录。

GitHub 官方资料：[workflow_dispatch 与输入上限](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs)、[dispatch API 的 ref 参数](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。已在线核对现有 `ci.yml` 在默认分支注册且 active，workflow ID 为 `351057367`；使用该路径和临时分支输入的 dispatch 已实测成功。

## 已授权的有限远端操作

1. 从固定基线在隔离 checkout 创建 `diagnostic/issue33-macos-20260918`，仅将上述 bootstrap workflow commit/push 一次，不改 `master`。
2. 使用该入口执行本任务所需的诊断与验收；每轮通过输入传送实验和实现补丁，不反复提交实验代码。
3. 诊断与验收结束后删除这个临时远端分支；保留 Actions 运行记录与本地证据。删除分支不会抹除 Actions 记录。
4. 最终修复保留在本地工作区，继续不提交、不推送、不关闭 Issue，等待用户另行指示。

询问例外的原因仅是用户已明确「先不要提交」且可用 Mac 仅为 GitHub Actions；不是技能或惯例额外要求审批。

## 远端执行记录

- bootstrap 提交 `bd9919d091a91412b8e943150a14da91817e65b2` 只修改临时分支的 `.github/workflows/ci.yml`；推送后核对远端临时分支 SHA 相同，远端 `master` 仍为原基线。
- 第一轮 [35342057594](https://github.com/L-1ngg/forge-agent/actions/runs/35342057594) 为 `native-baseline-01`，已结束；完整交换扫描在普通运行也耗尽临时端口，不能作为 Seatbelt 故障证据。后续原生扫描及已取消的 PF 实验结论见施工记录。
- 最终 [35346406650](https://github.com/L-1ngg/forge-agent/actions/runs/35346406650) 为 `fixtures-platform-09`：三台 macOS 14.8.9 / arm64 / Bun 1.3.12 均通过 623 tests、headless、示例类型检查，以及 macOS `test:network` 明确拒绝和隔离模式报告检查。Linux 对应完整门禁同样通过。
- 最终 payload SHA-256 为 `683bf61db37c6376cc31162323d96a14de02db3dc8e4a268c6562048e8ffdc24`；三台下载的源文件 manifest、补丁与当前工作区 26 个实现文件一致。日志、artifacts 和校验汇总保存在 `experiments/fixtures-platform-09/`。
- 结束时核验临时远端分支仍指向唯一 bootstrap 提交后删除；远端 `master` 与本地 HEAD 仍为 `3892705a585e50d49a1bb46bedf1ade108aae0eb`，暂存区为空。临时 bootstrap checkout 已删除，复现器移入本地证据备份；Actions 记录和必要证据保留。最终实现未提交、未推送。
- Issue #33 的 Decision 9 / AC-2 已同步新平台边界，正文与本地准备版本一致，仍为 OPEN。简化版本 Standards / Spec 两轴审查均为 0 项发现；审查范围与哈希见 `simplified-review/manifest.json`。
