# dsh-archive-delete —— 手动永久删除已归档的对话

给 DeepSeek Harness（DSH）加一个内核**故意没有**的能力：把已归档的对话从磁盘上真正删掉。

- 侧边栏会话 **“...” 菜单**里多一项 **永久删除**（只在已归档的会话上出现）。
- 顺带给 Agent 一个 `archive_delete` 工具，用于批量清理（同样只认已归档会话）。
- 只删该会话自己的东西：**会话日志目录**、**投影缓存记录**，以及**工作区里的归档条目与分组归属**。

> **删除不可撤销。** 没有回收站，没有备份，确认之后文件立刻从磁盘消失。

## 安装

```powershell
git clone https://github.com/Diliving/dsh-archive-delete.git
```

然后在 DSH 里让 Agent 装它，或直接调 `plugin_manager` 工具：

```
plugin_manager  action=install_bundle  target="<克隆下来的绝对路径>"
```

`install_bundle` 会自己完成三件事：把包装进当前 profile 的 `node_modules`、把 `dsh-archive-delete` 加进 `dsh.profile.bundles`、应用它的 `cordis.patch.yml`。
**不要手工改 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 里跑 pnpm。**

装好后**重启一次 DSH**（Host 与客户端 bundle 都在插件激活时读进内存；`install_bundle` 返回 `application: applied` 不代表新 JS 已加载）。

---

## 为什么需要它

DSH 有“归档”，没有“删除”，这不是遗漏而是明确的设计：

| 来源 | 原文 |
|---|---|
| `@deepseek-ai/dsh-workspace` README（已知限制） | “移除绝不删除数据 …… **会话删除与文件夹移除是彼此独立且尚未提供的功能**” |
| `@deepseek-ai/dsh-session-persistence` README（已知限制） | “**无删除或保留接口**——剪枝已存储会话属于带外后端维护。” |
| `@deepseek-ai/dsh-session-persistence-jsonl` README（已知限制） | “**不删除会话文件**——日志在 `root` 下累积，直到外部移除；seam 无删除接口。” |

所以本插件就是那个“带外后端维护”：它按内核自己的命名规则定位产物，删掉它们，别的一概不碰。

---

## 一个会话在磁盘上有什么

以默认部署为准（`$DSH_HOME`，日志后端 = `dsh-session-persistence-jsonl`，zstd 压缩）：

```
<DSH_HOME>/sessions/<项目键>/<编码后的会话 id>/
    session.v4.jsonl.zstd      # 当前代际日志（权威存储）
    session.jsonl.zstd         # v0 代际，历史迁移后保留
    （未来可能还有别的会话本地文件）

<DSH_HOME>/storages/session_projcache/sessions/<会话 id>.json
                               # 投影检查点（domain: session_projcache, layout: per-record）

<DSH_HOME>/storages/workspace.json
                               # global.archivedSessionIds[] 与各 workspace 的 sessionIds[]
```

- **项目键**（如 `D:\DSH_work\插件` → `--D-DSH_work-~63D2~4EF6--`）和**会话目录名**都由后端自己的算法决定；本插件把 `projectKey`、`encodeSegment` 两个算法**照搬**过来（见 `index.js` 的注释），因此路径不会猜错。
- **不删**附件。`attachments/v1/**` 是 SHA-256 内容寻址、**跨会话共享**的，按会话清理就需要全量引用扫描，本插件不做这件事（这也是内核自己的立场）。
- **工作区记账也清理掉**：归档条目与分组归属都删除。见下节。

### `workspace.json` 怎么被清理（以及为什么不是直接改文件）

删除完文件后，插件通过**注册表自己的 API** 把记账也删掉，而不是去改它的存储文件：

```js
await workspace.detachSession(id)              // 每个记着它的 workspace 各一次
await ctx.workspaceRegistry.unarchiveSession(id)  // 清掉归档条目
```

两个调用都跑在 domain 的**写链**上（`Workspace.mutate` → `table.update`），所以内存表、磁盘、以及每一个读者——包括正在运行的 GUI——看到的都是同一份状态，行会立刻从侧边栏消失，不需要重启。两个调用都是幂等的，而且在会话文件已经消失之后依然安全：`detachSession` 对未被记账的 id 不写盘，`unarchiveSession` 按设计不做存在性探测。

**插件从不直接碰 `workspace.json`。** 绕过那条写链去改注册表自己的 domain 文件，正是它的 `workspace-invariant` 伙伴插件要抓的写入，也会和 GUI 抢同一条链。

归档集合同时是本插件的**安全门禁**：归档让会话停下来并保持停止（`agent/pre-step` 读这个持久集合），所以“正在被写”和“正在被删”不可能同时发生。

---

## 安全门禁

删除请求要通过**全部**检查才会真正落盘：

| 门禁 | 拒绝原因 |
|---|---|
| 会话在 `archivedSessionIds` 里 | “会话未归档；本插件默认只删除已归档的会话” |
| 会话不在本进程存活集合里 | “会话仍在本进程中活动，拒绝删除” |
| 会话目录里没有 `session.lock`，且目录可写 | “可能仍有写入方，拒绝删除” |
| 至少存在一份产物 | “没有找到该会话的任何磁盘产物” |

「已归档」之所以是关键门禁：归档是**持久**的，并且 `agent/pre-step` 门禁会读这个集合，所以已归档会话无法被唤醒，也就不可能在我们删它的同时还有人往里写。

Agent 工具默认**也**受这条约束；只有部署方把设置项 `allowAgentDeleteActive` 打开，模型才有权删未归档会话（还需要它显式传 `forceActive`）。

### 写入接口的额外防护

- 只绑定在本机回环地址上（DSH 自己的 web 服务）。
- 带 `Origin` 的请求，其 host 必须与 `Host` 头一致；不一致直接 403（挡跨站页面）。
- 写操作必须 `content-type: application/json`（强制 CORS 预检，而路由不回应预检）。
- 请求体上限 64 KiB。

---

## 在界面上怎么用

1. 先把对话**归档**（会话行 “...” → 归档）。这是删除的前置条件。
2. 在侧边栏找到它（归档会话在“已归档”分组里），点 “...” → **永久删除**。
3. 弹出确认框，上面写着：会话 id、项目目录、文件数、占用大小、创建时间；下面列出将要执行的操作。
4. 点 **永久删除**。成功后会话从列表消失，文件从磁盘移除。

确认框支持 `Esc` 取消、点遮罩取消；失败时框不关闭并显示原因。

---

## 给 Agent 用

工具 `archive_delete`，两种动作：

```
action="list"                                    # 只读：列出已归档会话及占用
action="delete", ids=[...], confirm=true         # 真正删除；confirm 必填
action="delete", ids=[...], confirm=true, forceActive=true   # 仅当部署方开了允许时才生效
```

设计上强制两步：先 `list` 拿到 id，再带着 `confirm=true` 删除。工具拒绝未确认的删除请求。

---

## 设置

设置 → 插件 → 已归档会话删除（或直接改 profile 补丁层里 `dsh-archive-delete` 行的 config）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `menuEnabled` | `true` | 是否在会话菜单里显示“永久删除” |
| `allowAgentDeleteActive` | `false` | 是否允许 Agent 删除**未归档**会话 |

两个字段都是 `.volatile()`，所以在设置页改完立即生效，不需要重启。

---

## 安装后的文件位置

| 内容 | 位置 |
|---|---|
| 插件源码 | 克隆下来的仓库目录 |
| profile 链接 | `$DSH_HOME/profiles/<profile>/node_modules/dsh-archive-delete`（`link:` 依赖） |
| bundle 声明 | profile `package.json` 的 `dsh.profile.bundles` 里 `dsh-archive-delete` |
| 离线测试（Host 半） | `node verify-dry-run.mjs`（71 项） |
| 离线测试（客户端半） | `node verify-client.mjs`（45 项） |

两套测试都完全离线，不碰真实数据：Host 侧在合成的临时 `DSH_HOME` 上跑真实的删除路径（含工作区记账清理）；客户端侧用假的 `window.__ModuleLoader__` 加载**真实的 `client.js`**，点击菜单行并驱动对话框的取消、确认、失败三条路径。

### 依赖

`index.js` 静态导入 `@deepseek-ai/schemastery`，它由 **DSH 自己提供**（声明在 `peerDependencies`）：

- 内核用它来解析本插件的 `Config` schema（`.volatile()` 需要 ≥ 3.18.4）。经 DSH 的模块加载器运行时，这个导入会从 DSH 安装目录解析，因此**通常什么都不用装**。
- 只有裸跑 `node verify-dry-run.mjs`（不经 DSH）时才需要它在本地可解析。本仓库**不提交** `node_modules`，所以克隆后如果需要本地跑测试，请自行提供：

  ```powershell
  # 指向 DSH 安装里的那一份（示例，按实际路径改）
  New-Item -ItemType Directory -Force -Path node_modules\@deepseek-ai | Out-Null
  New-Item -ItemType Junction -Path node_modules\@deepseek-ai\schemastery -Target "<DSH>\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\schemastery"
  ```

  或者把 `verify-dry-run.mjs` 里对 `plugin.*` 的断言当成“文档”读——两套测试都不会修改真实数据。

### 改完之后怎么让它生效

| 改了什么 | 需要做什么 | 原因 |
|---|---|---|
| `index.js`（Host 半） | **重启 DSH** | Host 钉住已加载的模块代；`install_bundle` 返回 `application: applied` 只代表 bundle 行已启用，**不代表新 JS 已加载**。 |
| `client.js`（客户端半） | **重启 DSH**（只刷新页面**不够**） | 客户端 bundle 在插件激活时就被读进内存一次（`initialBundleSnapshot`），之后页面加载用的是内存里那份；它的文件监听（`pnpm run dev:web`）在桌面模式下没有运行。 |
| `Config` 里的设置项 | 不需要重启 | 两个字段都是 `.volatile()`，改完立即生效。 |
| `verify-*.mjs` | 不需要 | 只有手动运行时才用得到。 |

---

## HTTP 路由（浏览器半使用）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/plugins/dsh-archive-delete/archived` | 已归档会话列表 + 占用 + `menuEnabled` |
| `GET` | `/plugins/dsh-archive-delete/preview?id=<id>` | 单个会话的删除预览（确认框用它） |
| `POST` | `/plugins/dsh-archive-delete/delete` | `{"ids":["..."]}` 执行永久删除 |
| `GET` | `/plugins/dsh-archive-delete/diagnostic` | 服务解析状态与列表步骤（排查用） |

---

## 手动排查

```powershell
# 服务是否都解析到了、列表是否正常
curl.exe -s http://127.0.0.1:19387/plugins/dsh-archive-delete/diagnostic

# 现在能看到哪些已归档会话
curl.exe -s http://127.0.0.1:19387/plugins/dsh-archive-delete/archived
```

`diagnostic` 里三个 `*Resolved` 全为 `true` 才说明插件拿到了它需要的服务。若为 `false`，说明该服务不在当前组合里——此时删除会**明确拒绝**，而不会把“拿不到服务”当成“没有会话被归档”。

---

## 已知边界

- **不可撤销**：没有回收站模式。
- **不清理附件**：内容寻址、跨会话共享，按会话删需要引用扫描（内核也没有这个能力）。
- **不清理 `%TEMP%\dsh-spill-*`**：那是 `dsh-spill-local` 自己的按龄清扫范围。
- **同一个项目目录的最后一个会话被删后**，空的项目目录会被顺手删掉；还有别的会话时保留。
- **搜索索引**：本机 `dsh-session-query-sqlite` 配置为 `openAt: never`、`:memory:`，磁盘上没有索引文件，所以无需处理。
- **工作区记账清理失败不会回滚文件删除**：日志与缓存已经删掉，返回结果里会带上具体错误；残留的记账条目不可见且在下一次注册表变更时自愈。
