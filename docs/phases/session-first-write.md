---
doc_kind: plan
created: 2026-09-12
---

# 会话历史首次落盘职责收敛

> 状态:已完成本地实现与自动化验收(2026-09-12)。operator 已同意将首次落盘和后续追加集中到文件存储 module，保持现有保存与恢复行为，并要求提交本地 commit；未推送，未新增人工验收。

## Why / Entry

CLI `NewSessionStorage` 自行编码 v4 header 和首条记录，再打开 `SessionStore` 处理后续追加。同一文件格式、初始化与写入故障知识分散在宿主和存储中。现有[会话管理](session-management.md)、ADR-013/014 与 SDK 存储契约继续有效；不改变模型执行、CLI 选择或恢复规则。

## Design / Batches

- `SessionStore.create(path, cwd, id?)` 同步准备未落盘实例；`load()` 返回空历史，不创建目录或文件。稳定会话 id 在分配时确定，文件 header 时间在首次写入时确定。
- 首次 `append()` 与后续追加共用已有串行队列、重复 id/分支校验和故障停用。第一次以 `wx` 写入 header 与首条记录，成功后才更新内存历史与已保存状态；后续使用已有 append 行为，不自动重试失败写入。
- `saved` 表示本实例已成功创建或打开会话文件，不代表外部删除后文件仍存在，也不把写入成功升级为断电事务保证。
- `SessionStore.open()` 保留默认即时建文件、`create: false` 只读加载及损坏文件处理；新建文件的内部写入复用相同路径。`convertCopy()` 保留旧 header 的身份和时间，不改源文件。
- CLI 使用 `SessionStore.create()` 并读取 `saved`，删除 `NewSessionStorage` 及 CLI 内的 v4 编码与首写 I/O。项目路径、会话 id 分配、实例切换仍由 CLI 决定。
- 保留现有 `SessionStorage` interface；内存与文件是已有 adapter，不新增文件系统抽象或延迟存储转发 module。

## Acceptance / Verify

- [x] AC-SAVE-1：CLI 不再编码 header/首条 JSONL；空启动、只读加载、新建未输入均不创建会话文件。
- [x] AC-SAVE-2：首写成功可立即重载；串行追加顺序、分支和既有 v4 恢复不变，稳定 id 保留。
- [x] AC-SAVE-3：首写使用排他创建，不覆盖已有文件；首写和后续 I/O 故障均使实例拒绝后续追加，不重试或伪造成功。
- [x] AC-SAVE-4：CLI 首条输入保存成功后才进入模型请求；失败零模型调用，真实 CLI PTY 新建/恢复回归通过。
- [x] AC-SAVE-5：定向回归、反向验证、`bun run check` 和 `git diff --check` 通过。

## Release / Rollback / Risk

本轮本地交付代码与验证记录，不包含远端发布。CLI 接线与存储实现作为一个批次回退；不迁移或删除任何用户会话。最高风险是首写失败后仍继续写入，以及误改变默认 `open()` 或只读恢复行为；以临时真实文件系统中的冲突/故障和既有集成回归验证。不承诺崩溃恢复、跨进程写锁、断电原子性或真实 provider 验收。

## 验证证据

- Ran：改动前后相同的 session、session-conversion、session-host 定向测试均为 26 pass / 0 fail，覆盖默认打开、旧会话/分支/转换、空会话、首写失败及恢复。
- Ran：新增 `packages/core/test/session-first-write.test.ts` 的 6 项真实文件系统测试，覆盖延迟创建与首条重载、首写快照和排队追加、首写/后续相同校验、排他创建冲突、首次 I/O 失败及后续 I/O 失败后的停用。新增测试与 CLI session-host 合跑 11 pass / 0 fail。
- Ran：CLI 的本地模型 HTTP handler 在请求到达时读取会话文件，确认首条及恢复后的新输入已经落盘；既有首写故障场景保持零模型请求。
- Ran：反向验证临时将首次 `writeFile` 的 `wx` 改为 `w`，排他创建测试为 0 pass / 1 fail，命中原应拒绝的冲突写入返回成功；恢复后完整回归通过。注入只操作测试临时目录，未接触用户会话。
- Ran：最终 `bun run check` 成功，依赖门禁、五包与 automation 类型检查通过；514 pass / 0 fail，73 个文件、11643 次断言。包括真实 CLI PTY 空退出、清屏、新建、恢复、活动取消与重启，以及已有工具浏览与输入归属回归。`git diff --check` 通过。
- Ran：源码检查 CLI 不再包含 `NewSessionStorage`、v4 header 编码、`mkdir` 或 `writeFile`；中英文 SDK 指南与会话施工文档已同步。未增加依赖或改写 `SessionStorage` interface。
- Not run：外层终端人工体验、真实 provider、macOS/Windows 原生、断电/部分写入与远端 CI。
- Why / Risk：本轮为文件存储职责收敛，在 WSL 以真实临时文件及本地模型/PTY 验证；不将追加成功视为断电事务保证，不承诺自动故障修复。保留了原有非事务性 JSONL 和单写实例约束。
- 清理：临时基线、定向与完整检查日志已删除，验证结果保留于本节。
