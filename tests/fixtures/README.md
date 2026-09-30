# 测试 fixtures

共享受控响应统一位于本目录：`native-adapter.ts` 提供 TanStack 原生 adapter/chunks，`native-reply.ts` 提供声明式回复与请求分类，`native-request.ts` 经过生产 `callModel` 边界，`scripted-model.ts` 控制摘要/模型响应，`model-response.ts` 提供简单 Anthropic SSE。它们不实现 Agent 循环、历史或授权状态。跨包测试从这里导入，不在某个 package 的私有 helper 目录间接依赖。

真实 stdio MCP executable 继续位于 `packages/core/test/helpers/mcp-server.ts`，与原生/legacy SDK、CLI 和示例共享启动路径。协议与 cell golden 的版本来源保留；实验 v1/v2 数据仍有历史复算与 provenance 引用，不能按当前调用次数盲删。

`protocol.ts` 为手写协议 fixtures（非真实录制），适配 `@tanstack/ai-anthropic@0.19.1` 与 `@tanstack/openai-base@0.11.1`。版本及动态字段规则位于 `fixtureProvenance`；支持 Anthropic Messages 和 OpenAI Responses（当前以 xAI model catalog 选取该协议）。语义假模型与这些 HTTP 字节 fixtures 分开使用。

每个 HTTP exchange 声明 method/path、正文 matcher、状态码、headers、chunks、发送屏障及 close/disconnect/hold。消息、工具 schema、参数、调用身份和顺序属于断言；动态路由身份与 cache 字段不参与无关比较。测试按单字节写入 UTF-8/SSE 内容，但不声称服务端 enqueue 与客户端 TCP read 一一对应。需要观察到前半流的场景使用事件屏障。

普通测试只读取基线，无 record/update 模式，无 fixture miss 联网 fallback。维护时先说明触发变更的有效产品/协议契约、来源及 adapter 版本，再手工编辑 fixture，审查 Git diff、运行对应协议用例并做反向验证。真实样本将来加入时必须标明来源和采集版本，先删除认证 headers、凭据及私人消息，保持参数/身份关联，不可直接提交真实流量。
