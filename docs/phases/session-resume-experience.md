---
doc_kind: plan
created: 2026-09-10
---

# 会话恢复：清晰列表与按需预览

> 状态:实现、自动化验证与双轴审查完成(2026-09-10)。用户已通过 implement 授权实施 [GitHub #29](https://github.com/L-1ngg/forge-agent/issues/29)，AC 正文仍在 Issue。起点 master/c5a4291；已有 CONTEXT.md 术语及本稿属于同一任务的设计产物，无其他初始改动或暂存内容。首轮审查发现的验证缺口与文档导航已修复；Standards 与 Spec 复审均无剩余 findings；按授权本地提交，不推送远端。

## Why 与方向确认

用户在 `/resume` 中难以判断应该选哪个会话，并希望改善体验和性能。后续明确 Forge 应保持类似 Pi 的极简定位，确认先用不增加额外模型调用的方式解决问题。

原讨论中的自动生成名称及展开旧会话时自动补名规则被本方向取代；AI recap 继续不纳入。手动命名不纳入本次规格，以免为选择器新增元数据写入与改名流程。

当前普通列表行是时间与首条 user 文本，并不直接显示 ID；诊断可能包含路径。首条文本不能反映后来进展，窄屏整行截断进一步压缩辨认内容。用户实际看到裸 ID 的入口与当前源码差异尚未确认；实施验证须用正式 CLI 复核实际画面。

现有交付见 [会话管理](session-management.md)。本方案不改写其验收或 [项目路线](../plan.md)，不以完整对齐 Codex 或 oh-my-pi 为目标。术语见 [CONTEXT.md](../../CONTEXT.md)。

## Entry Criteria

- 用户已基于 #29 发出 implement 指令，实施入口已满足；复用规格的测试边界。
- 正式 CLI 复核列表、活动任务中浏览、窄屏和标题来源；发现差异先修订设计。
- 用合成会话建立冷打开、重复打开、首次与重复预览的性能基线；基准已执行，结果见下文。

## What：施工行为摘要

### 清晰列表

- 标题沿用默认恢复分支的首条用户文本，合并空白、按显示宽度截断；无文本时使用“无文本会话”等占位，不用裸 ID 作标题。
- 正常尺寸标题优先，简短最近活动时间辅助；窄屏优先保留标题、选择状态与必要按键提示。
- 保留当前项目范围、最近消息活动时间排序和当前会话标识；不改用文件 mtime 作为排序时间。
- ID 与路径仅在展开信息或错误诊断需要时显示。

### 按需原文预览

- ↑/↓ 选择；Ctrl+E 展开或收起当前候选。移动选择不自动展开新候选或读取其预览；一次只展开一个候选。
- 展示默认恢复分支最近最多 6 条有展示内容的 user/assistant 消息，按对话顺序标明角色；使用原文文本，图片只标注存在，不解码图片。不展示工具输出、推理块，不将 compaction 当作用户发言。
- 每条文字最多 500 个 Unicode 字符，超出明确标记省略；预览区域通过 PgUp/PgDn 或鼠标滚轮滚动，完整历史在恢复后查看。这是展示上限，不代表底层文件读取已有固定字节上限。
- 窄终端纵向布局；预览打开时 Esc 先收起，再按 Esc 返回原会话；Enter 始终表示恢复当前候选。
- 浏览与预览不停止当前任务、不修改草稿、不创建 Agent 实例、不触发模型或工具。明确恢复后才沿用现有取消、收尾和实例切换规则。
- 加载失败在候选处显示错误，列表保持可操作；预览可用不代表通过恢复校验，恢复仍走现有严格校验。

### 克制的性能优化

- 打开选择器立即显示加载状态并允许 Esc 返回；扫描完成后展示按既有规则排序的列表。本批不承诺冷打开立即获得最终排序的首批结果。
- CLI 宿主缓存轻量列表结果，以规范化路径、size、mtime 为失效依据；重新打开检查新增、删除与修改，未变化文件跳过重复完整解析。
- 预览只在展开时请求；本次选择器内缓存少量摘录，上限 20 个候选，不缓存整份会话。文件变化后重新请求时失效更新。
- 快速切换、退出和重新打开时，用请求归属丢弃过时结果，不能重新打开已关闭的选择器或将 A 的内容显示给 B。
- 冷扫描与缓存失效先复用正确的分支加载路径，不把物理文件尾部直接当作活动分支。分支、损坏记录和摘要边界的正确性优先。
- 本批收益主要是重复打开与重复预览；超大文件冷加载仍可能昂贵。若基准证实明显阻塞，再单独评估有界读取或隔离解析，不默默扩大为数据库、后台索引或格式改造。

## Batches 与实现边界

1. **可辨认、可预览的恢复流程**：CLI 宿主只读预览接口、TUI 选择器和 App 事件，覆盖加载、失败、退出、窄屏及正式恢复；复用 SessionStore 保持分支语义。
2. **重复浏览成本优化**：增加宿主轻量缓存、预览缓存和失效处理，以基准与回归确认收益。

主要路径：`packages/cli/src/session-host.ts`（必要时拆出 CLI 内部只读发现辅助文件）、`packages/tui/src/session-menu.ts`、`packages/tui/src/app.ts` 及对应测试。不改变 runtime、SDK 公共接口、SessionStorage 契约或 v4 JSONL 格式。

## Acceptance Criteria

AC-1 至 AC-7 的唯一正文维护在 [GitHub #29 的 Testing Decisions](https://github.com/L-1ngg/forge-agent/issues/29)。本稿按 AC 编号引用，后续在此记录跨批次验证证据，不复制任务级验收清单。

## Test plan

- 沿用 CLI SessionHost + App 公共输入输出集成接缝，覆盖调用/写入零新增、归属、失效与分支准确性。
- 扩展 `tests/tui-integration/session-management.test.ts` 的正式 CLI + Bun.Terminal 路径；PTY 与真实 provider 验证分开报告。
- 建议以 100 个小会话和少量 10 MiB 级合成长会话测基线与缓存收益，不读取用户私有对话作为基准，不推广为所有规模保证。
- 临时破坏请求归属或缓存失效，确认对应回归失败，再恢复并完成必要检查。
- 同步中英文使用说明及快捷键，完成 SOP 要求的检查；自动化通过不等同人工验收。

## 实施与验证记录（2026-09-10）

两批实现均已完成。标题来自首条 user 文本；CLI 提供只读预览，TUI 显式请求并保留最多 20 份摘录。列表缓存检测路径、设备/inode、size 与 mtime；读取前后版本不一致的结果不作为有效缓存复用。

- Ran：`bun run check`（依赖边界、workspace 与自动化类型检查、全量测试）；全部通过，503 pass / 0 fail，71 个测试文件。
- Ran：`bun run test:headless`、`bun run typecheck:examples` 均通过。
- Ran：正式 CLI + Bun.Terminal 在本地 provider 回放下覆盖 40×16 窄屏、活动任务中只读预览、加载中 Esc 返回、预览滚动端点及恢复；Host/App 回归覆盖分支、图片占位、截断、错误、过时请求、缓存上限与退出释放。
- Ran：读取期间追加消息，下一次预览能读取新消息；临时移除缓存版本校验后，两项回归按预期失败，恢复代码后通过。反向验证未保留缺陷代码。
- 审查修复：补充 PTY 滚动可见内容和加载中退出断言、读取中变化的竞态回归，并在 docs/README.md 加入设计入口。
- Not run：真实远端 provider、macOS/Windows 与人工交互验收；本次使用 Linux 本地回放和真实 PTY。自动化结果不替代这些环境的验收。
- Risk：冷加载仍完整解析会话；保留文件版本元数据的外部修改不保证被缓存检测。浏览优化未改变恢复时的校验。

性能复现：`bun scripts/session-resume-benchmark.ts`，使用 100 个小会话与 2 个 10 MiB 合成会话，不读取用户历史。以下为本机单次结果，不能推广为任意规模或跨平台延迟保证。

| 操作 | 耗时 | JSONL 完整读取次数 |
|---|---:|---:|
| 冷列表 | 124.82 ms | 102 |
| 重复列表 | 10.44 ms | 0 |
| 首次大文件预览 | 22.68 ms | 1 |
| 重复大文件预览 | 0.14 ms | 0 |

## Release / Rollback

- 用户已授权实现 #29；完成检查和双轴审查后按 implement 提交本任务，不自动推送或发布版本。
- 出口为上述 AC、必要检查与可审查交互证据；不以 AI 命名、手动改名、recap、全文搜索或任意规模固定延迟为出口。
- 两批可独立回退；缓存是进程内派生数据，回退代码不修改或删除会话文件。

## Key Decisions / Dependencies

- [ADR-008](../decisions/008-general-agent-positioning.md) 与 [ADR-015](../decisions/015-pi-core-source-migration.md) 的通用定位及内核/会话策略分离继续适用；本轮为 CLI/TUI 体验优化。
- [ADR-010](../decisions/010-input-ownership-and-interruption.md)、[ADR-013](../decisions/013-incremental-session-persistence.md)、[ADR-014](../decisions/014-pi-aligned-context-management.md) 的输入、保存、旧数据保护和未知副作用规则继续适用。
- 无持久格式或难回退架构变更，本轮不新增 ADR；若实施核查显示必须突破边界，先回到设计讨论。

## Risk

- 开头文本可能宽泛，原文预览改善辨认但不自动概括主题；手动命名留待需要再评估。
- size/mtime 缓存不保证检测保留元数据的外部篡改；恢复仍重读和校验文件。
- 冷加载继续受会话数量和文件大小影响，本批无固定 I/O 上界。

## 参考证据

- Forge：`packages/cli/src/session-host.ts`、`packages/tui/src/session-menu.ts`、`packages/tui/src/app.ts`、`packages/core/src/session-storage.ts`；历史验收见 [会话管理](session-management.md)。
- Codex 固定源码 `5d3fe48b08049165ef8143dca152869c1f18059c`：[列表与预览](https://github.com/openai/codex/blob/5d3fe48b08049165ef8143dca152869c1f18059c/codex-rs/tui/src/resume_picker.rs)、[预览读取](https://github.com/openai/codex/blob/5d3fe48b08049165ef8143dca152869c1f18059c/codex-rs/tui/src/resume_picker_transcript_preview.rs)。借鉴按需浏览，不照搬标题模型或自动 recap。
