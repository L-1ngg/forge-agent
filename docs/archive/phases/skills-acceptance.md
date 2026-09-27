---
doc_kind: acceptance
created: 2026-09-19
---

# Skills 首轮接入证据

> 状态:已归档(2026-09-28；历史状态:Issue #35 首轮实现于 2026-09-19 交付 `7a8fbff`)。Pi scanner/loader 与相关测试已被 [Issue #37](../../phases/tool-ecosystem-issue-37.md) 替换。下文保留旧版本证据，不证明新官方 Skills 接入；模型质量当时未验收。

起点 `1d37dc1d08d79a94c11036257d2bdb09e0e3fd4a`。开始时暂存区为空，`docs/plan.md` 已修改，`docs/phases/skills.md` 与两份 Skills 研究文档未跟踪；这些初始内容不纳入本次实现提交。

## 验收路径

| 范围 | 证据 | 对应 AC |
|---|---|---|
| 固定来源、许可与严格适配 | `packages/core/src/skills/upstream.json`、`LICENSE`、`LOCAL_CHANGES.md`；上游 fixtures 与派生测试 | AC-1 |
| 三层发现、标准字段、目录终止、忽略和 symlink | `packages/core/test/sdk-skills.test.ts` 的真实目录与别名场景；SDK 未配置/显式禁用；来源失败保旧 | AC-2–5 |
| 自动工具与显式输入 | 严格 HTTP/SSE fixture 核对真实 system/messages/tools；首次只含 metadata，加载后完整 body/来源/修订进入实际请求与历史；权限、hooks、rewrites、同名冲突、50 KiB ASCII/多字节及 CRLF 分块 | AC-6–9 |
| 配置与实例生命周期 | 工具批次/显式权限准备的受控屏障；accepted/applied/canceled；失败保旧；steer/followUp 的 processed 与取消 | AC-8、AC-10、AC-13 |
| 预算、压缩与恢复 | 大 catalog 在关闭压缩时零模型请求；压缩保留原始证据并再次激活；两实例并发、真实 JSONL 重开与版本变化、脚本哨兵不存在 | AC-11–13 |
| CLI/TUI | `packages/cli/test/skills.test.ts` 正式 headless JSON；`tests/tui-integration/skills.test.ts` 正式 CLI PTY；`session-ui.test.ts` 权限拒绝返还原文及切会话/恢复草稿 | AC-8、AC-14 |
| 反向验证 | 临时颠倒 catalog 层级，SDK 来源/有效项断言变红（exit 1），恢复后相同测试通过（exit 0） | AC-15 |

输入归属和运行时配置旧回归一起执行：`input-ownership.test.ts`、`runtime-configuration.test.ts` 通过。普通文本的 API 与确认语义不变；Skill 输入在异步准备、保存成功后结算 processed。runtime 仅增加可选输入准备接缝，来源版本不变，本地差异已补录。

## 最终门禁与审查

环境：Linux x64、Bun 1.3.12；正式离线入口使用 `network-namespace`，网络探针通过。

| 检查 | 最终结果 |
|---|---|
| `bun run check` | exit 0；依赖边界、工作区/automation/tests 类型检查全部通过 |
| contract | 537 pass / 0 fail，65 个测试文件 |
| integration | 155 pass / 0 fail，19 个测试文件 |
| cli（正式 PTY） | 13 pass / 0 fail，10 个测试文件 |
| `bun run typecheck:examples` | exit 0 |
| `git diff --check` | exit 0 |
| Standards / Spec | 最终复查各 0 项未解决发现；覆盖本次 65 个文件，排除初始用户改动 |

全量共 705 项通过；SDK Skills 的 36 项与上游派生的 15 项已包含在上述分组中，不额外累加。原始分组日志、JUnit 与隔离证据由现有入口写入 `.test-results/`。

首次 Spec 审查发现的两项问题已修复并补回归：frontmatter 必须以完整 `---` 行结束，避免扩展键吞掉 explicit-only 元数据；已发现的入口变成无效 YAML/缺少 frontmatter 时，加载返回 `changed` 并提示刷新。最终门禁还暴露了两项接线问题：离线子进程 HOME 未隔离，以及 `/new` 准备期间过早显示可输入提示。现已隔离子进程 HOME，并在会话切换期间显示等待提示；相关回归与完整门禁通过。反向验证及切换提示回归均观察到修复前失败、恢复或修复后通过。

## 交付边界

- Ran：目标 SDK/上游模块/CLI/headless/PTY/UI 测试、反向验证、完整 `bun run check`、示例类型检查与双轴审查，结果见上表。
- Not run：本轮 macOS、真实供应商 Skill 自动选用与指令遵循探针、人工长期使用、原生 Windows/Node.js。
- Why：本机为 Linux，确定性软件验证使用受控本地 provider；模型质量独立于软件合同，不用 fixture 结果替代质量结论。沿用 Linux OS 断网、macOS fixture 兼容性边界，不扩大隔离方案。
- Risk：真实模型能否正确选用和遵循 Skills 仍未测；目录/body 使用现有上下文估算而非供应商精确 tokenizer。符号链接允许访问显式来源包含的外部目标。CLI 保留现有只读工具 built-in allow（含 `deny-all` 模式）；SDK 不自动授予加载权限，前置 hooks/deny rules 仍优先。

关闭路径：CLI `--no-skills`/配置 `skills.enabled: false`；SDK `updateConfiguration({ skills: false })`。关闭不删除源文件和已保存证据。源码回退按 CLI/TUI → session/SDK → Skills 模块/依赖逆序处理。
