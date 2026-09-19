---
doc_kind: plan
created: 2026-09-10
---

# 软件测试体系：规格与施工入口

> 状态:已完成（2026-09-19 核对）。[Issue #33](https://github.com/L-1ngg/forge-agent/issues/33) 已于 2026-09-18 关闭；需求规格与任务状态以该 Issue 为准。实际设计、执行入口、Linux 网络隔离与 macOS fixture 兼容性验收证据见 [施工记录](testing-system-implementation.md)。

## 已确认的目标与边界

用户希望为项目建立可信、可复现、维护成本可控的工程测试体系。2026-09-17 参考 [operator 文章](https://l1ngg.info/posts/tech/agent-testing-architecture/)及成熟方案调研，按 `to-spec` 整理为 Issue #33。范围、实现选择、测试边界及任务级验收以该 Issue 为准，不在本文件复制 AC。

规格采用保留 Bun、复用现有假模型与 fast-check、补强本地 HTTP/SSE 和薄测试支撑层的方向。选择来源与测试边界见 Issue 的 Testing Decisions，实际实现与验证结果见施工记录。通用测试术语不加入只维护 Forge 领域概念的 CONTEXT.md。

## 规格阶段的事实与证据（2026-09-17）

- `package.json`：使用 `bun test`；`bun run check` 组合依赖边界检查、类型检查与测试。静态检查与运行测试是不同的验证手段。
- 测试既分布在 `packages/*/test/`，也分布在根目录 `tests/` 和 `scripts/*.test.ts`；目录位置本身不足以判断测试边界。
- `packages/cli/test/session-preview.test.ts` 通过真实会话文件验证预览和缓存；`tests/tui-integration/session-management.test.ts` 启动正式 CLI，通过 PTY 驱动交互并使用本地模型响应。
- `scripts/test-headless.ts` 使用受控执行端口调用 CLI 入口，检查正常退出；它不能独立证明真实供应商连接正确。
- 2026-09-17 核对：`createPiTestPort` 已使用 fauxProvider；`provider-replay` 使用手写 SSE 报文，不是自动录制器；`abort.property` 的部分随机测试只验证测试侧模型，另有真实执行端口的取消用例，两类证据不能混同。
- 以上为规格阶段的文档、源码与候选资料核对；该阶段未重新执行测试、统计稳定性或测量分组耗时。后续实施的运行证据单独保存在施工记录中。

## 与现有决策的关系

- ADR-006/007 当前约束：TUI 使用 cell 回归及仓库内 golden，不以 PNG 零差异为硬门禁，不编译 grok-build 作为测试前置。若候选方案改变这些原则，需明确重新讨论，不能用目录整理隐式替代。
- ADR-010/013/014 的有效输入归属与保存契约、ADR-015 的内核接入边界，以及当前上下文/记忆合同，是测试应保护的产品行为；以当前 SDK 指南和 ADR 替代关系为准，不恢复旧的整次 invocation 取消回滚规则。
- SOP 要求与改动相称的验证、反向验证及区分自动化/人工证据。运行分组、测试支撑、失败报告及维护要求见 Issue #33。

## 施工与验收入口

实际模块组织、分批迁移、平台隔离机制、验证证据和回退方式统一维护在 [确定性测试体系施工与证据](testing-system-implementation.md)，通过 Issue 链接及 AC 编号关联验收；本文件保留规格入口与历史依据，不另建一份施工记录。

Scenario 资源结算的后续改进见 [Issue #34 施工记录](architecture-responsibilities.md#b5)。自动化软件验证、真实供应商测试和人工验收仍分别报告；具体已测与未测边界以对应施工记录为准。
