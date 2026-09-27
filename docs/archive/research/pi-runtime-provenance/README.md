---
doc_kind: historical
archived: 2026-09-27
superseded_by: ../../../phases/tanstack-foundation.md
---

> 历史记录：Pi 执行内核已由 TanStack `chat()` 替代，以下“当前”与验证结果属于当时版本；旧源码、测试和差分脚本只可在历史提交复现。当前执行合同见 [TanStack 基座](../../../phases/tanstack-foundation.md)，本目录只保留来源、合法许可与历史行为证据。

# 本地 Agent 执行底座

> 状态：生产 SDK/CLI/TUI 共用的本地执行底座（2026-09-08）。规格：[Issue #15](https://github.com/L-1ngg/forge-agent/issues/15)，整体迁移：[Spec #14](https://github.com/L-1ngg/forge-agent/issues/14)。

来源为 `earendil-works/pi@9767ba275f3e9a5ee0f5c5342249b629ab1b2282` 的 `packages/agent/src/`。复制闭包只有 `agent.ts`、`agent-loop.ts`、`types.ts`、`stream-fn.ts`；原文件 SHA-256 见 `upstream.json`，版权及 MIT 许可见 `LICENSE`。`index.ts` 是本地聚合出口，不含 AgentHarness、coding-agent 或默认模型运行时。

## 构建适配

- core 声明 `typebox@1.3.7`；模型传输、目录和事件类型由 Forge 与 TanStack AI 提供，根包及 core 均不依赖 `pi-ai`。仍由调用方提供 `streamFn`，不引入 npm Agent。
- Forge 使用 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`。独立基线 `3b4d961` 的运行语义不变；后续定制单列于 [local-changes.md](local-changes.md)。`compare-core.ts` 从独立基线提交读取源码，核对当时的编译结果；当前 Core 与固定 oracle 另做行为差分，不要求当前编译结果与原版逐字相同。
- `test/runtime/agent.test.ts` 与 `agent-loop.test.ts` 来自同一固定提交，仅调整测试 runner 为 `bun:test`、本地 import、已验证索引的类型标注，以及 Bun 对不完整对象的 identity matcher 类型兼容。测试同受上述 MIT 许可覆盖。
- `check-deps.ts` 拒绝各 workspace 包以及脚本和示例中的 `pi-ai` import，并用 TypeScript AST 检测全局阻塞调用。
- 当前 Responses 传输使用 TanStack adapter；历史 `pi-ai` Responses 补丁已移除。HTTP 终态由当前传输测试验证。

## 验证与复现

```sh
bun test packages/core/test/runtime packages/core/test/openai-stream.test.ts
bun scripts/compare-core.ts /path/to/pristine/pi-checkout
```

对照 checkout 的 HEAD 必须为上述固定 SHA，四个源文件还会与 `git show` 核对。脚本临时隔离原版四文件，两侧注入相同的本地脚本流；不请求供应商。对照包含 25 组文本/推理/工具增量、prompt/continue、队列模式、准备与 hooks、串行/并行、stop/toolUse/error/aborted/length/deferred、事件与 idle 轨迹，只归一化时间戳。工具场景还断言实际执行次数，避免两侧同时失败造成假通过。

反向验证：临时将默认 parallel 分支改成 sequential，以 `--behavior-only` 跳过源码相等检查，行为比较在 `toolUse/all/false` 失败，显示第二个工具准备/启动相对第一个工具执行的顺序发生变化；恢复后 25 组通过。此参数仅跳过历史基线执行代码核对；默认命令同时检查历史基线与当前默认行为。

45 项移入的上游测试与 4 项 Responses 本地 HTTP 测试通过。依赖安装及 Bun 执行已验证；供应商真实请求、跨平台不由本基线验证。产品集成验证见 [迁移验收](../../phases/pi-core-migration-acceptance.md)。原样基线独立提交后才开始接入修改；后续运行差异必须独立记录。
