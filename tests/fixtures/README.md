# 测试 fixtures

`protocol.ts` 为手写协议 fixtures（非真实录制），适配 `@earendil-works/pi-ai@0.85.1`。版本及动态字段规则位于 `fixtureProvenance`；支持 Anthropic Messages 和 OpenAI Responses（当前以 xAI model catalog 选取该协议）。语义假模型与这些 HTTP 字节 fixtures 分开使用。

每个 HTTP exchange 声明 method/path、正文 matcher、状态码、headers、chunks、发送屏障及 close/disconnect/hold。消息、工具 schema、参数、调用身份和顺序属于断言；动态路由身份与 cache 字段不参与无关比较。测试按单字节写入 UTF-8/SSE 内容，但不声称服务端 enqueue 与客户端 TCP read 一一对应。需要观察到前半流的场景使用事件屏障。

普通测试只读取基线，无 record/update 模式，无 fixture miss 联网 fallback。维护时先说明触发变更的有效产品/协议契约、来源及 adapter 版本，再手工编辑 fixture，审查 Git diff、运行对应协议用例并做反向验证。真实样本将来加入时必须标明来源和采集版本，先删除认证 headers、凭据及私人消息，保持参数/身份关联，不可直接提交真实流量。
