# 持久记忆实验依据

> 状态:生效(2026-09-29)。当前整理合同见 [Issue #42](../../phases/memory-organizer-issue-42.md)，官方 deferred 接入的原验收见 [Issue #37](../../phases/tool-ecosystem-issue-37.md)。本目录保存可共享原始证据，不定义新的质量门槛。

## Issue #37 真实模型样例

原始报告为 [issue-37-samples.json](issue-37-samples.json)，对应 2026-09-28 的 xAI `grok-4.6`、10 个已有 v2 场景及 100 个供应商请求。样例结果、基线污染现象、模型费用与未测边界统一见[原验收记录](../../phases/tool-ecosystem-issue-37.md#真实模型样例)。它不是新盲测，也不证明后来 #39/#42 的实现有效。

2026-09-29 从记录中的 `/tmp/forge-issue37-memory-samples.json` 原样保存，未重新调用模型或改写回答、笔记、失败和路径。核对来源如下：

| 字段 | SHA-256 |
|---|---|
| 完整原始文件 | `25eee9b4ea541fd6765e33a0a2b2406fec6be35ca1fd5fbe1c18d5c5524d4e80` |
| `fixtureHash` | `2e93bdf70996b3f8d0d8724651e83c977731f2d8eb1671f2b618db5bad83070d` |
| `implementationHash` | `3c4b77f93524fa85125984d37406396f99dd7e850c9b009b158245f8d10cf943` |
| `harnessHash` | `e11e580cd2a884f4111c0c6260fa0800ae1d5c19b7dc6d1d813a4e1679f226e2` |

原报告中的临时会话和记忆路径只表示实验当时的位置，不承诺能重新打开。旧 Issue #32 的会话内方案及 v1/v2 数据见[历史验收](../../archive/research/persistent-memory/acceptance.md)。`scripts/memory-quality.ts` 是随当前实现维护的显式付费实验入口，直接运行它会产生新证据，不会恢复旧实验。
