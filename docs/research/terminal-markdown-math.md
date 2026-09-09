# 终端 Markdown 与数学公式渲染调研

> 状态:历史调研归档(2026-09-09)。保留实现前的问题、固定上游快照及候选比较;最终范围与架构以 #28 和 ADR-016 为准。

## 最终决策与交付入口

用户查看 Pi 字符公式预览后认为效果不符合预期,曾讨论接近网页排版的图片公式路线,随后明确将本次范围收敛为 **Markdown-only**。公式研究保留为历史依据,不代表待实现承诺。

最终采用 `marked` 解析 Markdown、`lowlight` 提供结构化代码高亮,保留 Forge 自有 compositor;增强 assistant 正文和详情,支持流式布局及原文复制。用户输入、thinking 和工具输出维持原有行为,LaTeX 保留原文。

- 任务规格:[GitHub #28](https://github.com/L-1ngg/forge-agent/issues/28)。
- 架构决策:[ADR-016](../decisions/016-markdown-rendering.md),定向修订 ADR-005 的 Markdown 自写及依赖限制。
- 施工与验收:[Markdown 渲染](../phases/markdown-rendering.md),记录实现提交 `f361e54`、自动化与 operator WSL 验收证据。本文不重复维护验收清单或任务状态。

## 初始调研建议（未原样采纳）

当时建议优先参考 **Pi 的 Markdown token 渲染与 LaTeX Unicode 布局**,输出接入 Forge 自有 `EntryRow` / `StyledSpan` / `TerminalFrame`。Pi 所核对的固定源码快照已经同时支持 Markdown 和一部分 LaTeX,包括块级分数、求和上下限、矩阵与分段函数;不需要浏览器或图片协议。这是本次找到的语言和交互形态最接近的先例,但不是可以直接替换 Forge compositor 的依赖。[P1][P2][P3]

Rich 和 Glow/Glamour 是更适合借鉴 Markdown 表格、列表、代码块、宽度布局的成熟实现。核对的默认解析器都没有启用数学扩展;“支持 Markdown”不能推导出“支持 LaTeX”。Rich 使用 Python,Glamour 使用 Go,直接调用会新增运行时或外部进程。[R1][G1][G2]

终端里至少有三个不同目标:单行 Unicode 可读公式、二维字符公式、图形排版公式。前两者可进入现有 cell 布局;最后一种需要额外的图片生命周期和终端能力处理。当时建议先讨论前两者是否满足用户预期,不能把网页 KaTeX/MathJax 的输出当作 ANSI 文本。[P2][P3][K1]

## Forge 实现前状态与约束

以下描述以实现前提交 `99ff67c` 为准,不是现有代码的能力说明。旧 Markdown 缺陷与依赖限制的后续处理见上方最终决策入口。

- [markdown.ts](https://github.com/L-1ngg/forge-agent/blob/99ff67cfc712c8c4f1a8787ae5cda639c86bfb66/packages/tui/src/markdown.ts) 明确是最小 Markdown,不是 CommonMark。实现标题、列表、fence、bold、italic、inline code,没有表格和 LaTeX 处理。
- 当时普通行和列表先 `wrapTextWithOffsets`,然后 `parseInline`。本轮主 Agent 的本地探针显示:40 列时 `**bold**` 产生 bold 样式;8 列时 `**abcdefghijklmnop**` 被切为 `**abcdef`、`ghijklmn`、`op**`,bold 样式消失。问题包含已有 Markdown 的换行失效,不只是增加语法种类。
- 同一探针中 Markdown 表格分隔符与 `$\frac{a}{b}+\alpha^2$` 保持原文。
- assistant 主界面的 [present.ts](https://github.com/L-1ngg/forge-agent/blob/99ff67cfc712c8c4f1a8787ae5cda639c86bfb66/packages/tui/src/transcript/present.ts) 调用 `renderMarkdown`;assistant 详情路径和 thinking 使用原文行。因此只改一个 renderer 不自动覆盖所有阅读入口,当时尚需确定范围。
- [ADR-005](../decisions/005-tui-own-compositor.md) 的包边界要求 TUI 自绘,Markdown 也自写;[check-deps.ts](https://github.com/L-1ngg/forge-agent/blob/99ff67cfc712c8c4f1a8787ae5cda639c86bfb66/scripts/check-deps.ts) 禁止 TUI 外部依赖和 import。**保留 compositor 与允许引入纯解析器是两个独立决定**。如选择 `marked` 等外部解析器,需要明确修订 ADR 和门禁,当时尚未获得这项依赖授权。
- `EntryRow` 携带 source 锚点;宽度变化、流式新增、滚动、详情定位和选择复制都依赖现有布局关系。上游返回 ANSI 行并不提供 Forge 的 source 映射,移植需要适配,不能直接写 stdout。[本地类型](https://github.com/L-1ngg/forge-agent/blob/99ff67cfc712c8c4f1a8787ae5cda639c86bfb66/packages/tui/src/transcript/types.ts)、[frame.ts](https://github.com/L-1ngg/forge-agent/blob/99ff67cfc712c8c4f1a8787ae5cda639c86bfb66/packages/tui/src/frame.ts)

上述探针是本地最小调用证据,不是实际终端/provider 端到端验收。

## 候选对照

| 实现 | 输入与输出 | 数学能力 | 与 Forge 的主要距离 |
|---|---|---|---|
| Pi TUI | TypeScript,`marked` token → 按宽度布局的 ANSI 行 | 自带 LaTeX tokenizer 和 Unicode renderer;行内与块级不同布局 | 借鉴/移植 token 与布局,改为 styled spans,保留 source 锚点;整包引入不符合现行 ADR |
| Rich Markdown | Python,markdown-it-py token → Rich renderable/segments | 核对的默认实现仅额外启用 table、strikethrough,没有数学扩展 | 适合参考结构化布局和表格;直接复用新增 Python 及跨语言边界 |
| Glow / Glamour | Glow 是终端 Markdown 应用;Glamour 为 Go 的 Goldmark → ANSI renderer | 默认 GFM、DefinitionList,无数学扩展 | 适合参考宽度/主题/表格策略;调用成品新增二进制/子进程,ANSI 还需转回 cells |
| UnicodeIt | Python 与 JavaScript/TypeScript 的 LaTeX 标签 → Unicode 替换 | 常见符号、部分上下标、组合附加符与固定分数字符 | 可参考符号表;不是通用二维公式布局,也不提供 Markdown delimiter/流式解析 |
| kitty graphics protocol | 图片像素/PNG → 终端图片 placement | 协议本身不解析 LaTeX;需要额外排版和栅格化 | 要新增图片占位、删除、裁剪、滚动、resize 与能力回退,超出纯文本 renderer |

依据:[P1][P2][R1][G1][G2][U1][K1]。适配代价为结合调研时 Forge 架构的工程判断,不是已测量性能结论。

## Pi 的可迁移细节与明确边界

### Markdown

固定快照使用 `Marked` lexer,支持 heading、paragraph、list、table、blockquote、code、hr 以及 strong/em/link/code/del 等 inline token。先形成 token 和样式再按终端宽度布局;表格按列宽换行,过窄时回退原 Markdown。代码高亮是主题回调,不是必须绑定一个语法高亮库。HTML token 作为文字处理,不是浏览器 HTML 渲染。[P1]

`render(width)` 返回 ANSI `string[]`;有内容和宽度缓存,需要正确处理嵌套样式与宽字符。Forge 更合理的适配终点是 `EntryRow[]`,而不是启用第二个 TUI 框架或在 compositor 之外打印 ANSI。[P1][P4]

### LaTeX

delimiter 层支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`。块级数学调用 `renderLatex(..., { display: true })`,默认开启;未闭合流式内容先保留原文,闭合后再渲染。源码测试覆盖货币、shell 变量、转义 delimiter、code span 和 code fence 不应误识别为公式。[P1][P5]

下表是上游测试断言,**本轮未执行上游测试**,不是 Forge 新能力:

| LaTeX | 上游期望输出/行为 |
|---|---|
| `\mathbb{C}^3 \to \mathbb{C}^3` | `ℂ³ → ℂ³` |
| 行内 `\frac{x^2+1}{x-1}` | 线性分数表达,使用括号保存分子分母边界 |
| 块级 `\frac{x^2+1}{x-1}` | 三行 `x²+1` / `────` / `x-1` |
| 块级 `\sum_{i=0}^n x_i` | 求和符号上下分别显示 `n`、`i=0` |
| `pmatrix` | 多行括号与对齐列 |
| `cases` | 多行大括号及条件文本 |
| 未知 `\unknown{y}` 或不完整 group/environment | renderer 返回 `undefined`,Markdown 层回退原公式 |

依据:[P2][P3]。

这是一部分 LaTeX 的终端可读转换,不是完整 TeX 排版。上游有以下明确简化:

- display 模式顶层分数可堆叠,嵌套分数仍线性化,避免高度无界增长。
- 上下标没有对应 Unicode 字符时可用 `^(...)`、`_(...)` 等形式。
- `\binom{n}{k}` 为 `(n choose k)`;部分多字符 accent 输出 `overline(AB)` 等可读文本,不是精确覆盖线。
- 未知命令或语法错误整体回退,不能宣称任意宏、自定义环境都支持。
- Unicode 字形和宽度仍取决于实际终端/字体;块级二维公式超过可用宽度时需要 Forge 自己确定“不破坏布局”的回退策略。当前调查没有在 WSL/Windows Terminal 验证这些字形。[P2][P3]

数学 renderer 本身约 1,400 行,只 import `visibleWidth`。相较整套 Markdown 组件,它更接近可隔离移植的纯文本模块;仍需许可证归属、Forge 宽度函数适配和项目回归证据。[P2][P6]

## 其他实现能提供什么

### Rich 与 Glow/Glamour

Rich 将不同块转成专门 renderable,例如 table/list/code,再让终端布局系统测量与渲染;图片仅占位。其 Markdown 默认 `MarkdownIt().enable("strikethrough").enable("table")`,没有数学 token 到公式 renderer 的链路。因此它适合作为终端 Markdown 视觉和测量先例,不能解决最初提出的公式目标。[R1]

Glow README 明确它是终端 Markdown 阅读应用并使用 Glamour 渲染。Glamour 初始化 Goldmark 的 GFM 和 DefinitionList,渲染到 ANSI,支持主题、word wrap 与 table wrap;不能因为 Goldmark 存在第三方数学插件就声称 Glamour 默认支持公式。完整调用 Glow 也不适合作为每个流式片段的 Forge UI renderer。[G1][G2]

### UnicodeIt

README 展示 `\alpha → α`、`A^6 → A⁶`、`m_0 → m₀`、`\sfrac{3}{5} → ⅗`,同时提供 Python 和 JS/TS 入口。它定位为标签转换,没有展示通用分数、矩阵的二维排版,不应许诺为完整 LaTeX renderer。许可证正文为 MIT,但部分符号数据标注来自 LPPL 数据;不能仅从 npm/GitHub 标签推断全部资源只有 MIT。[U1][U2]

### 图形公式路线

kitty 协议可传输 PNG,以 image ID、placement ID 管理位置、删除和生命周期,也有与 cells 结合的 Unicode placeholder 模式。它解决“终端如何显示已有图片”,不解决“LaTeX 如何排版”。Forge 的 `TerminalFrame` 是字符格模型,图片必须在宿主新增独立状态和失效处理;不能将 PNG 或 HTML 放进 `StyledSpan.text`。[K1]

接近网页的根号横线、任意嵌套分数与精确字体排版需要另行验证图片路线。用户随后明确宿主为 Windows Terminal + WSL,但在实现前取消了 LaTeX 范围;本次没有进行公式图片链路实测,也未建立跨终端支持矩阵。

## 源码快照与维护证据

以下为 2026-09-09 通过 GitHub 官方 API 读取的默认分支 HEAD,日期为 commit committer 时间(UTC)。它只证明快照时间,不代表维护承诺、发布稳定性或 Bun 兼容性。旧 `badlogic/pi-mono` URL 当前会重定向到 `earendil-works/pi`;固定 commit URL 仍可读取,最新包名也已改变。[P4]

| 项目 | 固定 SHA | HEAD 时间 | 许可证依据 |
|---|---|---|---|
| Pi | `6160683a4a8012f0d1cd30c145df18b4ca6f5176` | 2026-09-08 | MIT [P6] |
| Rich | `9d8f9a372cc5916fd4781fec207ced7ddac2f08f` | 2026-06-23 | GitHub repo API: MIT [R2] |
| Glamour | `49df6562f7a3740f872c3c96d46d3257aef30e56` | 2026-09-01 | GitHub repo API: MIT [G3] |
| Glow | `7b2431d4a82428fb477eb4361e11583e1644e9ba` | 2026-09-01 | GitHub repo API: MIT [G4] |
| UnicodeIt | `d7f3f0cb9b7f8c3abf8e47ea6158b2ee1f6cbf05` | 2023-03-12 | MIT 正文与 LPPL 数据说明 [U2] |
| kitty | `9f32b8648af7d372f98dce096de5bd086fa23056` | 2026-09-09 | GitHub repo API: GPL-3.0;使用协议和复制实现代码应分开判断 [K2] |

另核对 Pi `latex.ts` 的路径提交记录,最近三次分别为 2026-09-03、2026-08-11、2026-08-11,涉及 join symbols 与多行 LaTeX 修复。这说明这部分功能有近期修改,不能仅凭 Pi 项目整体成熟就认定所有数学边界稳定。[P7]

## 调研问题的后续处理

- 公式观感:用户未接受字符公式,最终取消本轮公式渲染范围。
- 显示入口:确定为 assistant 正文和详情;排除用户输入、thinking 和工具输出。
- 依赖方案:批准 `marked` 及独立高亮依赖,保留自有 compositor;架构约束变更由 ADR-016 维护。
- 流式、窄屏、代码折行、链接及原文复制:均已形成 #28 的规格,后续维护以该规格和施工文档为准。

## 历史预览记录

2026-09-09 按用户要求,在隔离临时目录运行上述 Pi 固定源码的 `Markdown.render(76)`,依赖为 `marked@18.0.11` 和 `get-east-asian-width@1.6.0`。预览使用自定义 ANSI 主题,未启用代码语法高亮回调。当时生成了 ANSI 与 PNG 预览供用户比较;这些临时附件未纳入 Git,现已不在工作区,本文仅保留运行记录。PNG 来自字符输出栅格化,不是 Forge 集成截图或用户终端验收。

实测发现带 `f(x) =` 前缀的 `cases` 第二行未对齐;矩阵列之间出现竖线;嵌套分数线性化。当时将这些输出原样展示供视觉决策,没有改动上游 renderer。

## 证据限制

阅读官方源码、测试断言、README、许可证和 GitHub 元数据;初次调研未执行候选代码;后续仅执行上述 Pi 预览样例,未运行上游完整测试,未进行速度/内存测量。上游测试内容是覆盖先例,不是本轮运行结果。本地旧 renderer 探针由主 Agent 完成,调研阶段本身没有修改运行代码。后续 Markdown 实现、ADR 与实际终端验收另见上方交付入口,不将其结果扩展为公式或其他候选的验证。

## Primary sources

[P1]: https://github.com/badlogic/pi-mono/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/tui/src/components/markdown.ts
[P2]: https://github.com/badlogic/pi-mono/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/tui/src/latex.ts
[P3]: https://github.com/badlogic/pi-mono/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/tui/test/latex.test.ts
[P4]: https://github.com/badlogic/pi-mono/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/tui/package.json
[P5]: https://github.com/badlogic/pi-mono/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/packages/tui/test/markdown.test.ts#L785
[P6]: https://github.com/badlogic/pi-mono/blob/6160683a4a8012f0d1cd30c145df18b4ca6f5176/LICENSE
[P7]: https://api.github.com/repos/badlogic/pi-mono/commits?path=packages/tui/src/latex.ts&per_page=3
[R1]: https://github.com/Textualize/rich/blob/9d8f9a372cc5916fd4781fec207ced7ddac2f08f/rich/markdown.py
[R2]: https://api.github.com/repos/Textualize/rich
[G1]: https://github.com/charmbracelet/glamour/blob/49df6562f7a3740f872c3c96d46d3257aef30e56/glamour.go
[G2]: https://github.com/charmbracelet/glow/blob/7b2431d4a82428fb477eb4361e11583e1644e9ba/README.md
[G3]: https://api.github.com/repos/charmbracelet/glamour
[G4]: https://api.github.com/repos/charmbracelet/glow
[U1]: https://github.com/svenkreiss/unicodeit/blob/d7f3f0cb9b7f8c3abf8e47ea6158b2ee1f6cbf05/README.md
[U2]: https://github.com/svenkreiss/unicodeit/blob/d7f3f0cb9b7f8c3abf8e47ea6158b2ee1f6cbf05/LICENSE
[K1]: https://github.com/kovidgoyal/kitty/blob/9f32b8648af7d372f98dce096de5bd086fa23056/docs/graphics-protocol.rst
[K2]: https://api.github.com/repos/kovidgoyal/kitty
