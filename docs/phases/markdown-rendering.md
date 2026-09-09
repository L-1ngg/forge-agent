# Markdown 渲染施工

> 状态:已完成(2026-09-09,operator 确认 WSL 人工验收通过)。任务规格及唯一 AC 定义见 [#28](https://github.com/L-1ngg/forge-agent/issues/28),架构见 [ADR-016](../decisions/016-markdown-rendering.md)。

## Entry 与 Design

用户已批准实现 #28。起始 HEAD 为 `99ff67cfc712c8c4f1a8787ae5cda639c86bfb66`;既有 `docs/plan.md` 单行改动与未跟踪研究/图片附件保持独立,不纳入实现提交。

统一 Markdown renderer 先产生语法样式与原文范围,再折行为 `EntryRow`。正文 shell 和详情均将这些行绘入 frame。源快照/范围只服务选择与定位,不属于终端视觉差分;超链接目标属于视觉差分,变化时必须清除旧区域。

现有 `TextSelection` 从屏幕快照选取:assistant cell 使用源范围恢复原文,其他 cell 沿用屏幕字符。代码块、表格、强调等歧义区域携带完整语法范围,纯文本保留字符粒度。详情继续使用源行/列作为阅读锚点,不将 visual row 编号保存为内容位置。

## Batches

1. 修订架构边界,引入解析/高亮依赖;用现有公开 renderer 边界逐项覆盖结构与宽度。
2. 共享正文/详情布局,接入源范围选择和宿主链接,通过 `App` 的事件、输入、frame、剪贴板边界验证。
3. 项目检查与 headless 回归、双轴 WIP review、修复、提交。

## Verify 与 Release

按 #28 Testing Decisions 复用现有最高集成边界,不重复要求用户确认。分批跑相关测试与类型检查,最后执行 `bun run check`、`bun run test:headless`。功能断言必须经历旧实现失败的反向证据。

代码提交不等于人工交付。operator 已针对本实现确认 WSL 验收通过并授权关闭 Issue,本次确认独立于之前会话管理的验收;原话及证据边界见下文。

## Rollback 与 Learn

不改持久化结构,回退本次代码和依赖提交即可恢复旧显示路径;不修改会话历史。仅在存在可复发且有回归防护的新教训时另记 lessons。

## 验证记录

- Ran:最终 `bun run check` 通过,包含依赖边界、全 workspace 类型检查、automation 类型检查和 `497 pass / 0 fail`(70 files,11320 assertions)。审查期间发现嵌套表格复制问题后修复,重新执行完整检查;不是仅引用修复前结果。
- Ran:`bun run test:headless` 通过,受控 provider 事件序列正常结束。
- Ran:预览脚本单独 `tsc --noEmit` 通过;真实 PTY 中完成启动、Tab/Enter 打开详情、搜索“验收”、Ctrl+C 退出,确认 alt-screen 与输入模式恢复序列。
- Ran:最初跨行加粗、表格、代码续行/高亮、LaTeX 原文与链接更新测试经历 red → green;审查新增的嵌套引用/列表代码与表格、键盘选区复制亦先复现失败再修复。键盘/鼠标流式快照与暂停阅读回归通过。
- Ran:两轴 WIP review 已复核闭合。Spec 修复嵌套代码/表格源范围与键盘选区/快照,Standards 两项局部重复建议已消除。
- Golden:仅 `assistant-md-80` 与 `transcript-stack-80x16` 各 6 个 cell 的前景色改变,来自 `const` 关键字及数字 `1` 的高亮;逐 cell 核对后更新,无布局偏移。
- Operator:2026-09-09,operator 针对实现提交 `f361e54` 反馈“我都wsl验收通过了，你可以关闭这些issue了”。结合此前确认的 Windows Terminal + WSL 环境,记录本功能人工验收通过。用户未提供本次逐项操作记录或版本信息,不补写这些细节。
- Not run / Why:Agent 自身只执行 PTY 与假宿主剪贴板验证;其他平台未实测。operator 的人工验收与 Agent 自动化证据分别记录。
- Risk:单列极窄内容区无法容纳双宽字素时显示占位符,复制仍保留原始字素。不将本次 WSL 验收扩展为其他平台验证。

## Windows Terminal + WSL 手工入口

在仓库运行 `bun scripts/markdown-preview.ts`。固定样例复用真实 `App`、frame 和 Host,不调用 provider、不保存会话。

1. `Tab` 选择 assistant,`Enter` 打开详情,`Home` 回到顶部;用 `/` 搜索“验收”,`n` 跳下一个匹配。
2. 在正文和详情分别调整到约 80/40/20 列,检查代码续行、中文、表格换行及记录回退,再恢复宽度。
3. 鼠标拖选加粗、代码和表格,以及详情 `v`/`y` 选区复制,粘贴到文本编辑器核对原文、围栏和表格语法;未选区的详情 `y` 复制整条回复。
4. 返回输入框,输入任意文本并回车重放流式样例;打开详情并上滚暂停,观察后续追加及 resize 是否保留阅读位置。
5. 按终端的超链接打开手势检查目标地址;`Ctrl+C` 退出,检查正常终端输入恢复。

上述步骤保留用于复测;本次以 operator 明确验收反馈记录通过,未要求其补交逐项记录。PTY 自动化本身不代表人工验收。
