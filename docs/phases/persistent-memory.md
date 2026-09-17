# 持久记忆施工与验收

> 状态:本地软件与真实模型门槛通过，CLI 默认启用(2026-09-17)。需求与任务级验收唯一来源：[Issue #32](https://github.com/L-1ngg/forge-agent/issues/32)。起点 `fc5fe07784081fedf554745e10b46a060c61bb94`，staged/unstaged/untracked 均为空；远端状态以交付提交对应的 CI 为准。

## Entry 与设计

用户已要求实现、验收后 commit/push；沿用 Issue 已定的 Markdown、会话内更新、worktree 独立副本及默认发布方向。实现细节由本施工图固定，不重新选型。架构取舍见 [ADR-019](../decisions/019-persistent-memory.md)。

- `LongTermMemory` 为 SDK 显式提供的能力，绑定宿主给定的 `user`/`project` 绝对目录；工具只接受这些别名与相对 Markdown 路径。拒绝路径穿越和目录内符号链接。普通 Markdown 无需登记。读写、删除、搜索、固定均经过该入口。
- CLI 数据根为 `$XDG_DATA_HOME/forge-agent/memory`，缺省 `~/.local/share/forge-agent/memory`。用户笔记在 `user/`；项目在 `projects/<sha256(canonical repository identity)>/<sha256(canonical worktree root)>/`。Git common dir 标识仓库，主 worktree 由 `git worktree list --porcelain` 确定；非 Git 使用规范化启动目录。
- 首次初始化只复制主目录中的 Markdown；成功标记最后发布。失败重试仅补不存在的文件，保留人工修改；成功以后不重复复制。锁内管理写入跨本机进程串行，提交前再次核对读取版本。进程死亡的锁可回收；不承诺任意外部编辑器竞态合并或断电级事务。

锁回收自身中断或锁记录不完整时明确失败，需检查后处理，不能冒险移除活跃所有者。初始化成功标记采用临时文件原子发布；可识别的旧短写标记允许补齐重试。
- 单文件原子替换；读取版本包括内容摘要和文件 revision，旧计划遇到编辑或删除拒绝。写操作使用身份与收据去重；正文和 MEMORY.md 是两个独立提交，结果提示索引仍需模型维护。
- 文件上限 256 KiB；读取每页最多 4096 Unicode 字符，搜索最多 10 个 256 字符片段，目录扫描最多 1000 个目录项、总计 8 MiB，超限明确报告。来源显示最多处理 4 个注释、每个最多 2048 字符，原文仍可分页查看。可选 frontmatter 不作为身份或 scope，不信任其语义；解析失败仅警告。
- `ContextAssembler` 共用上下文压缩输入预算与 usage 计数。可选注入最多 `min(2000 tokens, 输入预算的 5%, 当前剩余预算)`；索引按片段读取，固定笔记必须整篇放入，否则明确报告。材料作为标明作用域、路径、指纹的参考消息，绝不成为系统指令或权限输入。每个请求边界检查索引、固定清单与链接目标的磁盘 revision，变化或新输入/steering 后刷新；按需主题读取不使用旧正文缓存。
- `read_memory`、`search_memory`、`write_memory`、`delete_memory` 沿用工具权限/hooks/取消。每次调用执行最多 12 次记忆工具操作、4 次写入，共用现有模型请求和 usage；无额外整理模型。关闭自动更新后保留工具定义并在实际写入前拒绝模型写操作，显式 `/memory save/edit/delete` 管理独立可用。
- `/memory` 支持 list/read/search/save/edit/delete/pin/unpin/sources/import，以及 auto/inject 的 on/off；save/edit 接收相对路径和完整正文，edit 需先 read 并使用其版本，导入仅用户指定当前项目的单个会话、最多 20 条/32 KiB，交给当前请求整理，不启动后台任务。删除笔记不删除 JSONL。

## Batches、Verify 与 Release

1. 文件管理与真实 Git 副本：引用 AC-1—6、AC-10—11，使用真实临时目录和可注入文件 I/O 失败。
2. SDK 装配、会话内工具、CLI 管理：引用 AC-7—14，公开 SDK + 受控 provider + PTY。保留上下文压缩拒伪回归。红灯先行，提交前双轴 review；最终全量测试一次。
3. 真实模型：引用 AC-15—16，冻结无记忆基线、开发集与不重用的保留集；每组覆盖显式保存/召回、自动更新、临时约束、失败结果、限定条件、作用域、纠正、无价值增长及继承的过期背景。开发后冻结实现再跑保留集。

质量门槛预先固定：保留集严重错误记忆 0（临时授权永久化、失败冒充成功、越界归属、旧信息覆盖新结论）；显式保存后关键事实召回率至少 90%，适用条件保留率 100%，无价值场景不新增主题；自动更新至少保留 75% 有价值内容。相同任务无记忆基线用于比较召回收益，额外中位模型调用不超过 6、整组增量费用不超过 US$2。实验总费用预算 US$5，单请求 60 秒、输出 2048 tokens、每场景最多 8 次模型请求；达到限制停止并保留失败。费用以 provider usage 为准，模型目录价格仅为估算，不能替代账单。

所有软件合同与保留集门槛通过后 CLI 默认 `autoUpdate=true, injection=true`；之前不声明已发布。SDK 始终显式装配。真实模型结果不能用受控 provider、旧上下文压缩评估或格式检查代替。

## Rollback

分别关闭自动更新和注入；保留 Markdown 和 JSONL。必要时 revert 本任务提交，旧版本忽略新目录。初始化失败保留可读副本且下次补齐，禁止覆盖人工修订。退出只等待当前工具结算。

## 验证记录

2026-09-17 最终默认开启版本的本地软件验证：`bun test` **579 pass / 0 fail / 11937 expect**（80 文件）；`bun run typecheck`、`typecheck:automation`、`typecheck:examples`、`check:deps`、`test:headless` 和 `git diff --check` 通过。首轮全量之后因真实质量失败修改指导，并开启默认值，因此重新验证最终全量；没有用早期全量代替最终版本。真实模型实验独立运行，不属于 `bun test` 或 CI。

| Issue 合同 | 本次证据 |
|---|---|
| AC-1、3、4、6、10 | `packages/core/test/persistent-memory.test.ts`：真实 Markdown 重开、手写/损坏元数据、分页/多语言搜索、CAS/删除、重试、单文件失败、动态索引预算 |
| AC-2、5 | `packages/cli/test/memory-host.test.ts`：真实 Git worktree 一次继承、独立修改、分支切换、初始化失败/短写恢复不覆盖人改；SDK 请求检验删除后无旧投影 |
| AC-6 | 独立 OS 进程竞争写入；杀死持锁进程、两回收者受控交错后只允许一位写入者进入 |
| AC-7、8、9、11、14 | `packages/core/test/memory-session.test.ts`：公开 SDK 与实际 HTTP 请求、会话内落盘、hooks/权限/预算拒绝、取消/释放等待、JSONL 失败停用、共享注入预算和同轮外部删除刷新 |
| AC-12、13 | CLI 管理、真实无模型 `--memory`、当前项目显式限量导入；PTY 完整 save/read/edit/delete 与终端恢复；`deny-all` 下模型写入拒绝且无文件 |
| 既有合同 | 全量回归覆盖上下文压缩拒伪、输入归属、会话恢复/存储故障、工具并发与退出语义 |

反向验证包括旧 CAS 覆盖、同轮删固定笔记、损坏来源导致 6001 条警告、`deny-all` 意外写入等测试先红后绿；不是仅检查实现形状。双轴复审修复锁回收竞态、缓存刷新、初始化 marker、动态预算与损坏来源显示限额，并同步文档。

AC-15/16 的[完整质量/成本记录](../research/persistent-memory/acceptance.md)及原始回答/笔记已归档。v1 因把记忆文件误报为权威文档更新而拒绝发布；修复后新的 v2 独立 10 场景完成语义验收（其中 1 个上游 502 场景保持实现/样本不变补跑，错误保留）。严重错误 0，显式召回 3/3，新增有价值信息自动保存 3/3，限定保留 7/7，无价值场景 3/3 无文件增长；增量请求中位数 0.5、usage 估算增量 US$0.085972。初始“每场景 8 请求”的口径与脚本按 turn 限制的差异在该报告中明示并核对实际数，没有把四次执行总数说成 ≤8。

CLI 的 `autoUpdate` 与 `injection` 缺省均为 `true`，不要求首次 opt-in。真实 CLI 回归在未配置 memory 开关时确认既有索引进入 HTTP 请求、默认写入实际落盘，`deny-all` 拒绝模型写入而保留原索引。SDK 仍显式绑定。远端 Ubuntu/macOS 检查随提交推送执行，实时结果看该提交的 [CI](https://github.com/L-1ngg/forge-agent/actions/workflows/ci.yml)。

未做人工终端交互、Windows 原生运行、断电持久性或长期在线效果测量；PTY/软件证据不冒充人工验收，既有 Phase 1 / E1–E3 豁免保持原状态。费用为已报告 usage 的目录价估算，不是账单；未报告 usage 的失败 HTTP 不宣称免费。
