---
doc_kind: plan
created: 2026-09-12
---

# 主界面工具浏览 module 深化

> 状态:已完成本地实现与自动化验收(2026-09-12)。operator 已确认集中内部职责，保持现有操作和显示行为，并要求提交本地 commit；未推送，未新增人工体验验收。

## Why / Entry

架构体检发现 `App` 的输入、鼠标、快捷键提示和绘制分别了解工具调用分组、选中项重定位及滚动锚点顺序；`transcriptMetrics` 和绘制重复生成行布局。现有交互合同继续以[主界面工作流](tui-main-workflow.md)、[Markdown 渲染](markdown-rendering.md)为准，术语沿用根目录 `CONTEXT.md`。

本轮已确认：分组、就地展开、选中对象、阅读位置与显示布局归入一个浏览 module；`App` 保留执行、草稿、权限请求、整屏焦点、详情视图和复制宿主。原有未提交文档不覆盖。无需修改 ADR-005/010/016 或增加依赖。

## Design / Batches

1. 新增 TUI 内部 `transcript/browser.ts` 的 `TranscriptBrowser`，持有选中对象、分组展开状态和 `ScrollState`。沿用 `TranscriptProjector` 的事件归约和条目显示状态，不复制第二份历史。
2. 显式更新浏览布局时统一生成展示条目和行位置，并在 module 内完成选中项重定位与锚点捕获/恢复。绘制与命中使用同一布局；读取选择能力和绘制本身不再推进浏览状态。
3. 浏览 interface 表达进入浏览、移动选择、滚动、折叠、选择详情目标、鼠标选择和重置；调用者不接触 `group:`、展开 ID 集合、滚动 offset 或 anchor 顺序。已有 groups/scroll 保留为内部 implementation，不引入通用 controller 或额外 adapter。
4. `App` 提供当前可用宽高并转交浏览动作，继续决定焦点归属及是否打开详情/启动文本拖选。浏览 module 绘制原有选中背景和分组边框，使用既有 `TerminalFrame` compositor。

tradeoff：本轮统一布局的生成与消费，不引入 revision 缓存或性能承诺。测试跨同一浏览 interface 验证连续操作，关键 App、cell golden 和真实 PTY 集成检查保留。

## Acceptance / Verify

- [x] AC-BROWSE-1：`App` 不再直接维护分组身份、展开集合、重复行布局和锚点时序。
- [x] AC-BROWSE-2：分组/成员选择、默认 read 预览与明确展开、鼠标双击、详情目标保持现有行为。
- [x] AC-BROWSE-3：新调用加入、就地展开、反复 resize 与手动滚动后，选中目标和阅读位置正确；清屏/切换会话重置浏览状态。
- [x] AC-BROWSE-4：浏览 interface 测试与既有 App/scroll、cell golden、PTY 工作流回归通过；至少一次临时注入缺陷让对应浏览测试失败。
- [x] AC-BROWSE-5：`bun run check` 与 `git diff --check` 通过；报告未验证范围。

## Release / Rollback

本轮交付本地可审查改动与证据；不发布远端、不改变用户会话数据。实现与接线作为同一可回退批次；若回退，应一并恢复 App 中原有浏览实现及对应测试，不回退 operator 其他改动。没有数据迁移或新配置开关。

## Risk / Learn

最高风险是把绘制时推进的锚点改为显式布局更新后改变导航时序；使用现有 reflow/streaming 回归和浏览连续动作测试约束。原文复制仍依赖已有 source 元数据，布局集中不得丢弃它。真实供应商兼容与外层终端人工体验不由本轮本地测试证明。仅在发现可复发的新故障后另记教训。

## 验证证据

- Ran：修改前 `bun test packages/tui/test/app.test.ts packages/tui/test/scroll.test.ts tests/tui-integration/main-workflow.test.ts` 为 63 pass / 0 fail；首次接线后同一批 63 pass / 0 fail。
- Ran：新增 `packages/tui/test/transcript-browser.test.ts` 的 5 个连续行为场景覆盖组/成员选择、新调用加入、read 预览/完整展开、双击与拖选、反复 resize、隐藏后恢复、绘制无状态推进和会话重置。早期发现“连续导航未重绘即加入内容”缺少可用锚点，修复后 5 pass / 0 fail。
- Ran：临时省略 `TranscriptBrowser.update` 中的 `restoreAnchor`，定向阅读位置测试为 0 pass / 1 fail（预期 `ROW_031`，实际 `ROW_061`）；恢复后纳入完整检查，未保留注入缺陷。
- Ran：最终 `bun run check` 成功，依赖门禁、五包 typecheck、automation typecheck 通过；508 pass / 0 fail，72 个测试文件，11451 次断言。包括既有 cell golden、真实 SDK/PTY 工具浏览/详情/搜索/复制/resize、真实 CLI 会话切换及输入归属回归。`git diff --check` 通过。
- Ran：源码核对 `App` 不再引用 `group:`、`expandedGroups`、`EntrySpan`、`ScrollState` 或锚点方法；现有 groups/scroll 算法及其测试继续复用，未增加依赖、修改 SDK 或重写详情视图。
- Not run：外层终端人工体验、真实供应商任务、macOS/Windows 原生矩阵与远端 CI。
- Why：本轮在 WSL 以现有行为为合同进行内部重构；PTY 使用本地可控模型和真实工具/存储，不等同于真实供应商或人工体验。
- Risk：自动化覆盖不能证明所有输入时序或外层终端复制能力。未声明渲染加速；`update` 仍重新计算布局，本轮收益是职责与测试集中。
- 清理：本轮临时测试日志已删除，验收结果记录于本节。
