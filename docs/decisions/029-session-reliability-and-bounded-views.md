---
doc_kind: decision
created: 2026-09-30
---

# ADR-029: 会话异步归属与有界派生视图

> 状态:已实现并完成本地软件验收(2026-09-30；范围和测试边界以 [Issue #44](https://github.com/L-1ngg/forge-agent/issues/44) 为准)。施工、本次证据与未验证的外部边界见[施工图](../phases/session-reliability-issue-44.md)。

> 部分被 [ADR-030](030-native-arguments-and-conversation-persistence.md) 取代(2026-10-01):审批参数修订日志与执行前保存保证。下文保留原决策及当时证据，其余合同继续有效。

## 决定

管理命令绑定启动时的会话和操作身份。会话切换开始或 App 停止即取消并释放旧操作，成功、prompt、错误和 finally 使用同一归属检查。切换装配失败不会复活旧操作；当前会话正常结果继续报告和提交。宿主回调可以接收 signal；不合作回调不能延迟 App 停止，已开始的外部副作用不回滚。

官方 `memoryMiddleware` 继续拥有 deferred 保存调度。Markdown adapter 的整理模型阶段绑定 Invocation 取消，并有 `organizerTimeoutMs` 期限，默认 60,000 ms，只接受有限正安全整数。超过 JavaScript timer 范围的期限按单调耗时分段计时，不因溢出提前取消。期限覆盖模型准备、响应和原始协议审计；完整审计返回后按单调耗时再次确认未过期，不依赖 timer 已获得调度。取消或超时结束本地等待，即使 adapter 忽略 signal。迟到 usage 不改写已报告结果，迟到计划不能开始写盘。预检之后及每项文件操作开始前再检查 signal；已经开始的 I/O 仍按非事务合同结算。整理自身超时/校验/I/O 失败只报告失败记忆回执，主任务成功保留；显式 Invocation 取消仍返回 aborted。

短检查点是预算内的节选。必要 active 状态及来源保留，笔记额度为有效消息预算的 20%、最多 2,048 估算 tokens，可选结论取近期项；执行索引为 10%、最多 1,024 tokens，优先 active 引用的未知副作用，再取近期失败和近期调用。额度包含节选说明，预算不够时保守失败。完整检查点与原文不删改，省略项由当前分支的 `search_context`/`read_context` 找回。缺失结果表示副作用未知，不是未执行或新授权。压缩、usage 与最终请求使用同一轮有效 system/tool 预算；无解材料在 provider I/O 前失败。

`RequestBus` 的 pending 和请求信封活到结算；结算时移除未消费信封。近期 settled、dropped、responses、terminals 各保留固定容量，默认 256，可由 `retentionCapacity` 设置。慢消费者可能遗漏诊断通知，通过 `getRetention().truncated` 识别截断，并用 `isPending` 对账卡片；`getTerminal` 不再是永久账本。请求 ID 总包含实例随机身份和单调序号，自定义 idFactory 只提供标签，回收后也不复用。关闭后创建请求只回执，不增加保留记录。

消息 codec 统一基础存储形状和可持久化值；文件重开报告实际行号和字段，自定义 load 与核心追加遵循同一合同。请求投影另校验严格工具配对和最终请求合法性，允许历史中的部分响应、缺失结果和 provider 执行调用。合法扩展继续保留，旧文件不自动重写。

Invocation 拥有取消、输入队列/回执、重试/恢复和权威结算；Response 拥有一次 applied 快照、工具准备、去重、审批和原生执行转换。工具提案先提交再审批；审批修改的最终参数在整个原生批次 resume 前逐条提交，任何失败阻止本批副作用并停用实例。参数修订使用既有 v4 `SessionMessage` 的空 assistant、`contextExcluded`、`toolCallId`、`toolName`、`toolArguments` 字段，作为原文证据，不是持久化审批或可重放任务。投影略过这些修订记录而保持提案/结果配对；检索仍可读取参数。普通工具和官方工具集中桥接，可信来源由工具对象身份确定，同名不能绕权。TanStack `chat()` 仍是唯一续轮循环。

历史缓存只接受实例拥有的事实，以成功提交后的 revision、leaf 和投影预算失效；失败追加不发布新事实。公开快照隔离，缓存不写入 JSONL。公共 `UsageTracker.setContext` 保留对调用方可变材料的实时观察；Session 使用 `setContextSnapshot` 复制提交后的消息/usage 并缓存查询，替换快照或用量更新时失效，自定义 tokenCounter 不缓存。展示按内容、宽度、主题、折叠/分组缓存当前条目和布局，尺寸变化独立恢复锚点；重绘合并到一次事件循环，终态对账引起卡片退役时安排刷新，停止取消待画任务。冷布局仍需要处理全部历史。

## 取舍与边界

永久通知保留可让慢消费者读到每个诊断，但会无限增长；本决定选择固定容量和权威 pending 对账，功能结果仍直接结算。全量执行索引让模型直接看见所有调用，却会重新耗尽窗口；预算内节选保留查找入口，不能据此承诺语义质量或费用改善。

本决定补充 ADR-010、017、023、026–028，不恢复旧记忆取消恢复账本、CAS、锁、事务、后台轮询或第二执行循环。强制终止任意宿主工具/文件操作、精确 tokenizer 上限、跨平台性能与真实模型抽取质量均不在本次承诺内。
