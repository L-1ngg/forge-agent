---
doc_kind: decision
created: 2026-09-01
---

# ADR-003: permission 规则匹配用显式前缀 / glob 规则表,不做 DSL

> 状态:已批准(2026-09-01,operator 要求补记)
> 参与者:operator(发起)、Claude(起草)

## 背景

Phase 2 的 M2([phases/phase-2.md#L84](../phases/phase-2.md))要落 permission 决策链:hooks → rules → 记住的授权 → 内置自动批准 → mode。「rules」那一层怎么表达,有两条路:写成配置语言(正则 / predicate DSL),还是写成一张显式规则表。

参考项目里有现成的反面证据。[design-rationale.md#L386](../design-rationale.md) 记录 clowder-ai 的 SOP YAML predicate DSL 是**建议性**的:trace 由 agent 自述、仓库里零个 `PreToolUse`、`pnpm gate` 根本不读 SOP catalog;真正的强制力在一个 21KB 的 `.githooks/pre-commit` 里(约 20 个 `exit 1`)。同一条规则被表达三次,而没有任何东西保持同步。该节的结论([#L387](../design-rationale.md)):

> **教训:一条规则一个家,且选那个能说「不」的家。**

证据强度按 [AGENTS.md](../../AGENTS.md) 引用纪律标注:`03-meta-rules.md` 声称 Skill 提供「强制执行」`[明述]`,而 `09` 的三层防御表自己写着「全是文字指令,无强制执行」`[自证]`;后果是两次真实的未授权合入(F11、F24)。也就是说,这条不是推断,是自证 + 事故。

DSL 已被 [design-rationale D 节「明确不做」](../design-rationale.md)收录。本 ADR 把那条通用禁令落到 permission 这个具体使用点上。

## 决策

规则匹配用**显式前缀 / glob 规则表**。可执行的家是 `decide(toolCall, ctx) → allow | deny(reason) | ask(payload)` 这个纯函数,不是配置语言。

配套约束(都属于「规则只有一个家」的同一条推论):

1. 决策链是纯函数,可表驱动测试、可解释给用户看、可属性测试 —— 与 Phase 1 把 abort 抽成纯函数状态机是同一手法。
2. 危险清单(`rm` / `chmod` / `kill` / `git push`)**从不认记住的前缀**,即使存在匹配的 always-allow 规则仍然提示。
3. 记住的授权键必须含被授权的**对象**(工具 + 具体参数模式),不能只记工具名。丢作用域正是 F24 事故的形状 —— 「可以合入」是真的,只是说的是另一个 PR([cat-cafe.md](../cat-cafe.md) F.1 ③)。
4. 当没有任何可记住的规则能阻止再次提示时,**不提供 Always allow 行**,而不是存一条不起作用的规则。
5. mode 只有 `default` / `accept-edits` / `deny-all`;`plan` 不在枚举里预留。

被否方案:

| 方案 | 否决理由 |
|---|---|
| 正则规则 | 用户写的正则不可审阅也不可解释;确认前无法向用户展示「究竟会记住什么」的规则原文 |
| predicate DSL(clowder 式) | [design-rationale D](../design-rationale.md) 明确不做。DSL 表达的是意图,强制力仍在别处,规则被表达两次且不同步 |
| 把强制力放在 prompt / 文字指令里 | **说「不」的家在 hook 里,不在 prompt 里**([design-rationale#L386](../design-rationale.md)`[自证]`) |

## 后果

- **变容易**:规则表可以整表打印给用户看,`decide()` 可被表驱动 + 属性测试覆盖;「记住什么」在确认前就能显示原文。
- **变难**:表达力有上限,复杂策略要改代码而不是改配置。
- **触发重估**:出现**第三个**「规则表写不出来」的真实需求。第一、二个按改代码处理。
- **需要同步的文档**:[phases/phase-2.md](../phases/phase-2.md) M2(已含本决策);[design-rationale D](../design-rationale.md) 的 DSL 禁令保持为通用条目,不在那里复制 permission 细节。
