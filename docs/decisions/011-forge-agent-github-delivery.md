---
doc_kind: decision
created: 2026-09-06
---

# ADR-011: Forge Agent 命名与 GitHub 交付

> 状态:已批准(2026-09-06,operator 确认方案并要求实施)。施工与验证见 [GitHub 交付施工图](../phases/github-delivery.md)。本文取代 ADR-008 后果中的不更名约定。

## 决策

1. 对外名称为 Forge Agent,仓库与 CLI 为 `forge-agent`,workspace 包为 `@forge-agent/*`,环境变量为 `FORGE_AGENT_*`,项目目录为 `.forge-agent/`,全局配置目录为 `$XDG_CONFIG_HOME/forge-agent/`(默认 `~/.config/forge-agent/`)。旧名称直接退出运行接口,本机数据一并迁移;没有其他用户,不设置兼容期或迁移指南。本地 checkout 的物理路径保持不变。
2. 默认 README 与 SDK 接入指南使用英文,同时保留中文入口;内部规划、ADR 与 SOP 继续中文。README 的路线摘要指向 `docs/plan.md`,不另建任务状态真相源。
3. 采用 MIT 许可证,版权主体为 `2026 L1ngg`。项目仍处于个人开发中,无稳定接口或维护时效承诺。
4. 日常直接推送 `master`,不强制 PR 或他人审批。CI 在 Ubuntu 24.04 与 macOS 14 上运行 Bun 1.3.12 的完整自动化验证,不使用真实模型凭据。
5. 手动预发布必须绑定主分支历史中的完整 commit SHA,两平台验证通过后才创建源码归档、SHA-256 校验文件和草稿 prerelease。标签格式为 `vX.Y.Z-alpha.N`;不覆盖既有版本,不自动公开草稿。包保持 private,不发布 npm 或二进制。
6. 默认 workflow 只有读取权限,只有草稿发布任务获得写入权限。Actions 固定 commit SHA,不允许工作流输入直接成为 shell 代码。

## 取舍

- 全面更名需要更新宿主 imports 与本机配置位置,但当前没有外部兼容负担,不维持两套名称。
- 直接推送的 CI 是事后反馈,不是阻止坏提交进入主分支的门禁;预发布单独重新验证目标提交。
- 双平台 CI 增加运行成本,用于验证真实 PTY 和路径差异,不因此承诺原生 Windows 支持。
- 源码预发布不等于可安装发行版,也不替代真实模型与人工终端验收。

## 后果

历史提交、固定研究快照和过去的验证记录保留原有名称与证据。现役接口、示例与文档统一到新命名;不改变配置字段、会话 v3 格式和输入生命周期。
