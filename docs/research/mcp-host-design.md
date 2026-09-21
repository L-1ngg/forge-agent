---
doc_kind: note
created: 2026-09-21
---

# MCP OAuth 凭据方案与验收样本探针

> 状态:设计验证记录(2026-09-21)，不构成 Forge 产品验收。设计见 [MCP 施工图](../phases/mcp-client.md)。

日期：2026-09-21；环境：Bun 1.3.12（700fc117），Debian 13，Linux 6.18.33.2-microsoft-standard-WSL2。

## 选择

采用 `@napi-rs/keyring@2.1.0` 的 `AsyncEntry`，不选 Bun.secrets 作为默认。默认 system：Linux 显式 `store: "secret-service"`，macOS 使用原生 Keychain。额外提供用户显式选择 `linux-keyutils`，用于当前没有 Secret Service daemon 的 WSL：能跨 Forge/Bun 进程保存，但系统/WSL 重启会丢失并需重新登录。不能默认/静默退到 keyutils，也不能称其为磁盘持久化。原生 Windows 不新增支持承诺。

该第三方依赖相对 Bun 内建 API 的实际收益是显式内核 keyring 后端令当前 WSL 无需安装 daemon 也可完成跨进程登录使用；Linux Secret Service 支持采用 vendored DBus（不用 libsecret，但仍要服务）。Bun.secrets 官方且零额外依赖，但官方仍标 experimental、仅 Linux libsecret/Secret Service 路径，当前环境不能用；若取消无 daemon WSL 的显式选项，Bun.secrets 会更省依赖。

## 当前环境结果

- DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR 存在，但 `busctl --user --no-pager status org.freedesktop.secrets` 返回 `Failed to get credentials: No such device or address`。
- `Bun.secrets.set` 对随机唯一 synthetic service/name 返回 `ERR_SECRETS_PLATFORM_ERROR: libsecret not available`；没有成功写入；delete 也返回 backend 错误。
- `new AsyncEntry(service,name,{linux:{store:'secret-service'}})` 返回 `Platform failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files`，构造失败，没有写入。
- 显式 keyutils：synthetic set/get/delete 通过；单独写入进程退出后，另一个 Bun 进程仍读取一致；删除后为 null，二次删除 false。
- `proper-lockfile@4.1.2` 在 Bun 双进程探针通过：持锁时第二进程 ELOCKED；释放后第二进程获取成功；结束 `check=false`。
- 没有列举/读取现有用户凭据、没有登录、没有安装或启动系统服务。所有 synthetic keyring 项已删除；临时依赖安装目录及 synthetic 条目均已清理。

## 确定 API 与失败合同

```ts
import { AsyncEntry } from '@napi-rs/keyring';
const entry = new AsyncEntry(service, name, { linux: { store: 'secret-service' } });
// 可显式选择 { linux: { store: 'keyutils' } }；macOS 忽略 Linux options。
await entry.setPassword(serializedRecord, signal);
const value = await entry.getPassword(signal);
await entry.deleteCredential(signal); // boolean；false 表示无该条目，后端失败应 reject
```

`AsyncEntry.getPassword` .d.ts 声明 `Promise<string | undefined>`，但当前 Linux keyutils 缺项实测为 `null`；Forge 适配用 `value == null` 归一，不能把 backend error 当缺项。构造也会抛错。后端不可用/锁定/拒绝/超长/写失败均是可见认证存储失败，不写项目文件、不自动改 backend；在完成 token 持久记录写入前不能宣称登录成功。keyutils 不是跨重启承诺，系统 Secret Service/Keychain 的重启持久由系统后端提供，当前没有本机证据。

凭据按 issuer、server/resource、authContext 等完整身份建立稳定 key（短 hash 用于 entry name/lock 路径，明文源配置不含 token）。access token、refresh token 与 token expiry 保存在单条 opaque record，刷新产生的新旧 token 必须成组替换；client registration 随相同授权上下文持久，不能每启动重新注册。不要日志化记录正文。SDK 可注入存储与交易边界；共享凭据上下文的宿主需要提供跨其真实并发范围的串行 transaction。

使用 `proper-lockfile@4.1.2` 对同一 grant 的读取→二次检查过期→SDK refresh→整条写入做 keyed transaction。锁路径仅含 hash 标识，无秘密。所有进程使用统一 stale/update；读取、刷新、登出不能跨过同一互斥。建议实际 onCompromised 显式结算/取消当前认证操作，不能采用默认 throw 杀整个进程。库不能检测手工删锁后重新获取、不同 stale/update 值导致的冲突；本次只测正常竞争/释放，未测 stale reclaim/SIGKILL/存储取消，需要实现验收补足。

## 真实远程 OAuth 样本

首选 `https://mcp.linear.app/mcp/readonly`，仅申请 `read` scope。Linear 官方文档说明 Streamable HTTP + OAuth 2.1 + Dynamic Client Registration，readonly 路径只暴露读工具；不需要事先为 Forge 手工创建 OAuth app。需要 operator 能登录的 Linear 账号/工作区，并允许第三方连接；浏览器 loopback callback 可达。可用 operator 指定的一条测试 Issue 或项目作只读检索/读取与模型续轮，不创建/更新内容。

2026-09-21 对公开 metadata GET 的实时核实（未注册 client、未授权）：

- `https://mcp.linear.app/.well-known/oauth-protected-resource/mcp/readonly` 返回 resource 同 readonly URL，authorization_servers `["https://mcp.linear.app"]`，scopes_supported `["read"]`。
- `https://mcp.linear.app/.well-known/oauth-authorization-server` 返回 issuer、authorization/token/register endpoints，S256，grant_types 含 authorization_code 与 refresh_token，token_endpoint_auth_methods 含 none，亦支持 CIMD。

选定验收动作：登录→只读 list/read→退出 Forge→重启使用保存授权→登出清除本地 grant；refresh/cancel/错误 state/issuer 等确定性分支由受控 fixture 验证，不能强制等真实 token 过期。实际 OAuth/模型调用尚未执行，账号授权仍须 operator 完成。

备选 Notion `https://mcp.notion.com/mcp` 亦支持 DCR 与刷新，需 Notion 登录/工作区许可，但默认可读写，因此首选明确 readonly 的 Linear。Notion 官方特别强调 refresh rotation 需跨进程互斥、保存新 refresh token，invalid_grant 停止重试；可作为互斥设计的真实服务先例。Notion 文档有旧版 SDK 示范和协议手写例子，只用于理解服务合同，不复制其代码作为 Forge 协议实现。

## 一手来源

- Bun Secrets API / experimental / OS backend / limitations：https://bun.com/docs/runtime/secrets.md
- keyring README / 明确 backend options / keyutils 不跨重启：https://github.com/Brooooooklyn/keyring-node/blob/main/README.md
- keyring Cargo 依赖及 backend：https://github.com/Brooooooklyn/keyring-node/blob/main/Cargo.toml
- npm 发布版：https://registry.npmjs.org/@napi-rs%2fkeyring/2.1.0
- proper-lockfile API / compromised / mtime：https://github.com/moxystudio/node-proper-lockfile/blob/master/README.md
- Linear MCP 官方文档：https://linear.app/docs/mcp
- Linear readonly resource metadata：https://mcp.linear.app/.well-known/oauth-protected-resource/mcp/readonly
- Linear AS metadata：https://mcp.linear.app/.well-known/oauth-authorization-server
- Notion custom MCP client / DCR / rotation：https://developers.notion.com/guides/mcp/build-mcp-client

## 可复现 probe

在独立临时目录执行 `bun add --exact @napi-rs/keyring@2.1.0 proper-lockfile@4.1.2` 后 `bun run probe.ts`。只操作随机唯一 synthetic credential；不调用 findCredentials。

```ts
import { AsyncEntry } from '@napi-rs/keyring';
import lockfile from 'proper-lockfile';
import { rm } from 'node:fs/promises';

const service = 'forge-mcp-design-probe-' + crypto.randomUUID();
const name = 'synthetic-cross-process';
const value = 'synthetic-not-a-credential';
const entry = new AsyncEntry(service, name, { linux: { store: 'keyutils' } });
const writerCode = `import {AsyncEntry} from '@napi-rs/keyring';
  const e = new AsyncEntry(process.env.FORGE_PROBE_SERVICE, '${name}', {linux:{store:'keyutils'}});
  await e.setPassword('${value}'); console.log('writer saved synthetic value');`;
try {
  const writer = Bun.spawn([process.execPath, '-e', writerCode], {
    env: { ...process.env, FORGE_PROBE_SERVICE: service }, stdout: 'pipe', stderr: 'pipe',
  });
  const writerExit = await writer.exited;
  console.log(JSON.stringify({ writerExit, readAfterWriterExited: (await entry.getPassword()) === value }));
} finally {
  console.log(JSON.stringify({ deleted: await entry.deleteCredential(), absent: (await entry.getPassword()) == null }));
}

const lockTarget = import.meta.dir + '/synthetic-lock-' + crypto.randomUUID();
await Bun.write(lockTarget, 'synthetic lock target without credentials');
const options = { stale: 30000, update: 10000, retries: 0, onCompromised: (e: Error) => { throw e; } };
const childCode = `import lockfile from 'proper-lockfile';
try {
  const release=await lockfile.lock(process.env.FORGE_PROBE_LOCK_TARGET, { stale:30000,update:10000,retries:0 });
  console.log(JSON.stringify({acquired:true})); await release();
} catch(e) { console.log(JSON.stringify({acquired:false,code:e.code})); }`;
async function child() {
  const p=Bun.spawn([process.execPath,'-e',childCode],{env:{...process.env,FORGE_PROBE_LOCK_TARGET:lockTarget},stdout:'pipe',stderr:'pipe'});
  const output=await new Response(p.stdout).text();
  return {exit:await p.exited,result:JSON.parse(output)};
}
let release: (() => Promise<void>) | undefined;
try {
  release = await lockfile.lock(lockTarget, options);
  console.log(JSON.stringify({whileHeld:await child()}));
  await release(); release=undefined;
  console.log(JSON.stringify({afterRelease:await child(),isLocked:await lockfile.check(lockTarget)}));
} finally {
  if (release) await release();
  await rm(lockTarget);
}
```

实测输出：

```json
{"writerExit":0,"readAfterWriterExited":true}
{"deleted":true,"absent":true}
{"whileHeld":{"exit":0,"result":{"acquired":false,"code":"ELOCKED"}}}
{"afterRelease":{"exit":0,"result":{"acquired":true}},"isLocked":false}
```

Not run：macOS Keychain 读写/重启、可用 Linux Secret Service、实际 OAuth 浏览器登录、模型续轮、keyutils 重启后失效、原生 abort/deadline 行为、完整 token 长度上限、锁异常回收。以上不能从当前成功探针推导已通过。
