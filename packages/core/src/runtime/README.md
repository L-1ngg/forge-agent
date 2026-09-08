# 本地 Agent 执行底座

> 状态：生产 SDK/CLI/TUI 共用的本地执行底座（2026-09-08）。规格：[Issue #15](https://github.com/L-1ngg/forge-agent/issues/15)，整体迁移：[Spec #14](https://github.com/L-1ngg/forge-agent/issues/14)。

来源为 `earendil-works/pi@9767ba275f3e9a5ee0f5c5342249b629ab1b2282` 的 `packages/agent/src/`。复制闭包只有 `agent.ts`、`agent-loop.ts`、`types.ts`、`stream-fn.ts`；原文件 SHA-256 见 `upstream.json`，版权及 MIT 许可见 `LICENSE`。`index.ts` 是本地聚合出口，不含 AgentHarness、coding-agent 或默认模型运行时。

## 构建适配

- 根包及 core 固定 `pi-ai@0.85.1`；core 直接声明 `typebox@1.3.7`。仍由调用方提供 `streamFn`，不引入 npm Agent。
- Forge 使用 `exactOptionalPropertyTypes` 与 `noUncheckedIndexedAccess`。独立基线 `3b4d961` 的运行语义不变；后续定制单列于 [local-changes.md](local-changes.md)。基线构建适配：可选属性类型显式容纳 `undefined`，已检查的尾消息索引增加非空类型标注，三个 pi-ai 对象边界增加纯类型断言。`compare-core.ts` 从独立基线提交读取源码，验证移除注释后的编译结果逐字一致；当前默认行为另与固定 oracle 差分。
- `test/runtime/agent.test.ts` 与 `agent-loop.test.ts` 来自同一固定提交，仅调整测试 runner 为 `bun:test`、本地 import、已验证索引的类型标注，以及 Bun 对不完整对象的 identity matcher 类型兼容。测试同受上述 MIT 许可覆盖。
- `check-deps.ts` 仅允许上述三个实际使用 pi-ai 的 runtime 源文件。检测全局阻塞调用使用 TypeScript AST，避免将 `Agent.prompt` 的方法声明误认为 UI 调用。
- Responses 补丁重新基于 0.85.1 发布文件生成，在 completed/incomplete 后退出。旧补丁不能直接按旧行号复用；HTTP 终态测试验证这一边界。

## 验证与复现

```sh
bun test packages/core/test/runtime packages/core/test/responses-terminal.test.ts
bun scripts/compare-core.ts /path/to/pristine/pi-checkout
```

对照 checkout 的 HEAD 必须为上述固定 SHA，四个源文件还会与 `git show` 核对。脚本临时隔离原版四文件，两侧使用相同的已锁定 pi-ai；不运行上游工作区的模型实现、不请求供应商。对照包含 25 组文本/推理/工具增量、prompt/continue、队列模式、准备与 hooks、串行/并行、stop/toolUse/error/aborted/length/deferred、事件与 idle 轨迹，只归一化时间戳。工具场景还断言实际执行次数，避免两侧同时失败造成假通过。

反向验证：临时将默认 parallel 分支改成 sequential，以 `--behavior-only` 跳过源码相等检查，行为比较在 `toolUse/all/false` 失败，显示第二个工具准备/启动相对第一个工具执行的顺序发生变化；恢复后 25 组通过。此参数仅跳过历史基线执行代码核对；默认命令同时检查历史基线与当前默认行为。

45 项移入的上游测试与 4 项 Responses 本地 HTTP 测试通过。依赖安装及 Bun 执行已验证；供应商真实请求、跨平台不由本基线验证。产品集成验证见 [迁移验收](../../../../docs/phases/pi-core-migration-acceptance.md)。原样基线独立提交后才开始接入修改；后续运行差异必须独立记录。
