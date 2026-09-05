---
doc_kind: plan
created: 2026-09-06
---

# GitHub 交付施工图

> 状态:已完成(2026-09-06)。代码、双平台 CI、GitHub 设置与源码草稿预发布已验证;草稿尚未公开发布。设计见 [ADR-011](../decisions/011-forge-agent-github-delivery.md)。

## Entry 与 Batches

基线 `bb52563` 已推送到公开仓库 `L-1ngg/forge-agent`,首次 Ubuntu CI 通过。operator 已确认英文入口、MIT、直接推送、双平台 CI、全仓更名与本机迁移,并授权实施、分批提交和推送。

1. 名称、依赖与配置迁移;本机运行数据不进入 Git。
2. 英文/中文 README、英文 SDK 指南、贡献入口与许可证。
3. 可复用验证 workflow、手动草稿预发布、GitHub 设置与远程验收。

## Acceptance Criteria

- [x] AC-GH-01:运行接口统一新命名,完整检查与依赖反向测试通过。
- [x] AC-GH-02:本机配置和会话迁移前后内容一致,可加载且仍被 Git 忽略。
- [x] AC-GH-03:双语入口和 SDK 示例可用,本地文档链接有效,MIT 与项目状态准确。
- [x] AC-GH-04:交付代码 `898edb2` 在 Ubuntu/macOS 上完整通过,不跳过 PTY 或注入模型密钥。
- [x] AC-GH-05:非法版本、非主分支目标、重复版本和验证失败不能产生 Release。
- [x] AC-GH-06:产生绑定已验证 SHA 的 `v0.1.0-alpha.1` 草稿;归档校验、独立安装与 headless 烟测通过,不含本机运行数据。

## Release 与 Rollback

每批检查后独立提交并推送 `master`。Release 保持 draft 和 prerelease,公开发布由 operator 决定。失败保留诊断,不覆盖标签或已有产物。回退使用对应提交的 revert;如回退命名,本机运行目录同步恢复,不更改会话内容。操作与失败处理见 [release.md](../release.md)。

## Evidence

### 第一批

- Ran:`bun install --frozen-lockfile`、`bun run check`(292 pass / 0 fail)、`bun run test:headless`、新 CLI `--help` 与 `git diff --check` 通过。新增 XDG 配置与旧名称退出、改名依赖反向用例;HTTP 启动测试验证默认会话路径。
- Ran:本机两个运行文件迁移前后 SHA-256 相同,新配置可加载、31 条历史记录可读;`git check-ignore` 确认运行文件未纳入版本控制。
- Not run:本批未运行 macOS 或真实模型请求。
- Why:远程双平台验证在第三批完成;改名不需要付费模型调用。
- Risk:不保留旧接口别名。旧阶段人工验收豁免保持不变。

### 第二批

- Ran:第一批提交 `36107fb` 的 GitHub CI 通过;本地 `bun run typecheck:examples` 通过,两份 README 的 TypeScript 示例与实际 quickstart 文件一致。40 份 Markdown 的 279 个本地链接路径有效,章节锚点已核对;Issue forms YAML 解析通过,`git diff --check` 通过。
- Not run:英文示例未调用真实模型,外部文档链接未逐一联网验证。
- Why:使用现有本地 SDK HTTP 回归验证执行契约,示例另做严格类型检查;本批是对外文档与许可交付。
- Risk:公开 SDK 仍为私有 workspace 包,没有 npm 或稳定接口承诺。

### 第三批本地验证

- Ran:`bun install --frozen-lockfile`、`bun run check`(297 pass / 0 fail)、`bun run typecheck:examples` 与 `actionlint 1.7.12` 通过。发布策略测试覆盖输入、真实 Git 分支归属、已有标签/草稿、分页和 API 失败,以及发布任务依赖双平台验证的关系。
- Ran:GitHub 保留 Issues、关闭 Wiki/Projects、设置项目 topics;默认 token 权限仍为只读。
- Not run:远程双平台与草稿归档验证待本批提交后执行。
- Why:GitHub 必须先加载已推送 workflow 才能执行远程验证。
- Risk:手动发布是源码草稿,不发布 npm、二进制或稳定 API。

### 双平台差异修复

- 首次远程 `601ad6c` 的 Ubuntu 通过,macOS 295 pass / 2 fail([run 33983065360](https://github.com/L-1ngg/forge-agent/actions/runs/33983065360)):shell 返回 `/private/var` 真实路径,PTY 测试的原生信号采样期间出现 Bun 1.3.12 bus error。
- 对应处理:工作目录断言比较 `realpath`;测试 frame 采样改为 IPC 请求/确认,保留真实 PTY、resize 信号、粘贴、权限和 Ctrl+C 的全部出口断言。运行代码不变,`898edb2` 已通过远程重新验证。
- 非法版本的远程反向验证已拒绝输入,verify/publish 均 skipped([run 33983090631](https://github.com/L-1ngg/forge-agent/actions/runs/33983090631)),未创建 Release。

### 远程交付证据

| 场景 | 证据与结果 |
|---|---|
| 最终代码双平台 CI | [`898edb2` / run 33983247952](https://github.com/L-1ngg/forge-agent/actions/runs/33983247952):Ubuntu 24.04 与 macOS 14 各 297 pass / 0 fail,完整 PTY、headless 与示例类型检查通过 |
| 目标归属反向验证 | [run 33983142014](https://github.com/L-1ngg/forge-agent/actions/runs/33983142014):不存在于 master 历史的 SHA 被拒绝,后续任务 skipped;本地真实 Git fixture 同时验证了存在但未合入 master 的提交 |
| 测试失败反向验证 | [run 33983247817](https://github.com/L-1ngg/forge-agent/actions/runs/33983247817):选择已知失败的旧提交 `601ad6c`,validate 成功但 macOS 测试失败,publish skipped,未产生 `v0.0.0-alpha.999` |
| 正常草稿预发布 | [run 33983342513](https://github.com/L-1ngg/forge-agent/actions/runs/33983342513):重新验证双平台后创建 `v0.1.0-alpha.1`,Release ID `383332094`,draft/prerelease 均为 true,target 为 `898edb278a105154e79ccc8717b1dc186c8481b0` |
| 重复草稿反向验证 | [run 33983437472](https://github.com/L-1ngg/forge-agent/actions/runs/33983437472):写入前重查发现已有草稿并拒绝,原 Release 和两个 asset ID/digest 保持不变 |

- Ran:下载的源码归档 SHA-256 为 `e0f347a0732d2fe0308cc5a2f0eec540a609212e67ac3e55bc11518541501360`,与 SHA256SUMS 及 GitHub asset digest 一致。`git get-tar-commit-id` 返回目标 SHA,206 个文件与该提交 tracked tree 完全相符,无本机运行数据。独立解压后 frozen install 与 headless 烟测通过。
- Ran:GitHub 已识别 MIT,Issues 保留、Wiki/Projects 关闭、topics 已设置;工作流只在发布任务获得写权限。
- Not run:没有公开发布草稿、npm/二进制分发、付费模型请求、原生 Windows 或完整人工终端验收。
- Why:本轮交付范围为开发者入口、命名与源码预发布;历史人工豁免不因此变为通过。
- Risk:GitHub 的只读 workflow token 可能看不到未发布草稿,因此重复草稿会在发布任务获得写权限后的第二次检查被拒绝。资产上传途中失败仍可能留下不完整草稿,需人工核对;本流程不覆盖或自动清理它。

上述源码快照固定在 `898edb2`;本节及路线图的验收记录提交在其后,不回写或替换已验证归档。
