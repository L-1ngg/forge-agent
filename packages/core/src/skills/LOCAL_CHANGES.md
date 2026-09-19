# Pi Skills 来源与本地差异

> 状态：#35 本地接入。来源固定在 `upstream.json`；runtime 自身的上游版本不变。

迁入来源为 Pi `36b60d2e8985899743c4cf5bd5f8929832a3f05d`，MIT 许可随本目录保留。`upstream.json` 记录三个源码文件、原始测试及 16 个 fixture 的迁入前 SHA-256。生产依赖仅新增 `yaml@2.9.0` 和 `ignore@7.0.5`；未引入 Pi coding-agent 包。

- `upstream/text.ts` 保留上游原文；`upstream/frontmatter.ts` 仍是唯一 YAML parser，但闭合分隔符改为完整行匹配，避免合法 `---extension` 键吞掉后续 explicit-only 元数据。Forge 只把有界的 header 交给它，加载结果的 body 用原始 UTF-8 字节独立保存，避免上游 trim/newline normalization 改写正文。
- `upstream/skills.ts` 从同名上游模块派生。保留 name/description 验证、ignore pattern 处理、目录遇 `SKILL.md` 终止以及 XML formatter 算法，按 Forge 公共合同改造扫描接口。扫描改为异步、有取消检查、层内排序、visited 环路阻断；来源/分组枚举错误抛出，坏候选及 ignore 文件错误单列诊断。
- 原有宿主依赖 `config.ts`、`paths.ts`、`diagnostics.ts`、`source-info.ts` 不整文件迁入：目录/home 决策归 CLI，路径使用 Node `resolve`/`realpath`，所需来源与诊断字段归 `types.ts`，三层排序和碰撞处理归 `catalog.ts`。这些是明确替换的宿主依赖闭包，不是上游原样实现。
- 发现只接受 `SKILL.md`，不再扫描普通顶层 Markdown。显式根缺失失败、optional 根缺失为空。来源外 ignore 文件不继承；每个子树复制父 matcher，避免兄弟规则泄漏。`.git` 与 `node_modules` 始终排除，其余隐藏目录可作为显式来源下的分组。
- 上游目录名回退、目录名不一致、仅警告保留非法名称，改为拒绝；严格检查标准可选字段和 boolean 扩展。真实入口目录决定 name 身份。未知扩展保留，不生成工具或权限。标准依据为 manifest 中固定的 Agent Skills specification；64 KiB header 和 50 KiB body 是 Forge 资源限制。
- 三层按 workspace → user → builtin 及相对路径稳定排序，先真实文件去重，再名称 first-wins；invalid 不占名称。保留 `available`、`shadowed`、`invalid`、`duplicate` 与胜出入口。正文不保存在 catalog。
- formatter 不含 `<location>`，不建议调用未注册的 read/bash，改用 `load_skill(name)`；explicit-only 元数据不向模型披露。
- 新增文件句柄分块读取、全文件 SHA-256 和 inode/真实路径检查；激活不截断超长正文，不自动读 references。工具接入、显式输入、权限、原子配置、预算和历史全由 Forge session/SDK 承接。

## 测试来源与证据边界

`test/skills-upstream/skills.test.ts` 按上游 28 个用例的发现、校验、目录终止、碰撞、frontmatter 和 formatter 场景重新组织，使用原始 fixture。严格校验改变的期望明确标注；不宣称保持 28 个原样用例或完整 Pi 宿主兼容。上游 `skillPaths`/home 展开被 SDK 显式 roots 与 CLI 默认路径契约替代，在 SDK/CLI 测试验收。SDK 默认不展开 `~`，不自行查找 home。

主产品验收见 `packages/core/test/sdk-skills.test.ts`、CLI Skills 测试、正式 CLI PTY 和会话 UI 测试；上游模块测试不替代这些证据。
