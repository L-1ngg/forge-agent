# Pi Bash 完整输出临时文件调研

> 状态:调研完成(2026-09-07)。固定上游源码事实与借鉴建议，不是 Forge 已批准的实现规格。

## 范围与结论

固定快照为 `earendil-works/pi@9767ba275f3e9a5ee0f5c5342249b629ab1b2282`，追踪 coding-agent 内置 Bash 的 `createShellToolDefinition`、`OutputAccumulator`、截断和子进程等待逻辑。本次直接读取公开源码和上游测试，没有运行 Pi、测试套件或真实模型请求。

Pi 将“给模型看的尾部预览”和“本次命令实际捕获的输出”分开：小输出只缓存在内存；一旦超过预览阈值，创建临时日志，把此前收到的原始字节补写进去，后续字节继续写入。模型收到受限的尾部正文及日志路径，需要时用普通文件工具读取。它不是摘要，也不是命令结束后再次执行命令来恢复输出。

## 数据路径

1. `stdout` 与 `stderr` 的 `data` 回调都进入同一个累加器，按宿主观察到的回调顺序合并；没有流标签，也不保证重建程序两个流之间的严格写入顺序。[bash.ts:122](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L122-L125)
2. 默认预览上限为 `2000` 行与 `50 * 1024` bytes。任一超过才触发；仅达到上限不触发。累加器另外检查原始字节量与 UTF-8 解码后的字节量，因此极端编码数据下落盘与可见截断不必完全同步。[truncate.ts:11](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/truncate.ts#L11-L12)、[output-accumulator.ts:205](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L205-L209)
3. 阈值以内，`rawChunks` 保存原始 `Buffer`；触发后 `ensureTempFile()` 创建日志，按顺序写入全部旧 `rawChunks`，再写入触发阈值的当前块和后续块。旧数组随即清空，所以文件包含阈值之前的开头。[output-accumulator.ts:64](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L64-L77)、[output-accumulator.ts:211](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L211-L220)
4. 另一路用流式 `TextDecoder` 拼接 UTF-8 展示文本，保留滚动尾部。默认滚动目标约 `100 KiB`，超过约 `200 KiB` 后裁回目标；单个输入块、临时字符串及写流队列另占内存。最终 `truncateTail` 再限制为最多 `2000` 行 / `50 KiB`，通常保留完整行；末行本身过长时允许保留该行尾部，并沿 UTF-8 边界切分。[output-accumulator.ts:57](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L57-L70)、[尾部维护](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L148-L203)、[尾部截断](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/truncate.ts#L162-L261)
5. 命令结束后停止接收数据，flush decoder，取得预览，调用 `stream.end()` 并等待 `finish` 后返回。正文附加 `Full output: <path>`；成功结果的 `details` 同时包含 `truncation` 和 `fullOutputPath`。这里等待的是写流完成，没有 `fsync` 持久性承诺。[bash.ts:306](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L306-L334)、[output-accumulator.ts:121](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L121-L141)

例如 `seq 3000` 超过行数限制但不到 50 KiB：模型只看末尾 2000 行，临时文件仍含第 1 到第 3000 行。上游有对应测试断言文件同时包含开头和结尾。[tools.test.ts:740](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/test/tools.test.ts#L740-L761)

## 查回与文件生命周期

- 文件位置是 `join(os.tmpdir(), "pi-bash-<id>.log")`，`id` 为 8 随机 bytes 的 16 位 hex 表达。Unix 上通常落在 `/tmp`，实际由系统临时目录决定；不是 session 专属目录。[路径生成](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L19-L22)、[Bash 前缀](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L375-L383)
- 使用普通 `createWriteStream(path)`，此处没有显式 `mode: 0o600`、排他创建参数或加密。不能把随机文件名当作访问隔离；实际权限受运行时默认值、umask 和平台影响。[创建代码](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L211-L220)
- 本次核对的累加器和 Bash 路径只关闭文件，不删除文件，也没有 TTL、会话删除联动或总磁盘配额。不能据此承诺系统临时文件跨重启长期存在，也不能将这一路径描述成会话归档。这里没有对整个仓库及系统清理服务作穷尽证明。
- 模型可调用 `read` 的 `path/offset/limit` 阅读日志，或用 Bash 搜索选段。Pi Read 的分页限制的是模型可见结果；实现仍先 `readFile` 全文件，再解码、分行、切片，不是磁盘读取内存的严格上限。[read.ts:127](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/read.ts#L127-L175)

## 失败和资源边界

| 情况 | 固定快照行为 |
|---|---|
| 非零退出码 | 完成输出文件后，抛出的错误文本带尾部、完整输出路径和退出码；没有成功结果中的结构化 `details` |
| timeout / abort | 收集到的数据先完成落盘，错误文本带尾部、路径及超时/取消状态；是否继续进入下一模型请求由上层取消语义决定 |
| 其他 `ops.exec` 异常 | 尝试完成输出，但随后重新抛原异常，不保证错误文本包含日志路径 |
| 写盘失败 | `closeTempFile` 等待阶段会监听 `error`；文件创建时没有立即安装同类处理，不能声称所有早期写盘错误都可优雅返回预览 |
| 生产速度超过写盘速度 | `.write()` 返回值未检查，没有等待 `drain` 或暂停 stdout/stderr，写流队列可能增长，故“尾缓存有界”不等于“整个采集过程内存严格有界” |
| 输出持续增长 | 没有该日志的大小上限；Bash timeout 可选且默认未设置，不能声称磁盘消耗有界 |

错误路径依据:[bash.ts:338](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L338-L369)；写流依据:[append](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L64-L77)、[创建与旧块冲刷](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L211-L220)、[完成阶段监听](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L121-L141)。上游有超时/取消错误保留路径及 UTF-8 跨块解码测试，本次只阅读未运行。[错误测试](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/test/tools.test.ts#L504-L538)、[编码测试](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/test/tools.test.ts#L700-L714)

“完整”应理解为工具在采集生命周期内收到的 stdout/stderr 原始字节。进程取消后不可能保存尚未产生的数据；固定快照还在父进程退出后采用 100ms stdio 空闲宽限，期间每次数据重置计时，最后销毁管道。这不是持续跟踪所有后台后代未来输出的承诺。[child-process.ts:38](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/utils/child-process.ts#L38-L97)

## Forge 借鉴建议（调研时提案）

借鉴核心机制：在 Bash 捕获层采用小输出内存缓存、超限后懒落盘和受限尾部预览。只有捕获层能保存目前被 Bash 丢弃的字节；下游上下文管理器无法恢复已经丢弃的数据。

若要满足已经讨论的 `read_context` 长期引用语义，建议工具输出携带归档句柄及完整性元数据，由宿主接入 invocation 的暂存与提交：本次 invocation 内可读取，整体成功提交后随会话保留，提交前取消或失败清理暂存文件，并遵守 [ADR-010](../decisions/010-input-ownership-and-interruption.md) 的写入生命周期。非零退出和超时也要保留可传递的归档元数据，不只塞进错误字符串。归档文件应流式分页读取，不能查回时再整体读入内存。

这需要修改此前“第一版不归档 Bash 上游丢弃内容”的范围，也会影响只在消息记录内保存原文的存储简化；不能因为借鉴 Pi 就自动扩为已批准实现。源码路径本身不规定 Forge 应采用多少磁盘配额、何时过期或如何处理归档失败，这些需纳入设计。

迁移时需补足明确的写入背压、从创建阶段开始的 I/O 错误处理、单命令和会话磁盘预算，以及引用是否完整的标识。达到归档上限后的行为必须明确，不能继续向模型声称 `full output`。日志访问权限和排他创建应按 Forge 自己的宿主与会话边界处理。

## 验证

- Ran:读取固定 SHA 的 Bash、累加器、截断、Read、子进程等待实现及相关上游测试；逐项区分源码事实与推论；文档格式检查。
- Not run:上游运行时、上游测试、磁盘慢写或 ENOSPC 故障注入、模型请求。未下载依赖或落地临时源码。
- Risk:资源和失败边界来自源码分析，未运行复现；本次没有修改 Forge 运行时代码或将建议升级为决策。

## 后续决策

operator 在阅读本报告后确认将受会话管理的 Bash 输出归档纳入本批，包括懒落盘、有限预览、归档引用、写入背压、磁盘预算和失败元数据；替代此前不归档 Bash 截断前输出的范围。正式边界以 [ADR-012](../decisions/012-context-management-direction.md#存储升级与输出范围) 为准，存储及验收调整见 [设计稿](../phases/context-management.md)。配额数值、归档异常时命令是否继续等细节仍待收敛；该确认不表示代码已实现或 Pi 上游具有 Forge 的会话提交语义。

后续讨论长期磁盘增长后，operator 再次修订：Bash 完整输出采用系统临时目录中的应用管理日志，允许清理后过期，不随会话长期归档；会话消息、摘要及有限工具预览仍按既定契约保存。此前归档提交及永久日志引用的提案已被替代。具体清理时机、读取入口及资源上限继续收敛，最新规则以 ADR-012 为准。

## 后续核对：任务结束与退出清理

同一固定 SHA，扩大检索 coding-agent 源码中的 pi-bash/fullOutputPath、文件删除调用、tmpdir 及退出路径：默认实现没有按 invocation 结束删除 Bash 日志，也未找到针对该日志的退出删除、TTL 或启动清扫。文件仍在且路径可访问时，后续轮次或进程重开后仍可读取；这不是长期可用保证，系统或用户仍可清理文件。未核对任意第三方扩展及本机系统临时目录策略，不据此承诺删除期限。

- [OutputAccumulator.closeTempFile](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L121-L141) 只结束写流并等待 finish，没有 unlink。
- [AgentSession.dispose](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/agent-session.ts#L881-L898) 取消执行、断开监听并调用模型会话资源清理，没有 Bash 日志删除；本快照注册的模型资源清理是 [WebSocket sessions](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/ai/src/api/openai-codex-responses.ts#L931)。
- [交互退出路径](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3953-L3993) 执行宿主释放、终端恢复与退出，检索未发现针对 pi-bash 日志的清理注册。

因此 Forge 的“invocation 结束即清理”只是此前提出、尚未确认的更短生命周期建议，不是采用 Pi 方案的必然要求。本次为源码检查，未运行进程退出或系统重启实验。

operator 随后确认撤回该建议：不因 invocation 结束删除日志，保留后续轮次补查机会；退出清理或 TTL 等其余生命周期策略仍待决定。

最终确认清理策略也采用 pi 默认方向：Forge 不主动按任务结束或应用退出删除 Bash 日志，不设置 TTL 或启动清扫，由系统或用户清理；读取时检查可用性。此选择不保证累计磁盘占用有界，具体单命令资源上限和写入失败策略继续单独讨论。
