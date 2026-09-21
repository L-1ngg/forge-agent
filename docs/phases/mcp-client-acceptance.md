---
doc_kind: acceptance
created: 2026-09-21
---

# MCP client 实现与验收证据

> 状态:代码实现与软件验证已完成(2026-09-21)。对应 [Issue #36](https://github.com/L-1ngg/forge-agent/issues/36)、[施工图](mcp-client.md)与 [ADR-022](../decisions/022-mcp-host-integration.md)。本记录对应基线 `e049505f1015623a334b50439daae15ce6e3479b` 上的本功能提交。operator 已在获知下述未测边界后明确要求“commit,push,且关闭issue”；按该最新指令交付并关闭任务，提交与关闭结果以 GitHub 记录为准。关闭不表示真实远程 OAuth/模型及 macOS 等未测项通过，也不发布软件版本。

## 实现落点

- `packages/core/src/mcp/`：每 Agent 的连接与不可变工具定义、官方传输/分页/schema/OAuth 接线、资源/模板/Prompt、逻辑订阅、凭据和附件 adapter。stdio 直接 PID 退出纳入清理；业务结果不明不重放。
- `AgentSession` 与 `session-storage.ts`：配置接受/应用屏障，Prompt 单 user 封套、输入归属、模型/预算/压缩的一致投影；保存失败沿用实例 faulted 语义。
- `session-tools.ts`：最终参数精确校验与既有权限、在 Pi provider payload seam 保留完整 MCP schema。资源模板参数改写后重新展开，授权与执行采用相同 URI。
- `packages/cli/src/mcp-command.ts`、`mcp-host.ts` 与 TUI：无需模型的管理入口、显式浏览器 OAuth、系统凭据、附件防覆盖导出、表单/URL 卡片、补全及会话释放。
- README/SDK 中英文指南与 `examples/mcp-client.ts`：可执行入口、默认值、错误码、存储与平台边界。

## Ran

| 证据入口 | 本轮可观察结果 | 对应规格范围 |
|---|---|---|
| `packages/core/test/sdk-mcp.test.ts` | stdio/HTTP × legacy/auto/pinned 六组合；真实 Pi→provider HTTP fixture→工具→续轮；权限拒绝零业务调用；复杂 schema/local refs/oneOf/开放属性且不 coercion；参数改写；整批工具配置屏障；Prompt 多角色单封套与恢复不重新抓取；form/url accept/decline/cancel；附件 bytes；错误 outputSchema；超时不重放且后续 turn 可用 | AC-01～09、11、16～20、22～23 |
| `packages/core/test/sdk-mcp-boundaries.test.ts` | 缺 env 部分失败；工具过滤与目录一致；双 Agent 权限/释放隔离；官方两页聚合、重复 cursor 有界、64 页上限；文本截断原 bytes 读回、二进制与总限额；归一化名称碰撞精确路由；Prompt 拒绝/预算/append 失败零模型请求；最终模板 URI 授权；401/403/503 不误降级 SSE；header 到达请求而未进入结果/目录 | AC-01～06、08～09、11～12、17、21～23 |
| `packages/core/test/sdk-mcp-legacy.test.ts` | 真正官方 v1.30.0 server 的 legacy SSE，读取、订阅通知、取消后忽略迟到通知，关闭 server/端口 | AC-02、10、21 |
| `packages/core/test/sdk-mcp-subscriptions.test.ts` | 现代订阅实际通知；远端流意外结束后重新 listen；同身份 reconnect 转接；unsubscribe 后无通知；listChanged 刷新目录且连接 generation 不变 | AC-04、10、19～21 |
| `packages/core/test/sdk-mcp-oauth.test.ts` | 受控 AS 的首次登录、state/issuer/deny、持久 store 重建 Agent、四个并发目录 401 只刷新一次、logout；忽略取消的 store write 持锁到真实结算；不合作交互取消后 close | AC-13～15、18、21～22 |
| `packages/cli/test/mcp.test.ts` | 配置同名整条覆盖与来源 cwd、JSON/task 原文；正式 CLI 无模型 status；附件重开/缺失/跨会话导出防覆盖；loopback state、Continue 非成功、重复 callback、端口关闭；参数错误 exit 2；生产 adapter 跨进程锁竞争 | AC-01、03、13～15、21、24、27 |
| `tests/tui-integration/mcp.test.ts` | 正式 CLI/PTY 目录→Prompt 权限与模型 fixture→工具权限→integer=7 表单→Ctrl+P park/恢复→续轮；Esc cancel；会话切换后新 MCP 连接 ready；退出恢复终端 | AC-11、16、21、24 |
| 现有 headless request 测试 | 请求类型覆盖 OAuth 24 与 MCP Elicitation 25，保守拒绝无交互请求 | AC-15～16 |

这些是软件合同证据，不是实际供应商模型质量、真实浏览器跨 WSL 回调或用户业务授权证据。官方分页对重复 cursor 停止遍历并返回已经聚合的项目；不断产生新 cursor 时 64 页上限报错，Forge 未实现第二套分页器。

### 外部样本与生产 adapter 探针

- `@modelcontextprotocol/server-filesystem@2026.8.31`（依赖官方 SDK 1.30.0）在本次临时目录安装，经 Forge 真正 stdio 发现工具、read_text_file 读取临时 sentinel，经过两次本地 provider HTTP fixture 请求续轮；捕获的直接 PID 已退出。没有读取用户文件，没有调用付费真实模型。临时安装和 fixture 已删除。
- 当前 Linux/WSL 的生产 `SystemMcpCredentialStore`，仅用唯一 synthetic service/account，显式 keyutils 跨进程 write/read/delete/确认 absent 通过，条目已删除。默认 system 明确返回 backend-unavailable，因为本机没有可用 Secret Service；没有静默 fallback。生产文件锁的跨进程串行另外纳入自动测试。
- 上述结论只覆盖当前 Linux/WSL 实例，未测试系统重启后的 keyutils 保留行为，不承诺任意 stdio 后代进程树回收。

### 反向验证

临时移除 manager 的 `authorize` 拒绝分支，执行 `bun test packages/core/test/sdk-mcp.test.ts -t 'permission refusal'`，因被拒绝的资源读取实际成功而退出 1；在 finally 中恢复原文件后同命令退出 0。故障代码未保留。证明该权限回归用例能检测绕过，不能推广为每个合同都已做变异测试。

### 全仓与示例

- `bun run check`：通过依赖边界、所有 workspace 类型检查、automation/tests 类型检查；contract **525 pass**（67 files）、integration **263 pass**（27 files）、正式 CLI/PTY **14 pass**（11 files），合计 **802 pass / 0 fail**。
- `bun run typecheck:examples`：通过。`bun examples/mcp-client.ts bun packages/core/test/helpers/mcp-server.ts`：实际 stdio 目录与资源读回成功，无模型请求。
- 双语 README/SDK、施工图/ADR/导航的本地 Markdown 文件链接与 `git diff --check`：通过。临时 debug/生产 adapter 探针文件及其临时安装已清理，原有设计与研究探针保留。全仓测试日志留在既有 `.test-results/`。

环境为 Bun **1.3.12**、Linux x64（WSL）。测试沿用 `scripts/test-offline.ts`：隔离 HOME/XDG、Linux network namespace，仅允许本地 fixtures。macOS fixture 兼容性不能等同 Linux OS 断网证明。

## Not run / Why / Risk

- **Linear 真实只读 OAuth**：没有可登录的账号/工作区及用户浏览器授权，没有访问用户业务数据。首次授权、真实 scope step-up、重启复用与 logout 的实际服务兼容仍未验收。fixture OAuth 与生产 loopback adapter 分别有证据，但不能替代真实授权链。
- **真实模型与实际 MCP 服务组合**：尚无本任务指定 provider/model 和费用授权；filesystem 样本使用本地模型响应 fixture。未证明真实模型对工具 schema、Prompt 多角色、资源/附件的任务表现。
- **macOS Keychain/平台、可用 Linux Secret Service、Windows/WSL 浏览器端到端回调**：当前只具备 Linux/WSL 环境；未将 native library 支持列表当作实测。
- **系统重启/任意进程树、凭据锁丢失后的真实系统崩溃场景**：未实测。锁丢失中止新提交、已启动 native 写保留结算责任是实现合同；当前自动测试覆盖跨进程竞争和迟到写入，不证明所有崩溃一致性。
- 配置持久化使用独占临时文件、保存前重新比较原文及 rename，拒绝已观察到的并发修改；任意不合作编辑器在最后比较与 rename 之间写入仍存在 TOCTOU 窗口，不承诺通用跨编辑器事务。

这些缺口继续保留在本验收记录与 Issue 关闭说明中；operator 最新指令允许在上述未测边界下关闭任务，不另拆交付批次，不将未测项标通过。运行时停用使用 `--no-mcp` 或 `mcp.enabled=false`；历史与附件保留。
