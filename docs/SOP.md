# SOP — 开发协作流程

> 状态:生效(2026-08-31)。机制出处:[decisions/001-doc-system.md](decisions/001-doc-system.md)。
> 本文件是「怎么开发」的唯一真相源;[AGENTS.md](../AGENTS.md) 只放摘要并指向这里。

## 核心立场

代码便宜,对齐贵。非 trivial 改动的贡献主体是**意图**(写清楚改什么、为什么),代码是意图的产物。
完成的唯一判据是证据:跑了什么、结果是什么 —— 不是「应该没问题」。

## 改动分级

| 规模 | 例子 | 需要什么 |
|---|---|---|
| 小 | 文案、明显 bug、单行修复 | 直接改 + 验证证据 |
| 中 | 行为变更、新工具、新模块 | 改前在相关施工图补设计;改后同步受影响文档的状态行与交叉引用 |
| 大 | 新 Phase、架构方向变化 | **先写设计文档**(决策 → ADR;施工 → phase 文档,模板 [templates/feature-doc.md](templates/feature-doc.md)),operator 确认后才写码 |

经验法则:改动若会让 plan.md 的路线表过时,就是「大」。

## 验证纪律

- 每个工作项带**可验证的验收标准**,格式 `- [ ] AC-{N}: …`(checkbox,不是感觉)。
- 完成后报告:Ran(跑了什么)/ Not run(没跑什么)/ Why / Risk。
- UI 或交互改动按 operator 的全局规则做端到端验证;一张截图不算验证。

## Review 交接(review-notes/)

跨 session / 跨工具换人继续或评审时,写交接信,模板 [templates/review-request.md](templates/review-request.md)。要点:

- 原始需求**引用 operator 原话**,不写二手转述
- verdict 绑定具体 commit SHA 或文档版本
- 同 session 内的轻量评审直接对话完成,**不落盘** —— 避免为追溯再造追溯

## 教训入库(lessons.md)

出现「踩坑 → 修复 → 可能复发」时,按 [lessons.md](lessons.md) 的三门禁提炼:
可追溯锚点 / 防护必须是可执行机制 / 「原理」需有真实失败案例。不满足就不入库。

## 决策何时落 ADR

- 有两个以上可行方案、选了其一 → 写 ADR
- 推翻已有 ADR → 写新 ADR,旧的保留并在状态行标「被 NNN 取代」
- 纯执行细节(没有备选方案) → 不写
