---
doc_kind: plan
created: 2026-09-06
---

# GitHub 交付施工图

> 状态:实现中(2026-09-06)。设计见 [ADR-011](../decisions/011-forge-agent-github-delivery.md)。

## Entry 与 Batches

基线 `bb52563` 已推送到公开仓库 `L-1ngg/forge-agent`,首次 Ubuntu CI 通过。operator 已确认英文入口、MIT、直接推送、双平台 CI、全仓更名与本机迁移,并授权实施、分批提交和推送。

1. 名称、依赖与配置迁移;本机运行数据不进入 Git。
2. 英文/中文 README、英文 SDK 指南、贡献入口与许可证。
3. 可复用验证 workflow、手动草稿预发布、GitHub 设置与远程验收。

## Acceptance Criteria

- [x] AC-GH-01:运行接口统一新命名,完整检查与依赖反向测试通过。
- [x] AC-GH-02:本机配置和会话迁移前后内容一致,可加载且仍被 Git 忽略。
- [ ] AC-GH-03:双语入口和 SDK 示例可用,本地文档链接有效,MIT 与项目状态准确。
- [ ] AC-GH-04:最终提交在 Ubuntu/macOS 上完整通过,不跳过 PTY 或注入模型密钥。
- [ ] AC-GH-05:非法版本、非主分支目标、重复版本和验证失败不能产生 Release。
- [ ] AC-GH-06:产生绑定已验证 SHA 的 `v0.1.0-alpha.1` 草稿;归档校验、独立安装与 headless 烟测通过,不含本机运行数据。

## Release 与 Rollback

每批检查后独立提交并推送 `master`。Release 保持 draft 和 prerelease,公开发布由 operator 决定。失败保留诊断,不覆盖标签或已有产物。回退使用对应提交的 revert;如回退命名,本机运行目录同步恢复,不更改会话内容。第三批补充手动发布操作指南。

## Evidence

### 第一批

- Ran:`bun install --frozen-lockfile`、`bun run check`(292 pass / 0 fail)、`bun run test:headless`、新 CLI `--help` 与 `git diff --check` 通过。新增 XDG 配置与旧名称退出、改名依赖反向用例;HTTP 启动测试验证默认会话路径。
- Ran:本机两个运行文件迁移前后 SHA-256 相同,新配置可加载、31 条历史记录可读;`git check-ignore` 确认运行文件未纳入版本控制。
- Not run:本批未运行 macOS 或真实模型请求。
- Why:远程双平台验证在第三批完成;改名不需要付费模型调用。
- Risk:不保留旧接口别名。旧阶段人工验收豁免保持不变。
