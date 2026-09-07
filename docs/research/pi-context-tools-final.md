# Pi 工具输出与历史查回最终对齐核对

> 状态:调研完成(2026-09-07)。固定源码事实供本轮方案整理引用；不表示 Forge 运行时代码已经实现。

## 范围

固定快照为 `earendil-works/pi@9767ba275f3e9a5ee0f5c5342249b629ab1b2282`，核对 coding-agent 内置工具与其使用的 agent loop。用户本轮要求剩余上下文策略直接对齐 Pi。本文件记录工具结果、Bash 日志及历史查回的证据，不重新解释摘要和持久化决策。

## 可直接采用的行为

| 事项 | Pi 固定快照行为及对齐含义 | 源码 |
|---|---|---|
| Read 文本预览 | 从指定 `offset` 开始，先应用可选 `limit`，再保留开头最多 2000 行 / 50 KiB，任一先达到即截断；附继续读取的 offset | [read.ts:127-177](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/read.ts#L127-L177) |
| Read 单行过长 | 首行单独超过 50 KiB 时不返回该行片段，而返回尺寸与 Bash 分段读取提示 | [read.ts:152-156](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/read.ts#L152-L156) |
| Bash 预览 | 保留末尾最多 2000 行 / 50 KiB；通常保留完整行，最后一行单独过长时保留该行末尾的 UTF-8 完整字符片段 | [truncate.ts:168-261](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/truncate.ts#L168-L261)、[bash.ts:316-333](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L316-L333) |
| Grep | 默认 100 个匹配，`limit` 可调整；每条正文先取前 500 个 JavaScript 字符单位再加截断提示；最终按 head 保留 50 KiB，不另加 2000 行上限 | [grep.ts:135-136](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/grep.ts#L135-L136)、[grep.ts:263-303](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/grep.ts#L263-L303)、[truncate.ts:268-275](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/truncate.ts#L268-L275) |
| Find | 默认 1000 条结果，`limit` 可调整；最终按 head 保留 50 KiB，不另加 2000 行上限；提示增加 limit 或收窄查询 | [find.ts:199](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/find.ts#L199)、[find.ts:275-292](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/find.ts#L275-L292) |
| Ls | 默认 500 条，`limit` 可调整；先按不区分大小写的字母顺序排序，目录加 `/`，最终按 head 保留 50 KiB，不另加 2000 行上限 | [ls.ts:84](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/ls.ts#L84)、[ls.ts:108-155](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/ls.ts#L108-L155) |
| 自定义工具输出 | 工具作者负责截断、声明限额及告诉模型如何获取更多内容；导出 head/tail/line 截断函数供复用，内核没有统一补做单结果 token 截断 | [官方扩展文档:2170-2220](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/docs/extensions.md#L2170-L2220)、[agent-loop.ts:784-797](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L784-L797) |
| 整批工具结果 | 正常路径按工具调用顺序组装结果，不按当前 context 窗口给整批结果再分配一个统一 token 额度；自定义 hook 可修改结果，但不是默认限额 | [并行结果组装:547-560](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L547-L560)、[afterToolCall:720-764](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts#L720-L764) |
| 模型历史查回 | 默认内置工具没有 `read_context`，也没有按 message id 分页查回任意旧消息的专用工具；本轮对齐不新增这类默认模型工具 | [完整工具名称与工厂:95-192](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/index.ts#L95-L192) |
| Bash 日志读取入口 | 截断结果给普通文件路径，使用 Read 的 `path/offset/limit` 或 Bash 搜索、选段；不新增 session 归档句柄或临时源专用模型 API | [bash.ts:320-330](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L320-L330)、[read schema](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/read.ts#L14-L18) |

50 KiB 的准确值为 `50 * 1024` bytes。以上主要是文本正文预览的限制，不是完整 toolResult 序列化大小的严格上限：截断通知、路径和错误状态在截断后添加，Read 图片走独立附件处理，不适用同一个文本限额。`truncateLine` 的 500 使用 JavaScript `length/slice`，不能解释为 500 bytes 或严格 500 个 Unicode 码点。[默认值](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/truncate.ts#L11-L13)、[图片路径](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/read.ts#L109-L125)。

Grep 的匹配数限制会停止 rg；Find 默认通过 `fd --max-results` 限制产出。它们的字节限制主要在收集与格式化之后生效，不能据此声称整个工具只分配 50 KiB 内存。Grep 请求前后文时会读取并缓存相关完整文件，Ls 也先读取完整目录再筛选。[Grep 匹配停止](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/grep.ts#L217-L239)、[Grep 文件缓存](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/grep.ts#L147-L160)、[Ls readdir](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/ls.ts#L99-L118)。

“没有默认历史查回工具”不意味着历史被删除，也不禁止宿主、扩展读取 session。它只限定模型默认工具面，不等价于此前 Forge 所提的稳定原文引用、分页读取和 reload 后可用性契约。是否暴露额外工具由宿主扩展决定，不能将扩展能力当成 Pi 内置默认。

## Bash 日志与异常

| 事项 | 固定快照事实 | 源码 |
|---|---|---|
| 合并形式 | stdout 和 stderr 都调用同一个 onData，再进入一个累加器；保留宿主收到的回调顺序，没有流标签或两个独立日志 | [bash.ts:120-122](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L120-L122)、[handleData](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L300-L303) |
| 懒落盘 | 阈值内保存原始 chunks；超过行数、原始字节或解码字节阈值后创建日志，写入此前全部 chunks、当前及后续 chunks；清空旧 rawChunks | [append](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L64-L77)、[触发与创建](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L205-L220) |
| 路径 | `os.tmpdir()/pi-bash-<16 hex>.log`，8 随机 bytes；不放 session 归档目录 | [路径](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L19-L22)、[前缀](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L375-L383) |
| 日志配额 | 累加器不设单日志或累计磁盘配额，也没有配额耗尽分支；不能推导出“超配额后保留预览并继续”的默认行为 | [累加器配置](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L7-L11)、[写入与触发](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L64-L77) |
| 收尾 | finish decoder，产生最终 snapshot，调用 stream.end 并等待 finish；没有 fsync，也没有此处 unlink；更广清理调查见既有报告 | [finishOutput](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L306-L313)、[closeTempFile](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L121-L141)、[既有清理核对](pi-bash-output-archive.md#后续核对任务结束与退出清理) |
| 非零退出、timeout、abort | 已捕获数据先 finish；错误字符串含预览、可用的 full output 路径以及状态。成功才返回正常结构化 details；这些错误不自动构成“日志坏了但命令继续”的恢复策略 | [bash.ts:338-366](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L338-L366) |
| 其他执行异常 | 尝试 finish 后重新抛原异常，不保证最终错误文本附有预览和日志路径 | [bash.ts:348-358](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L348-L358) |
| 写流错误 | closeTempFile 等待阶段监听 error 并 reject；创建和持续写入阶段没有立刻安装同样的监听处理，不能声称所有 ENOSPC、权限或早期写流错误都会优雅变成工具结果并保持命令运行 | [创建](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L211-L220)、[结束时错误处理](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L129-L140) |
| 背压 | 未检查 stream.write 返回值，未等待 drain；tail 缓冲约 100-200 KiB 不限制写流队列、单输入块和临时字符串占用 | [写入](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L57-L77)、[tail 裁剪](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/output-accumulator.ts#L148-L193) |
| Read 日志内存 | offset/limit 只限制模型可见部分；默认先 readFile 读全文件，再 decode、split 和 slice，每次分页请求都可能再次完整读入 | [Read 默认操作](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/read.ts#L44-L48)、[Read 文本实现](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/read.ts#L127-L150) |

“完整输出”限定于累加器实际捕获的数据，并不保证被取消进程尚未产生的输出、两个流的原始跨流顺序，或无限追踪后台后代。已有报告给出了子进程 stdio 收尾证据。[捕获生命周期说明](pi-bash-output-archive.md#失败和资源边界)。

## 本轮方案整理边界

对齐 Pi 意味着移除尚待实现的 core 单结果及整批 token 额度、默认 `read_context` 与通用遗漏正文归档，改用工具自身限额和普通文件查读。此前消息持久化及摘要记录仍由相关 ADR 管理，不因取消模型历史工具而删除历史记录。Bash 不增加日志配额、TTL、主动清扫或专用 I/O 降级状态机，不承诺资源严格有界；已有 Bash 临时日志生命周期决策继续适用。

这些是依据用户本轮授权整理方案可采用的行为，不是要求逐行复制上游的实现缺陷。尤其不能把“未发现优雅处理”改写成一个未经确认的新正常结果，也不能把源码注释的 bounded memory 扩大为包括写流队列和查读内存的运行保证。

## 验证

- Ran:直接获取固定 SHA 的工具、截断、累加器、agent-loop、工具工厂及官方扩展文档；对照既有 Bash 清理报告；文档空白、末尾换行和相对链接检查。
- Not run:Pi 实际运行、上游测试、ENOSPC 或慢盘故障注入、真实模型请求；本次只新增调研文档，没有修改 Forge 运行代码。
- Why:任务是已授权的方案收敛，源码足以确认默认截断和 API 边界；磁盘错误传播及宿主进程存活的准确运行行为需要独立实验。
- Risk:Pi 不提供完整的累计磁盘、背压和分页读取内存保证；第三方扩展可替换默认工具或结果，不能将本结论推广为所有 Pi 配置的行为。
