# dsh-archive-delete

给 DeepSeek Harness（DSH）加一个内核**故意没有**的能力：把已归档的对话从磁盘上真正删掉。

- 侧边栏会话 **“...” 菜单**里多一项 **永久删除**（只在已归档的会话上出现）。
- 顺带给 Agent 一个 `archive_delete` 工具，用于批量清理（同样只认已归档会话）。
- 删除该会话自己的东西：**会话日志目录**、**投影缓存记录**、**工作区里的归档条目与分组归属**。

> **删除不可撤销。** 没有回收站，没有备份，确认之后文件立刻从磁盘消失。

## 为什么需要它

DSH 有“归档”，没有“删除”，这不是遗漏而是明确的设计：

| 来源 | 原文 |
|---|---|
| `@deepseek-ai/dsh-workspace` README（已知限制） | “移除绝不删除数据 …… **会话删除与文件夹移除是彼此独立且尚未提供的功能**” |
| `@deepseek-ai/dsh-session-persistence` README（已知限制） | “**无删除或保留接口**——剪枝已存储会话属于带外后端维护。” |
| `@deepseek-ai/dsh-session-persistence-jsonl` README（已知限制） | “**不删除会话文件**——日志在 `root` 下累积，直到外部移除；seam 无删除接口。” |

所以本插件就是那个“带外后端维护”：它按内核自己的命名规则定位产物，删掉它们，别的一概不碰。

## 安装

```powershell
git clone https://github.com/Diliving/dsh-archive-delete.git
```

然后在 DSH 里让 Agent 装它，或直接调 `plugin_manager` 工具：

```
plugin_manager  action=install_bundle  target="<克隆下来的绝对路径>"
```

`install_bundle` 会自己把包装进当前 profile、把 `dsh-archive-delete` 加进 `dsh.profile.bundles`、并应用它的 `cordis.patch.yml`。
**不要手工改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 里跑 pnpm。**

装好后**重启一次 DSH**。Host 与客户端 bundle 都在插件激活时读进内存，`install_bundle` 返回 `application: applied` 不代表新 JS 已加载。

`index.js` 静态导入 `@deepseek-ai/schemastery`，它由 DSH 自己提供（`peerDependencies`），**通常什么都不用装**。只有不经 DSH 裸跑离线测试时才需要它在本地可解析——本仓库不提交 `node_modules`。

## 怎么用

1. 先把对话**归档**（会话行 “...” → 归档）。归档会停掉它正在跑的工作，这是删除的前置条件。
2. 在侧边栏 **“已归档”** 分组里找到它，点 “...” → **永久删除**。
3. 确认框会列出：会话 id、项目目录、文件数、占用大小、创建时间。
4. 点 **永久删除**；放弃可以按 `Esc`、点遮罩或点“取消”。

**失败时对话框不会关闭**，底部显示原因（例如“会话未归档”“会话仍在本进程中活动”“可能仍有写入方”）。

### 给 Agent 用

```
action="list"                                                # 只读：列出已归档会话及占用
action="delete", ids=[...], confirm=true                     # 真正删除；confirm 必填
action="delete", ids=[...], confirm=true, forceActive=true   # 仅当部署方开了允许才生效
```

### 设置

设置 → 插件 → 已归档会话删除（或改 profile 补丁层里 `dsh-archive-delete` 行的 config）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `menuEnabled` | `true` | 是否在会话菜单里显示“永久删除” |
| `allowAgentDeleteActive` | `false` | 是否允许 Agent 删除**未归档**会话 |

两个字段都是 `.volatile()`，改完立即生效，不需要重启。

## 它到底删了什么

以默认部署为准（`$DSH_HOME`，日志后端 `dsh-session-persistence-jsonl`，zstd 压缩）：

```
<DSH_HOME>/sessions/<项目键>/<编码后的会话 id>/              ← 整个会话目录（含 session*.jsonl.zstd）
<DSH_HOME>/storages/session_projcache/sessions/<id>.json    ← 投影缓存
工作区记账（workspace.json 里的条目）                         ← 归档条目 + 该会话的分组归属
```

- **项目键**（如 `C:\work\demo` → `--C-work-demo--`）与**会话目录名**都用后端自己的算法；本插件把 `projectKey`、`encodeSegment` 照搬过来，所以路径不会猜错。
- **工作区记账走注册表自己的 API**（`Workspace.detachSession` + `WorkspaceRegistry.unarchiveSession`），跑在 domain 写链上，内存、磁盘与正在运行的 GUI 看到同一份状态，行会立刻消失；**插件从不直接改写 `workspace.json`**。
- 如果删掉的是该项目目录下的最后一个会话，空出来的项目目录会一并清理。
- **不删附件**：`attachments/**` 是 SHA-256 内容寻址、跨会话共享的，按会话清理需要全量引用扫描，内核也没有这个能力。
- **不清理 `%TEMP%\dsh-spill-*`**：那是 `dsh-spill-local` 自己的按龄清扫范围。

## 安全门禁

删除请求按**固定顺序**通过检查，第一道不过就停在那里：

| 顺序 | 门禁 | 拒绝原因 |
|---|---|---|
| 1 | 会话在 `archivedSessionIds` 里 | “会话未归档；本插件默认只删除已归档的会话” |
| 2 | 会话不在本进程存活集合里 | “会话仍在本进程中活动，拒绝删除” |
| 3 | 会话目录可写、且没有 `session.lock` | “可能仍有写入方，拒绝删除” |
| 4 | 至少有一份产物（或该 id 已归档的记账） | “没有找到该会话的任何磁盘产物” |
| 5 | **删除前重新校验**：叶子仍是真实目录（非链接）、存活集合仍未包含它、日志头里的 id 与请求一致 | “会话目录是符号链接/junction”“会话在删除前变为活动状态”“日志属于另一个会话” |
| — | 同一 id 已有删除在进行 | “同一个会话已有一次删除正在进行” |

Agent 工具默认**也**受第 1 道约束；只有部署方打开 `allowAgentDeleteActive`，模型才有权删未归档会话（还需要它显式传 `forceActive`）。

**这套门禁做不到什么（据实说明）：**

- **只覆盖本进程的存活集合。** `liveSet()` 读本进程的会话注册表，所以**第二个 DSH 实例**正在使用的会话，在本进程看来“不活跃”。多实例部署下这不是可靠的活跃检测。
- **Windows 上没有 `session.lock` 可查。** JSONL 后端在 Windows 用命名内核信号量，不在会话目录落文件；第 3 道在 Windows 上实际只剩“目录可写”，对 POSIX 才有原本的含义。
- **`force` 会跳过第 1 道。** 它有第 5 道兜底（重新校验存活与身份），但默认关闭是对的。

### HTTP 路由与防护

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/plugins/dsh-archive-delete/archived` | 已归档会话列表 + 占用 + `menuEnabled` |
| `GET` | `/plugins/dsh-archive-delete/preview?id=<id>` | 单个会话的删除预览（确认框用它） |
| `POST` | `/plugins/dsh-archive-delete/delete` | `{"ids":["..."]}` 执行永久删除 |
| `GET` | `/plugins/dsh-archive-delete/diagnostic` | 只返回**计数与代号**，不含任何会话 id 或路径 |

- 只接受**回环地址**的 `Host`（`127.0.0.1` / `localhost` / `[::1]`，允许带端口）。DSH 默认绑回环，但配置允许改成 `0.0.0.0`；**一旦改掉，同网络的人就能列举并删除你的已归档会话**。
- `Sec-Fetch-Site` 不是 `same-origin`/`none` 的请求直接拒绝（浏览器自己写这个头，页面脚本改不了）。
- 带 `Origin` 的请求，其 host 必须与 `Host` 一致；写操作必须 `content-type: application/json`；请求体上限 64 KiB。
- 响应体**不回显绝对路径**（`preview` 里保留 `cwd`，因为确认框要显示你认得的项目名）。

> **关于 DNS rebinding 的界限。** 只比较 `Origin` 与 `Host` **挡不住** rebinding：恶意页面若从 `evil.example:19387` 提供、而该域名解析到 `127.0.0.1`，浏览器视为同源，两个头都是 `evil.example:19387`。真正拦住它的是 `Sec-Fetch-Site` 与回环 `Host` 白名单。**不带 `Origin`/`Sec-Fetch-Site` 的非浏览器客户端（curl、脚本）被放行**——它本来就能访问回环，这是刻意取舍，也正是这些路由必须留在回环绑定之后的原因。

## 开发

```powershell
npm test               # 三套都跑
npm run test:host      # 104 项：门禁顺序、记账清理、叶子重校验、并发去重、工具输出的 JSON 契约
npm run test:client    # 50 项：加载真实的 client.js，驱动确认框的取消/确认/拒绝/失败四条路径
npm run test:security  # 45 项：把本文件的安全声明变成可复跑断言
```

三套都完全离线，**不碰真实数据**：Host 侧在临时 `DSH_HOME` 上跑真实删除路径，客户端侧用假的 `window.__ModuleLoader__` 加载真实的 `client.js`，安全套件只读源码。

安全套件是**声明级**检查，行为级证明在 Host 套件里（例如“门禁顺序”只在行为套件里被证明，“没有 `eval`”只在自检里被证明）。

### 改完之后怎么让它生效

| 改了什么 | 需要做什么 | 原因 |
|---|---|---|
| `index.js`（Host 半） | **重启 DSH** | Host 钉住已加载的模块代；`apply: applied` 不代表新 JS 已加载。 |
| `client.js`（客户端半） | **重启 DSH** | 客户端 bundle 在插件激活时读进内存一次，刷新页面拉不到新代码。 |
| `Config` 设置项 | 不需要重启 | 两个字段都是 `.volatile()`。 |

## 已知边界

- **不可撤销**：没有回收站模式。
- **工作区记账清理失败不回滚文件删除**：日志与缓存已经删掉，返回结果里带上具体错误；残留条目不可见且在下一次注册表变更时自愈。
- **搜索索引**：本机 `dsh-session-query-sqlite` 配置为 `openAt: never`、`:memory:`，磁盘上没有索引文件，无需处理。
- **文件数与占用是估算**：`listSessionFiles` 不跟随子目录里的符号链接（按文件计数）。

## 许可

MIT，见 [LICENSE](LICENSE)。
