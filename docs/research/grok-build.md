---
doc_kind: note
created: 2026-09-01
---

# xai-org/grok-build 深度调研

> 状态:已调研(2026-09-01)
> 快照:[`xai-org/grok-build@bc7f02e`](https://github.com/xai-org/grok-build/tree/bc7f02eddd3d84085849dc19ed216f11c23b0571),根目录 `SOURCE_REV=d5a0335a47221e8c9519936cb693e9b6450227ec`,`xai-grok-pager` 版本 `1.0.12`。
> 适用范围(2026-09-06):下文采用建议保留为研究历史。TUI 底座与验收以 [ADR-005](../decisions/005-tui-own-compositor.md)/[ADR-007](../decisions/007-no-compile-grok-reference.md) 为准;Team/dashboard 旧规划由 [ADR-008](../decisions/008-general-agent-positioning.md) 取代,当前输入行为见 [ADR-010](../decisions/010-input-ownership-and-interruption.md)。

## 1. 结论

grok-build 对本项目最有价值的不是 Rust 或某个 widget,而是三套已经被大量状态和回归测试打磨过的契约:

1. **信息诚实性**:block、status line、permission、dashboard 都只显示自己真正知道的事实,未知字段省略,不会用一个近似状态冒充另一个状态。
2. **输入所有权**:blocking card、viewer、scrollback、list、peek reply、dispatch input 各有明确 key owner,`Esc` 逐层退,快捷键栏读取同一 owner。
3. **监督面与执行面分开**:dashboard 从 session/roster truth 每帧重建 row;peek reply 指向已有 session,dispatch 始终创建新 session。

它不提供本项目所需的 peer-team delivery/board 协议。grok dashboard 监督 session、background task 和 subagent;不能因为界面相似就把它当作 teammate runtime。

建议迁移 UX 不变量与测试方法,不移植 Rust 代码、不照抄其完整功能面。

## 2. 仓库与架构边界

这是公开的 Rust source tree,README 明确根 `SOURCE_REV` 记录内部 monorepo 对应 revision。源码主要分成:

| 区域 | 职责 | 本项目关注 |
|---|---|---|
| `xai-grok-shell` | agent/session/provider/tool runtime | 只读 permission/subagent 语义 |
| `xai-grok-pager` | ratatui TUI、ACP client、scrollback/dashboard | 主要调研对象 |
| `xai-grok-workspace` | workspace、permission policy | 借决策顺序与安全规则 |
| `xai-grok-tools` | tool implementations、task/subagent coordinator | 借 limits/lifecycle 思想 |

Pager 基于 `ratatui` 的 `Rect`/cell 渲染,与 `pi-tui` 的 ANSI `string[]` 最终输出不同。但本项目需要迁移的是状态机和布局意图,不是逐 cell port:

```text
grok: source truth -> typed view state -> Rect layout -> cell rendering
myh:  source truth -> protocol reducer -> pi Component tree -> ANSI lines
```

只要 `core/protocol` 给出同样清楚的 typed state,两种渲染模型都能表达。

## 3. 三种 screen mode

源码目前不是模糊的“inline/fullscreen 四模式”,而是三个明确 enum:

```rust
enum ScreenMode {
    Fullscreen,
    Inline,
    Minimal,
}
```

来源:[`app/mod.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/mod.rs#L286-L331)。

| mode | 行为 | 对本项目的启示 |
|---|---|---|
| `Fullscreen` | alternate screen,应用拥有完整 viewport | 对应 Phase 2 `TuiAltScreen` |
| `Inline` | 不切 alternate screen,仍使用 pager 交互路径 | 对应保留的 main-host 逃生口 |
| `Minimal` | finalized block 写入 terminal native scrollback,只固定小 live region | 可参考,但不是 Phase 2 必做 |

`Minimal` 是独立 crate/hook 边界,没有让 fullscreen/inline 代码处处判断细节。这说明 host/mode 应是顶层 composition 决策,block component 不应知道自己运行在哪种 terminal host。

本项目当前只需 `main|alt`;不要为追平 grok 提前实现 `minimal`。当真实使用证明“想保留 native scrollback,又想固定 prompt/status”时再评估。

## 4. Scrollback 的 block 模型

### 4.1 block 是一等领域对象

grok 不是把所有输出拼成 markdown string。`RenderBlock` 下分 user、assistant、thinking、tool、system/notice 等类型;tool 又有 execute/read/edit/search 等 presentation。每个类型自己决定:

- header、body、accent。
- collapsed/truncated/expanded 输出。
- selectable 范围。
- searchable text。
- success/failure/activity。
- static commit 与 streaming update 行为。

统一 `DisplayMode` 至少包含 `Collapsed / Truncated / Expanded`:[`scrollback/types.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/types.rs#L49-L61)。

这比一个通用 `CollapsibleBlock` 更稳:外壳共享,内容语义按类型拥有。对本项目建议:

```text
BlockEnvelope(id, kind, lifecycle, displayMode, timestamps)
  + kind-specific data
  + kind-specific renderer/digest
```

不要让 renderer 通过标题文字猜“这是 edit 还是 execute”。

### 4.2 每类型独立截断

源码确认已有不同策略:

- thinking 读取自己的 `truncated_lines`:[`thinking.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/blocks/thinking.rs#L286-L307)。
- execute 使用 `first_lines/last_lines` 首尾裁剪:[`execute.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/execute.rs#L650-L675)。
- edit 有独立、很大的 typed diff renderer,不是把 `git diff` 当 execute output:[`edit.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/edit.rs)。

首尾裁剪优于只留前 N 行:command 的错误摘要、test summary 通常在尾部。Phase 2 现有 `first_lines=2/last_lines=3` 方向与源码一致。

### 4.3 streaming 与手动 fold

自动状态变化和用户手动选择会竞争。grok 用 `display_mode_pinned` + `respect_manual_folds` 表达“用户已经明确选择,后续 stream/finish 不应把它弹开”。更新路径显式检查 pin:[`scrollback/state/mod.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/scrollback/state/mod.rs#L1188-L1237)。

本项目不必照抄所有 fold group/sticky/pin reserve,但必须区分:

- `defaultDisplayMode`:配置/类型默认。
- `currentDisplayMode`:当前 UI projection。
- `manualOverride`:用户是否手动改过。

否则一个 streaming delta 就会覆盖用户操作。

### 4.4 性能方法

grok 的 scrollback state 维护 measured height、viewport window、selection model 和 layout cache,避免每帧测量整个历史。对 Phase 2 的直接启示不是马上移植 cache,而是先定性能不变量:

- 新 delta 不应让 cost 与完整 transcript 长度线性增长。
- resize 可以重测可见窗口和 margin,不必同步测完全部历史。
- folded block 的高度应稳定,streaming 内容不能造成全页跳动。

初版可以简单;当 profiling 显示 O(history) 后再加 cache,不要预先复制上千行 layout state。

## 5. Blocking card 与 key owner

### 5.1 一个 router,四种卡片

源码把 `Permission / CancelTurn / Question / McpElicitation` 归为同一个 `BlockingCard` enum:[`key_owner.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L9-L36)。

`KeyOwner` 再给出优先顺序:

```text
fullscreen takeover/modal
  -> permission
  -> line viewer / block viewer
  -> plan approval
  -> other blocking card
  -> active pane/global bindings
```

源码:[`key_owner.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L38-L54),[ranking](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L101-L140)。

不是每张 card 自己监听全局 key。这样 shortcuts bar、input handler 和视觉 focus 不会漂移。

### 5.2 park,不是 dismiss

用户面对 permission/question 时可能需要回看上文。grok 的 `EscStep::ParkFocus` 把键盘交给 scrollback,卡片仍画着、request 仍 pending;`Tab/Space` 提供 pinned route 回卡片:[`parked_card`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L142-L163),[`park_focused_card`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L279-L285)。

这比“Esc 关闭 modal”诚实:request 并未消失,UI 也不应假装它被处理了。

### 5.3 `Esc` 是状态机

`Esc` 不是一个 callback。源码的梯子包括:

```text
dismiss file search
-> leave text input
-> discard pattern edit / clear selection
-> back out overlay
-> park focus
-> keep running / dismiss wait
```

具体 step 由当前 card 内部状态决定,shortcuts bar 与 handler 都读同一个 `card_esc()`:[`EscStep`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L56-L98),[dispatch](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/key_owner.rs#L177-L270)。

本项目 Phase 2 的 `FocusStack` 应采用同一原则:先纯函数求 `EscStep`,再由 handler 执行;不要在多个 component 中各写半套顺序。

## 6. Queue、send now 与 cancel

### 6.1 普通发送与打断不是同一动作

grok 的 queue 模型明确区分:

- 普通 prompt 在 agent busy 时进入 held/queued rows。
- `Send Now` 选择一个可 interject row,cancel 当前 turn 后把它作为下一 turn。
- parked wait 可能允许直接 interject,但 goal/subagent wait 又有额外 gate。

`force_interject_queue_row` 只允许可安全重新发送的 row;client-expanded payload、bash 等不能把 display text 当原 payload 重发。[`queue.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/agent_view/queue.rs#L329-L389)。

这支撑本项目既有键位:

- `Enter`:enqueue。
- `Ctrl+Enter`:cancel-and-send/steer。

不要把二者合并成“如果 busy 就自动打断”。打断是更强的用户意图。

### 6.2 UI echo 与 shell truth

send-now 会先画 optimistic echo,但是否期待 shell cancel、row 是否已被新 turn adopt、cancel marker 是否应抑制都有独立字段。它说明:

- “UI 已显示新 prompt”不等于“旧 run 已 terminal”。
- “turn 看起来停了”不等于“background/subagent 已停”。
- cancel effect 失败时不能仅靠移除 row 收尾。

peer-team 需要把这些真相放在 invocation state,不能从 transcript block 推导。

## 7. Dashboard 与 peek

### 7.1 row 每帧重建,identity 稳定

`DashboardRow` 注释明确说明它每帧由 `app.agents` 建立;row 包含稳定 `DashboardRowId`、coarse state、activity、secondary line、cwd、timestamp、badges、context usage 等:[`row.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/row.rs#L14-L57)。

selection、pin、reorder 都绑定 row id,不是 index:[`state.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/state.rs#L377-L408)。

因此 row 状态变化、分组重排、rename、另一个 agent 插入都不会把 cursor 悄悄指向不同 session。这条必须迁移。

### 7.2 状态分类

dashboard 不是二值 busy/idle。核心状态:

```text
NeedsInput
Working
Idle
Inactive
Completed
Failed
```

`NeedsInput` 优先于 `Working`;working 除 live turn 外,也看 background task、monitor、loop/cron 等 activity。一个 turn 结束但 monitor 仍活着的 session 不能显示 Idle。

对 teammate UI 应做一层语义调整:

- teammate identity 本身不是 `Completed`。
- `Completed/Failed` 表示最近 session/run 或历史 row。
- `Inactive` 表示定义存在但当前未加载。

### 7.3 peek 替换 dispatch

peek 不是旁边额外叠一张 card;它复用底部 dispatch rect。源码直接写明“peek panel replaces the dispatch box”:[`peek.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/peek.rs#L43-L76),[layout](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/layout.rs#L335-L365)。

其结果:

- 未选 row:底部是 `New Agent` dispatch。
- 选 row:底部是 last response/activity + `reply` editor。
- model 与 always-approve 放 peek bottom border badge,列表保持可扫描。
- terminal 太矮时优先保证 list/可操作输入,peek 会收缩或隐藏。

### 7.4 draft 不能错投

peek reply 是完整 prompt widget。草稿在同一 row refresh 时保留,但 row 变化或 panel 关闭时清空:[`peek.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/peek.rs#L68-L76)。

更重要的是清空 undo history,避免 `Ctrl+Z` 在新 target 上复活旧草稿;对应测试在 [`state_tests.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/state_tests.rs#L1713-L1733)。

本项目可以选择“非空草稿锁定 target”或“切换时清空”,但不能让 selection change 保留草稿又悄悄改变收件人。

### 7.5 dispatch 与 reply 永不混淆

源码回归测试甚至覆盖“选中 subagent row 时 dashboard dispatch 仍创建新 session”。这是重要防误操作原则:

- dispatch 的 target 是新 session。
- peek reply 的 target 是 stable existing row。

视觉上复用 prompt widget没有问题,语义上必须是两条 typed action。

## 8. Subagent lifecycle

### 8.1 child view state

`SubagentInfo` 记录 child session、类型、activity、finished、pending kill、view retention/reload 信息。finished child 不一定立刻丢 view;只有 disk 已能重建时才安全 evict。[`app/subagent.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/subagent.rs#L1-L80)。

这条可迁移到 teammate/session:释放内存 state 与删除 durable history 是两回事。

### 8.2 duplicate 与 out-of-order

spawn/finish notification 可能重复、replay 或乱序。grok 将分类、delivery、deferred finish 和 re-dispatch 集中在一个模块:

- pending finish capacity `256`。
- TTL `60s`。
- finish-before-spawn 暂存。
- 已 finished 的 live duplicate 被拒绝。
- deferred finish 会剥掉 output,避免缓存无界大 payload。
- capacity 满时淘汰最老项。

源码:[`subagent_lifecycle.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/acp_handler/subagent_lifecycle.rs#L1-L12),[gate/defer/take](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/app/acp_handler/subagent_lifecycle.rs#L71-L210)。

对本项目的启示不是照抄 60 秒,而是 event reducer 必须假设:

- duplicate 正常存在。
- terminal 可能先于本地 projection 的 start。
- replay 与 live update 要区分 origin/generation。
- pending reconciliation buffer 必须有 size/TTL。

### 8.3 dashboard 的文档/源码漂移

仓库注释、slash command 文案和 user guide 仍有“dashboard 列出 subagents”的表述,代码也保留完整 `DashboardRowId::Subagent`、builder、attach/kill/peek 路径。

但当前 live render 调用 `build_rows_with_roster()`,而它明确调用 `build_local_rows(..., false)`:[`row.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/row.rs#L105-L128),[`include_subagents`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/dashboard/row.rs#L220-L247)。

准确结论是:

- full-tree row support 存在于实现与测试。
- 当前 live dashboard 不列独立 subagent row。
- 不能把 latent code path 当作当前产品承诺。

这也是本项目文档纪律的直接案例:报告固定 commit 和实际 call site,不只引 guide。

## 9. Permission 流水线

### 9.1 order-independent deny precedence

permission rules 的核心评估是 `deny > ask > allow`,与配置合并顺序无关:[`policy.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-workspace/src/permission/policy.rs#L229-L299)。

完整产品路径再组合 hook、managed rules、session grants、built-in classifier 与 mode。最值得迁移的不是所有兼容层,而是:

- deny 可以从任何层阻断,不能被后续 allow 覆盖。
- provenance 跟着 verdict,card 能解释为什么问/拒绝。
- project rules 受 trust gate,repo 不能默认给自己扩大权限。

### 9.2 Always allow 必须真的有效

grok 不只是保存 command prefix。它检查:

- prefix 能否无歧义 round-trip 到原 argv。
- dangerous verb / exec vehicle 的最低作用域。
- chained command 每段是否都被覆盖。
- pattern 是否是 catch-all。
- 保存后的 scratch state 是否真的会让同一 script 下次通过。

如果默认 scope 保存后仍会再次 prompt,`always_allow_row_is_effective()` 返回 false,UI 不应展示这行:[`bash_grants.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-workspace/src/permission/manager/bash_grants.rs#L162-L199)。

dangerous command 不生成静默 per-segment grant:[`bash_grants.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-workspace/src/permission/manager/bash_grants.rs#L69-L103)。完整命令的 exact grant 可以存在,但危险 prefix 不能扩大到未见参数。

Phase 2 不需要复制 grok 的 shell parser 规模。应先采用保守子集:

- 明确危险命令总是 ask。
- 只支持能可靠解释的 prefix/glob。
- 保存前模拟 replay,无效就不显示 Always allow。
- permission record 必须含具体对象,不只含 tool name。

## 10. Status line 的诚实性

grok 的 status line 有一条小但重要的规则:`MIN_DISPLAYED_COST_USD = 0.005`:[`segments.rs`](https://github.com/xai-org/grok-build/blob/bc7f02eddd3d84085849dc19ed216f11c23b0571/crates/codegen/xai-grok-pager/src/views/status_line/segments.rs#L1-L25)。低于阈值时不显示 `$0.00`,因为那会让“很小但非零”看起来像免费。

同一思路贯穿整个 row:

- unavailable metric 省略,不发 `N/A` 占位。
- running/background count 留在 status surface,不污染 transcript。
- command status segment 有 timeout、output cap 与 process-group kill,避免自定义 status script 卡住 UI。

本项目可直接采用三条:

1. cost `< $0.005` 隐藏。
2. 算不出的字段省略。
3. context usage 必须由当前 assembled context 真相点计算。

## 11. 迁移清单

### Phase 2 直接迁移

- typed block + per-kind renderer/digest。
- `Collapsed/Truncated/Expanded` + manual override。
- execute 首尾裁剪、thinking 独立截断、edit typed diff。
- single key owner + `EscStep` 纯状态机。
- blocking card park 到 scrollback。
- `Enter` enqueue / `Ctrl+Enter` cancel-and-send。
- permission deny precedence、effective Always allow。
- honest status line。

### Phase 2.5 直接迁移

- stable row id,selection/pin/reorder 不绑 index。
- dashboard row 每帧由 truth projection 重建。
- dispatch 与 peek reply typed 分离。
- target 变化时草稿绝不跨 agent 复活。
- needs-input 优先级与一步打开 exact request。
- duplicate/out-of-order event reducer + bounded reconciliation buffer。
- wide/short terminal 的渐进隐藏策略。

### 暂不迁移

- Rust/ratatui renderer。
- 全部 scrollback layout cache/sticky/group machinery。
- 完整 shell parser 与 permission compatibility layers。
- ACP 全量兼容。
- Fleet/leader/roster remote platform。
- goal/cron/monitor/voice/media/mermaid 的完整产品面。
- minimal mode。

## 12. 验收建议

### block/focus

- [ ] streaming update 不覆盖 manual fold。
- [ ] 四种 blocking card 跑同一组 `Tab/Esc/park/return` contract test。
- [ ] shortcuts bar 的 hint 与实际 handler 都来自同一 `EscStep/KeyOwner`。
- [ ] hidden input 不接收 key、paste、completion 或 mouse event。
- [ ] execute 截断同时保留 head/tail,展开后显示完整 output。

### dashboard

- [ ] row reorder/churn 后 selection 仍指向原 stable id。
- [ ] peek 开关不泄漏输入到 hidden dispatch。
- [ ] target 变化清空 draft + undo,或由本项目选择的 target-lock 规则阻止切换。
- [ ] short terminal 先隐藏 peek,不隐藏 primary action/composer。
- [ ] dispatch 总是新 session;reply 总是 existing target。
- [ ] background task 活着时 row 不提前变 Idle。

### lifecycle/permission

- [ ] duplicate spawn/finish 幂等。
- [ ] finish-before-spawn 有 bounded buffer 与过期行为。
- [ ] cancel RPC 失败不会把仍运行的 child 标 terminal。
- [ ] deny/ask/allow 顺序交换配置不改变 precedence。
- [ ] 无法阻止再次提示的 grant 不显示 Always allow。
- [ ] dangerous prefix grant 不扩大到第二条命令。

## 13. 风险与阅读提醒

| 风险 | 证据 | 使用纪律 |
|---|---|---|
| guide/source 漂移 | live dashboard 隐藏 subagent row | 以实际 call site + tests 为准 |
| 功能面过大 | pager 已覆盖大量 product surface | 只迁移当前 Phase 的不变量 |
| Rust 结构诱导过度设计 | state/layout 文件规模很大 | 先实现简单 projection,profile 后再 cache |
| UI truth 不等于 execution truth | optimistic send/cancel 有独立 expectation | core invocation state 才是 owner |
| status/permission 规则依赖 shell parser | upstream 做了深度 argv 分析 | 初版缩小可记忆规则范围,不伪装等价 |
| source snapshot 非 API | public source 可继续变化 | 每个结论固定 commit permalink |

## 14. 最终判断

grok-build 已证明“专业 coding TUI”的复杂度主要来自状态边界,不是画框。它最值得本项目学习的地方是:任何视觉元素都对应一个有 owner 的事实,任何 key 都只有一个 owner,任何会跨 target 的草稿都被主动销毁或锁定。

Phase 2 应先落 block/focus/permission 的不变量;Phase 2.5 再复用同一个 key owner 和 request bus 构建 dashboard。peer-team 的消息责任与持久 identity 仍由本项目定义,见 [peer-agent-team-tui.md](./peer-agent-team-tui.md)。
