# SDK StreamFn 接入

> 状态：已实现并通过本地离线验证（2026-09-20）。operator 已明确授权直接采用 Pi Agent 的 StreamFn 设计；模型定制统一使用 StreamFn，外部执行 factory 已删除。接入合同见 [SDK](../sdk.md#自定义模型流streamfn)。

## 设计

- 复用本地 `runtime/types.ts` 中固定 Pi 基线的 `StreamFn`，不复制另一套流协议，不升级 pi-ai 或迁入新版 system transcript。
- `createAgent` 接受完整 `model: Model<string>` 与 `streamFn`；完整模型必须配套流函数，绕过内置 catalog/auth，provider 以模型对象为准。字符串模型仍由 `provider + model` 查 catalog；提供流函数时由宿主负责认证，未提供时沿用 builtinModels。
- SDK 导出 `Model` 与 `StreamFn` 类型。自定义函数接收模型、最终请求上下文及 `SimpleStreamOptions`，可以同步返回事件流，也可以返回 Promise。请求失败与取消按 Pi 契约通过流终态表达，函数负责响应 signal。
- 任务、恢复重试和压缩摘要统一使用同一生效配置的 `streamFn`。显式 apiKey、sessionId、signal、maxTokens、reasoning 等通过请求 options 传递；摘要继续使用独立预算与 cacheRetention=none。宿主自行加载的动态认证也可在函数中处理。
- `updateConfiguration` 支持模型对象和流函数，在现有完整批次/摘要结束后一起应用；`streamFn: null` 恢复内置传输（要求字符串模型）。模型对象在异步创建和配置准备前快照，失败配置不污染当前配置。
- 不开放其他 hook，不改变权限、工具执行、输入归属或最终结算。保持默认 CLI 和 SDK 的模型选择路径。

## 验收与验证

- [x] AC-1：公共 SDK 使用未知模型与异步 StreamFn 完成真实会话路径，包括工具权限、结果持久化和下一轮请求。
- [x] AC-2：手动压缩与任务使用同一函数，保留请求参数及摘要结果处理；流错误、取消经过既有结算路径。
- [x] AC-3：活动批次/摘要期间更新模型与函数延迟生效；快照隔离和失败更新保持旧配置。
- [x] AC-4：字符串模型注入跳过内置认证，恢复内置传输和既有默认路径通过；SDK 双语说明和可编译示例一致。
- [x] AC-5：相关测试、完整 check、示例类型检查通过；反向破坏摘要路由或异步等待时对应测试失败。

第一批验证记录（新增 StreamFn、尚未删除 factory；2026-09-20，Bun 1.3.12，Linux）：

- Ran：`bun test packages/core/test/runtime-stream-fn.test.ts`，8 项通过；`bun run check`，依赖门禁、workspace/automation/tests 类型检查及 713 项测试通过（contract 537 / integration 163 / CLI-PTY 13，JUnit 均为 0 failure）。完整测试使用 network namespace，外网阻断探针通过。
- Ran：`bun run typecheck:examples`；`bun examples/custom-stream.ts` 输出注入流的回答及 `Result: success`；`git diff --check`。
- 反向验证：临时移除摘要路径 `await options.streamFn(...)` 的 await，`summary awaits` 用例检测到配置提前生效并失败；恢复后完整检查通过。
- Not run / Why：真实供应商、自定义生产网关和 macOS；本项以本地可控流及 HTTP fixtures 验证接入契约，不调用生产服务或跨平台环境。
- Risk：离线通过不代表具体宿主传输与生产模型兼容。StreamFn 由宿主保证 Pi 流终态、signal 和重试契约，生产接入还需对应供应商验证。

## 单一装配入口（2026-09-20，operator 已授权实施）

删除 `createAgent` 的第二参数及 CLI SessionHost 的 factory 透传。`createAgent(options)` 始终装配生产会话；模型定制只使用 `streamFn`，存储使用 `storage`，工具使用 `tools`。`createAgent` 的 JavaScript 多余实参在启动前报错，避免旧调用静默启动默认传输。

迁移所有用于模拟模型的 factory 测试及 PTY/headless fixtures；模型 fixture 只返回模型元数据和流函数，不返回执行实例。删除仅验证外部执行实例能力缺失的过时测试。保留存储故障、取消、输入回执、恢复、工具副作用及压缩持久化的验收，用各自专门接口注入。内部会话/压缩单元测试可直接测试内部模块，但不能作为公共 SDK 的替换入口。

- [x] AC-6：公共 SDK/CLI 不再接受外部执行 factory，正常调用只能经过生产装配。
- [x] AC-7：旧模型模拟测试迁移完成，无隐藏的替代 factory；输入、存储、工具和终态相关覆盖继续通过。
- [x] AC-8：双语 SDK、装配文档同步；全仓检查、PTY/headless smoke、示例及反向验证通过。

第二批验证记录（删除 factory 后的最终状态；2026-09-20，Bun 1.3.12，Linux）：

- Ran：`bun run check` 通过，包含依赖边界、workspace/automation/tests 类型检查及 689 项测试（contract 513 / integration 163 / CLI-PTY 13，均为 0 fail）；Linux network namespace 外网阻断探针通过。数量减少来自原装配文件的 28 项测试替换为 4 项当前合同测试。
- Ran：`bun run test:headless` 通过，真实 CLI 装配访问本地 HTTP fixture，返回 `replay ok` 和 `agent_end: success`；`bun run typecheck:examples`、`bun examples/custom-stream.ts`（`Result: success`）、`git diff --check` 通过。
- 反向验证：临时移除 `createAgent` 的实参数量检查，旧第二参数拒绝用例按预期失败（Promise 被 resolve）；finally 恢复源码后，装配测试 4 pass / 0 fail。
- 静态核对：SDK/CLI 无 `portFactory`、`PortFactory` 或旧装配 helper；AST 检查唯一多实参 `createAgent` 调用是验证拒绝旧 API 的负例。包入口不导出内部 `createSessionPort`、测试夹具 `createTestPort` 或执行类型；底层循环测试的直接会话 fixture 位于 `tests/support/test-port.ts`，复用仅提供模型流的 `fauxModel`。
- Not run / Why：真实供应商、自定义生产网关、macOS 和人工 TUI 验收未执行；本次验证使用 Linux 离线流及本地 HTTP/PTY fixtures。
- Risk：这是明确授权的 API 收紧，旧 factory 接入必须迁移到 `streamFn`、`storage` 或 `tools`；具体生产传输兼容性仍需宿主验证。

## 发布与回退

本次本地交付，operator 已于 2026-09-20 授权提交；不推送或执行远端发布。回退本项 SDK/装配改动即可，未更改存储格式。真实网关、供应商及跨平台验证另行记录，不从离线测试推导这些结论。
