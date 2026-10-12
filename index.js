// DSH_archive_delete — Host half.
//
// One capability, and it is one the kernel deliberately does not ship: DSH can
// ARCHIVE a conversation (hide it from every grouping surface) but never delete
// one. Two shipped limitations say so outright —
//
//   * `@deepseek-ai/dsh-workspace` README, 已知限制: "移除绝不删除数据 … 会话删除
//     与文件夹移除是彼此独立且尚未提供的功能".
//   * `@deepseek-ai/dsh-session-persistence` README, 已知限制: "无删除或保留接口
//     ——剪枝已存储会话属于带外后端维护".
//
// So this plugin IS the out-of-band maintenance: it removes the artifacts an
// archived conversation actually owns, and nothing else.
//
// What one conversation owns on this deployment (verified against the live
// profile; see README):
//
//   1. <DSH_HOME>/sessions/<project-key>/<encoded-id>/session*.jsonl.zstd
//      the append-only log — the authoritative store. Both the project key and
//      the session segment are derived exactly as the JSONL backend derives
//      them (`projectKey`, `encodeSegment`).
//   2. <DSH_HOME>/storages/session_projcache/sessions/<id>.json
//      the persisted projection checkpoint, tabled through the
//      `session_projcache` storage domain.
//   3. Its bookkeeping in <DSH_HOME>/storages/workspace.json — `sessionIds`
//      membership in whichever workspace recorded it, and the
//      `archivedSessionIds` entry.
//
// (3) is removed through the registry's OWN API — `Workspace.detachSession` and
// `WorkspaceRegistry.unarchiveSession` — never by rewriting its storage file.
// Both run on the domain write chain, so the in-memory tables, the medium and
// every other reader (a live GUI included) stay coherent, and both are
// idempotent and safe on a session whose files are already gone. This plugin
// never touches `workspace.json` directly: a write outside that chain is exactly
// what the registry's `workspace-invariant` companion exists to catch.
//
// The archive set also serves as the SAFETY GATE below: archiving is
// what makes a session inactive and keeps it inactive (`agent/pre-step` reads
// the durable archive set, so an archived session cannot be woken), which is why
// only archived sessions are deletable.

import { existsSync } from 'node:fs'
import { lstat, open, readdir, rmdir, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { constants as zlibConstants, zstdDecompressSync } from 'node:zlib'
import z from '@deepseek-ai/schemastery'

/** Package name; also the client bundle id and the profile patch row id. */
const PLUGIN_ID = 'dsh-archive-delete'

/** Route prefix the browser half calls, and the plugin's own bundle route lives under. */
const ROUTE = `/plugins/${PLUGIN_ID}`

/** The storage domain holding one projection checkpoint document per session. */
const PROJECTION_CACHE_DOMAIN = 'session_projcache'

/** That domain's declared table name. */
const PROJECTION_CACHE_TABLE = 'sessions'

/** Default cap on how many archived conversations one listing reports. */
const DEFAULT_LIST_LIMIT = 500

/**
 * Bumped whenever the Host module changes shape.
 *
 * The running Host pins a module generation: a rewritten `index.js` only takes
 * effect after a restart, and `application: applied` from an install does NOT
 * mean fresh JavaScript is loaded. This constant is carried in the diagnostic
 * route so a verification step can tell the two apart instead of reading stale
 * behaviour as a defect.
 */
const MODULE_GENERATION = 9

/**
 * Host services, published by {@link apply} once the inject form has resolved
 * them.
 *
 * These MUST come from `ctx.inject`, never from a bare `ctx.<name>` read: on a
 * Cordis plugin context an undeclared service property does not answer
 * `undefined`, it THROWS `cannot get property "<name>" without inject`. A guard
 * around the property read therefore does not degrade gracefully — it turns
 * every route into a 500 with an empty body and, because the same read sits
 * inside the archive gate, would refuse every deletion while appearing to work.
 * The inject form is the only supported way for a Host half to reach another
 * plugin's service.
 */
let sessionsHandle
let registryHandle
let storageDomainHandle

/** Compressed bytes read when recovering a session log's header line. */
const HEADER_PREFIX_BYTES = 262144

/**
 * Deployment defaults.
 *
 * With `Config` resolved these are unreachable — Cordis validates the raw row
 * against the schema before `apply` runs, so every field arrives already
 * defaulted — but the fallback must not depend on the schema package having
 * resolved, which is what `readField` below guarantees.
 */
const DEFAULT_SETTINGS = {
  /** Contribute the sidebar Session-menu row for archived conversations. */
  menuEnabled: true,
  /** Whether the Agent's `archive_delete` tool may act on a session that is not archived. */
  allowAgentDeleteActive: false,
}

/**
 * The plugin's user-editable configuration.
 *
 * Every field is `.volatile()`, which is what makes `@deepseek-ai/dsh-settings`
 * project it: the service describes an entry only while its `Config` projects a
 * NON-EMPTY form, and that projection keeps volatile fields alone. The patch
 * entry id (`dsh-archive-delete`) is the settings namespace.
 */
export const Config = z.object({
  menuEnabled: z.boolean().default(true).description(
    '在已归档会话的 “...” 菜单中显示“永久删除”一项。',
  ).volatile(),
  allowAgentDeleteActive: z.boolean().default(false).description(
    '允许 Agent 的 archive_delete 工具删除【未归档】的会话。默认关闭：模型只能删除你已经归档的会话。',
  ).volatile(),
})

/**
 * Read one field of an applied config, tolerating both shapes it can arrive in.
 *
 * `.volatile()` puts a stable reference in the applied config rather than the
 * value (`{ get() }`), and the loader commits stored edits into that reference
 * in place, so a direct read yields an object and every type guard falls through
 * to the default. A `Config` that could not be resolved arrives as raw values.
 * @param config - the applied config, possibly unresolved.
 * @param key - field name.
 * @returns the current value, or `undefined`.
 */
function readField(config, key) {
  if (config === null || config === undefined) return undefined
  const field = config[key]
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    try {
      return field.get()
    } catch {
      return undefined
    }
  }
  return field
}

/**
 * Resolve the settings the plugin should act on right now.
 * @param config - the applied config.
 * @returns every field defaulted.
 */
function currentSettings(config) {
  const menuEnabled = readField(config, 'menuEnabled')
  const allowAgentDeleteActive = readField(config, 'allowAgentDeleteActive')
  return {
    menuEnabled: typeof menuEnabled === 'boolean' ? menuEnabled : DEFAULT_SETTINGS.menuEnabled,
    allowAgentDeleteActive: typeof allowAgentDeleteActive === 'boolean'
      ? allowAgentDeleteActive
      : DEFAULT_SETTINGS.allowAgentDeleteActive,
  }
}

/**
 * DSH home. The Host process always exports it; the fallback keeps a plugin
 * loaded outside a profile (a test harness) from resolving paths in the cwd.
 * @returns the absolute DSH home path.
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * The JSONL backend's session-id path segment, ported in behaviour from
 * `dsh-session-persistence-jsonl`'s `encodeSegment`. Safe code units stay
 * literal and every other unit becomes `~XXXX`, so `../`, separators and NUL are
 * neutralized before any filesystem use — a raw id is never joined onto a path.
 * @param raw - the session id.
 * @returns one safe path segment.
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * The JSONL backend's project-directory key, ported in behaviour from its
 * `projectKey`: separators and drive separators collapse to `-`, unsafe code
 * units take the same `~XXXX` escape, and the result is bounded for the
 * filesystem component limit. The truncation is lossy in the original too.
 * @param cwd - a session's recorded working directory.
 * @returns one safe directory name.
 */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Decode the leading JSONL record of a stored session log.
 *
 * The current generation writes "one checksummed frame holding a header line,
 * then one frame per append batch", so the HEADER IS THE FIRST FRAME and can be
 * recovered from a bounded prefix read instead of decompressing a log that may
 * be tens of megabytes.
 * @param path - absolute path of a `session*.jsonl[.zstd]` artifact.
 * @param limit - how many compressed bytes to read at most.
 * @returns the parsed header, or `undefined` when it cannot be read.
 */
async function readLogHeader(path, limit = HEADER_PREFIX_BYTES) {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    if (bytesRead === 0) return undefined
    const chunk = buffer.subarray(0, bytesRead)
    let raw
    if (path.endsWith('.zstd')) {
      try {
        raw = zstdDecompressSync(chunk, { finishFlush: zlibConstants.ZSTD_e_end })
      } catch {
        // A prefix that does not end on a frame boundary still yields every
        // complete frame before the tear, which is where the header lives.
        raw = zstdDecompressSync(chunk)
      }
    } else {
      raw = chunk
    }
    const line = raw.toString('utf8').split('\n', 1)[0]
    if (line === undefined || line === '') return undefined
    const parsed = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    // A header this plugin cannot read is a listing detail, never a failure: the
    // row still shows with its id, and every deletion gate is driven by the
    // archive registry and the filesystem rather than by this parse.
    return undefined
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

/**
 * The projection checkpoint path for one session, under the JSON backend's
 * documented per-record layout (`<root>/<domain>/<table>/<key>.json`).
 * @param dshRoot - DSH home.
 * @param id - session id; the domain key, and the file name.
 * @returns the absolute path.
 */
function projectionCachePath(dshRoot, id) {
  return join(dshRoot, 'storages', PROJECTION_CACHE_DOMAIN, PROJECTION_CACHE_TABLE, `${encodeSegment(id)}.json`)
}

/**
 * Locate one session's artifact directory under the persistence root.
 *
 * One shallow scan of `<root>/<project>/<id>`: the session directory is named by
 * the encoded id and its parent is the project directory, so the alternative —
 * deriving the parent from the recorded cwd — only works when the header could
 * be decoded, and a log whose header is unreadable must still be findable.
 * Deleting "the conversation" but leaving its log behind is the one outcome
 * worth avoiding, and the scan reads directory entries only.
 *
 * The leaf must be a REAL directory. `lstat` reports a junction or a symlink as a
 * link, and such a leaf is not a session directory: `rm` would only unlink it, so
 * treating it as one buys nothing and would make this plugin a way to remove a
 * link somebody else planted.
 * @param root - the persistence root (`<DSH_HOME>/sessions`).
 * @param id - session id.
 * @returns the absolute session directory, or `undefined` when absent.
 */
async function locateSessionDir(root, id) {
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  const segment = encodeSegment(id)
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, segment)
    const info = await lstat(candidate).catch(() => undefined)
    if (info !== undefined && info.isDirectory() && !info.isSymbolicLink()) return candidate
  }
  return undefined
}

/**
 * Re-check one planned leaf immediately before it is removed.
 *
 * Everything this inspects was already inspected while the plan was built, and
 * the point is that time has passed since: the leaf can have been swapped, the
 * log can have been replaced, and the filesystem can answer differently.
 * @param dir - the planned session directory (absolute).
 * @param id - the session id the caller asked for.
 * @returns a refusal reason, or `undefined` when the leaf is still the session.
 */
async function validateLeaf(dir, id) {
  const info = await lstat(dir).catch(() => undefined)
  if (info === undefined) return '会话目录在删除前消失，已中止'
  if (info.isSymbolicLink()) return '会话目录是符号链接/junction，拒绝删除'
  if (!info.isDirectory()) return '会话目录不是一个真实目录，拒绝删除'
  // The log's own header is the authoritative statement of which session lives
  // here, so the removal is aimed by identity rather than by path alone.
  let log
  try {
    log = (await readdir(dir)).filter((name) => /^session(\.[a-z0-9]+)?\.jsonl(\.zstd)?$/.test(name))
  } catch {
    log = []
  }
  if (log.length === 0) {
    // Nothing to identify: an empty directory under this name is not a session
    // this plugin can vouch for, but it is also not identifiable as one. Refuse
    // rather than guess.
    return '会话目录里没有可识别的会话日志，拒绝删除'
  }
  for (const name of log) {
    const header = await readLogHeader(join(dir, name))
    if (header === undefined) continue
    if (String(header.id) !== id) return '会话目录里的日志属于另一个会话，拒绝删除'
    return undefined
  }
  return '会话目录里的日志无法解读，拒绝删除'
}

/**
 * Every file a session directory holds, recursively.
 *
 * A symlinked subdirectory is listed as a FILE rather than followed: the count is
 * a size estimate for a confirmation dialog, and descending into a link would
 * both misreport and read somewhere the session does not own.
 * @param dir - the session directory.
 * @returns absolute file paths, best effort.
 */
async function listSessionFiles(dir) {
  const found = []
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path)
      else found.push(path)
    }
  }
  await walk(dir)
  return found
}

/**
 * Remove the project directory when this was its last session.
 * @param dir - the directory that may now be empty.
 */
async function removeDirIfEmpty(dir) {
  try {
    await rmdir(dir)
  } catch {
    // A sibling session still lives there — the normal case.
  }
}

/**
 * Whether another writer currently owns this session's log.
 *
 * Two probes, because the platforms differ: Windows holds a named kernel
 * semaphore derived from the (case-folded) absolute lock path and writes no lock
 * file at all, while POSIX holds a `flock` on `session.lock` beside the log. A
 * probe that cannot tell "free" from "not measured" must not delete, so both
 * signals are collected and the caller decides.
 * @param dir - the session directory.
 * @returns `{ lockFile, writable }`.
 */
async function probeOwnership(dir) {
  const lockFile = existsSync(join(dir, 'session.lock'))
  let writable = true
  const probe = join(dir, `.dsh-archive-delete-probe-${String(process.pid)}`)
  try {
    const handle = await open(probe, 'w')
    await handle.close()
  } catch {
    writable = false
  } finally {
    await unlink(probe).catch(() => {})
  }
  return { lockFile, writable }
}

/**
 * Whether a service has been published yet.
 *
 * Readiness, not reachability: the inject callbacks run when their services come
 * up, and a request that arrives before then must be refused loudly rather than
 * answered from an empty set — an empty archive set means "nothing is archived",
 * which is exactly the answer that would silently reopen the gate.
 * @param handle - the published service handle.
 * @returns true when it is usable.
 */
function ready(handle) {
  return handle !== undefined && handle !== null
}

/**
 * The registry's current archive set.
 * @returns the ids the workspace registry reports as archived.
 * @throws when the registry has not been resolved yet (see {@link ready}).
 */
function archivedSet() {
  if (!ready(registryHandle)) {
    throw new Error(`${PLUGIN_ID}: workspaceRegistry is not resolved yet; refusing to treat the archive set as empty`)
  }
  const ids = registryHandle.archivedSessionIds
  return new Set(Array.isArray(ids) ? ids.map(String) : [])
}

/**
 * Ids of sessions live in this process right now.
 * @throws when the session registry has not been resolved yet.
 */
function liveSet() {
  if (!ready(sessionsHandle)) {
    throw new Error(`${PLUGIN_ID}: sessions is not resolved yet`)
  }
  return new Set(sessionsHandle.list().map((session) => String(session.id)))
}

/**
 * Everything one deletion would touch, without touching it.
 * @param ctx - Host plugin context.
 * @param id - session id.
 * @returns the plan.
 */
async function planDeletion(ctx, id) {
  const dshRoot = dshHome()
  const dir = await locateSessionDir(join(dshRoot, 'sessions'), id)
  const cachePath = projectionCachePath(dshRoot, id)

  let header
  let files = []
  let bytes = 0
  let ownership = { lockFile: false, writable: true }
  if (dir !== undefined) {
    files = await listSessionFiles(dir)
    for (const path of files) {
      try {
        bytes += (await stat(path)).size
      } catch {
        // A file that vanished between listing and stat contributes 0 bytes.
      }
    }
    const logs = files.filter((path) => path.endsWith('.jsonl') || path.endsWith('.jsonl.zstd'))
    logs.sort((left, right) => right.localeCompare(left))
    for (const log of logs) {
      header = await readLogHeader(log)
      if (header !== undefined) break
    }
    ownership = await probeOwnership(dir)
  }

  let cacheBytes = 0
  let cachePresent = false
  try {
    cacheBytes = (await stat(cachePath)).size
    cachePresent = true
  } catch {
    cachePresent = false
  }

  return {
    id,
    dir,
    cachePath,
    cachePresent,
    cacheBytes,
    files,
    bytes,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
    cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
    isSeeded: header?.isSeeded === true,
    delegationDepth: typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0,
    archived: archivedSet().has(id),
    live: liveSet().has(id),
    lockFile: ownership.lockFile,
    writable: ownership.writable,
  }
}

/**
 * Drop one session's projection checkpoint through the storage domain that owns
 * it.
 *
 * Going through the domain rather than deleting the JSON file is what keeps the
 * cache's in-memory tables coherent with the medium: `KvTableImpl.delete` writes
 * through the domain's own chain and emits `domain/changed`, so the projection
 * cache service observes exactly the state it would after any other deletion.
 * The domain is already open (the cache service opened it), and `storageDomain.get`
 * resolves that handle without claiming or closing it — calling `open` here
 * would either throw `already-open` or hand back a handle whose `close` would
 * tear the service's domain down. When the domain is unreachable the file is
 * removed directly, which the cache read path tolerates by construction ("a
 * malformed or stale record reads as absent").
 * @param ctx - Host plugin context.
 * @param id - session id.
 * @returns how the record was removed.
 */
async function dropProjectionCache(ctx, id) {
  const filePath = projectionCachePath(dshHome(), id)
  try {
    if (ready(storageDomainHandle) && typeof storageDomainHandle.get === 'function') {
      const domain = storageDomainHandle.get(PROJECTION_CACHE_DOMAIN)
      if (domain !== undefined && domain !== null) {
        const removed = await domain.table(PROJECTION_CACHE_TABLE).delete(id)
        if (removed === true || !existsSync(filePath)) {
          return { how: 'domain', filePath, existed: removed === true }
        }
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN_ID}: projection-cache domain delete failed for ${id}; removing the file instead`, error)
  }
  try {
    await unlink(filePath)
    return { how: 'file', filePath, existed: true }
  } catch (error) {
    if (error?.code === 'ENOENT') return { how: 'file', filePath, existed: false }
    return { how: 'failed', filePath, existed: false, error: String(error?.message ?? error) }
  }
}

/**
 * Permanently delete every artifact one archived conversation owns.
 *
 * Order matters and is not arbitrary: the session directory goes first. It is
 * the authoritative store, so a partial failure after it leaves only a
 * regenerable cache row, whereas the reverse order could leave a conversation
 * that still opens from its log while its cached checkpoints were already
 * thrown away. The registry's own bookkeeping goes last, through its public API,
 * so a failure to write it never leaves the caller believing a session still
 * exists when its files are gone.
 * @param ctx - Host plugin context.
 * @param id - session id.
 * @param options - `force` skips the archive gate (the Agent tool's opt-in).
 * @returns the outcome record.
 */
async function deleteSessionArtifacts(ctx, id, options = {}) {
  if (typeof id !== 'string' || id === '') {
    return { id: String(id), deleted: false, reason: '会话 id 必须是字符串' }
  }
  // Two callers can aim at one id at once — the sidebar and the Agent tool, or two
  // HTTP posts. Every step below is idempotent, so the damage is nil, but both
  // calls would claim `deleted: true` and neither report could tell "I removed it"
  // from "someone else already had". The second caller is told so instead.
  if (IN_FLIGHT.has(id)) {
    return { id, deleted: false, reason: '同一个会话已有一次删除正在进行' }
  }
  IN_FLIGHT.add(id)
  try {
    return await removeSessionArtifacts(ctx, id, options)
  } finally {
    IN_FLIGHT.delete(id)
  }
}

/**
 * The deletion itself, serialized per id by {@link deleteSessionArtifacts}.
 * @param ctx - Host plugin context.
 * @param id - session id.
 * @param options - `force` skips the archive gate (the Agent tool's opt-in).
 * @returns the outcome record.
 */
async function removeSessionArtifacts(ctx, id, options) {
  const plan = await planDeletion(ctx, id)

  // The refusal order is deliberate and is asserted by the suite: the archive gate
  // answers first, because it is the only gate that fails closed for a session the
  // user did not explicitly hand over.
  if (!plan.archived && options.force !== true) {
    return {
      id,
      deleted: false,
      reason: plan.live
        ? '会话正在运行；请先归档（归档会停止它的工作）再删除'
        : '会话未归档；本插件默认只删除已归档的会话',
    }
  }
  if (plan.live) {
    return { id, deleted: false, reason: '会话仍在本进程中活动，拒绝删除' }
  }
  if (plan.dir !== undefined && (plan.lockFile || !plan.writable)) {
    return {
      id,
      deleted: false,
      // The refusal names the id, never the absolute path: a reason travels to the
      // browser and to the model, and neither needs this machine's layout.
      reason: plan.lockFile
        ? '会话目录里存在 session.lock，可能仍有写入方，拒绝删除'
        : '会话目录不可写，无法确认没有写入方，拒绝删除',
    }
  }
  if (plan.dir === undefined && !plan.cachePresent && !plan.archived) {
    return { id, deleted: false, reason: '没有找到该会话的任何磁盘产物' }
  }
  // An ARCHIVED id with nothing left on disk is not a refusal: it is exactly the
  // stale archive entry this plugin should clear. The user sees a conversation in
  // the archived group, asks for it to be deleted, and the useful answer is to
  // drop the bookkeeping rather than to explain that the files were already gone.

  const errors = []
  let removedFiles = 0
  let freedBytes = 0

  if (plan.dir !== undefined) {
    // Re-validate immediately before the destructive call, because everything the
    // plan decided was decided earlier:
    //
    //   * the leaf must still be a REAL directory. `lstat` sees a junction or a
    //     symlink as a link, and such a leaf is skipped rather than removed — the
    //     plugin must not be a way to unlink a link somebody else planted, and it
    //     must never treat a reparse point as a session directory.
    //   * the session must not have become live in this process meanwhile, which
    //     matters most on the `force` path: that path skips the archive gate, so the
    //     liveness snapshot taken in `planDeletion` would otherwise be the only
    //     thing standing between a resumable session and its log.
    //   * the log header must still name this id, so a directory that appeared
    //     under this name between the plan and now is refused rather than deleted.
    const guard = await validateLeaf(plan.dir, id)
    if (guard !== undefined) {
      return { id, deleted: false, reason: guard }
    }
    if (liveSet().has(id)) {
      return { id, deleted: false, reason: '会话在删除前变为活动状态，已中止' }
    }
    try {
      await rm(plan.dir, { recursive: true, force: true })
      removedFiles = plan.files.length
      freedBytes += plan.bytes
    } catch (error) {
      errors.push(`删除会话目录失败：${String(error?.message ?? error)}`)
    }
    const project = resolve(plan.dir, '..')
    const sessionsRoot = resolve(join(dshHome(), 'sessions'))
    if (project !== sessionsRoot && project.startsWith(sessionsRoot + sep)) await removeDirIfEmpty(project)
  }

  let cache = { how: 'skipped', existed: false }
  if (plan.cachePresent) {
    cache = await dropProjectionCache(ctx, id)
    if (cache.how === 'failed') errors.push(`删除投影缓存失败：${String(cache.error)}`)
    else if (cache.existed) freedBytes += plan.cacheBytes
  }

  // The bookkeeping the registry owns, removed through the registry's OWN API —
  // never by rewriting its storage file. `Workspace.detachSession` and
  // `WorkspaceRegistry.unarchiveSession` both run on the domain write chain, so
  // the in-memory tables, the medium and every other reader stay coherent, and a
  // running GUI sees the row leave without a restart. Both are idempotent, and
  // both are safe on a session whose files are already gone: `detachSession`
  // writes nothing for an id a workspace does not account, and `unarchiveSession`
  // deliberately runs no existence check.
  let detach = 'skipped'
  let unarchive = 'skipped'
  try {
    if (ready(registryHandle) && typeof registryHandle.list === 'function') {
      const holders = registryHandle.list().filter((workspace) => (
        Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)
      ))
      for (const workspace of holders) await workspace.detachSession(id)
      detach = holders.length
    }
  } catch (error) {
    errors.push(`清理工作区分组记账失败：${String(error?.message ?? error)}`)
    detach = 'failed'
  }
  try {
    if (ready(registryHandle) && typeof registryHandle.unarchiveSession === 'function') {
      await registryHandle.unarchiveSession(id)
      unarchive = 'done'
    }
  } catch (error) {
    errors.push(`清理归档标记失败：${String(error?.message ?? error)}`)
    unarchive = 'failed'
  }

  return {
    id,
    // `deleted` means "this conversation is gone": with no directory left behind,
    // clearing an archived id's bookkeeping is a completed deletion even when
    // there were never any files to remove.
    deleted: plan.dir === undefined || !existsSync(plan.dir),
    removedFiles,
    freedBytes,
    cache: cache.how,
    detach,
    unarchive,
    errors,
    reason: errors.length > 0 ? errors.join('；') : undefined,
  }
}

/**
 * One listing row, normalized to lossless JSON.
 *
 * A tool result must be lossless JSON — `undefined` is not a JSON value — and an
 * archived id with nothing left on disk legitimately has no creation time and no
 * recorded cwd. Absent fields therefore become `null` rather than `undefined`,
 * which is also what the tool's declared output schema accepts.
 * @param id - session id.
 * @param plan - the deletion plan.
 * @param live - whether the session is live in this process.
 * @returns a JSON-safe row.
 */
function listingRow(id, plan, live) {
  return {
    id,
    createdAt: typeof plan.createdAt === 'number' ? plan.createdAt : null,
    cwd: typeof plan.cwd === 'string' ? plan.cwd : null,
    bytes: plan.bytes + (plan.cachePresent ? plan.cacheBytes : 0),
    files: plan.files.length,
    exists: plan.dir !== undefined || plan.cachePresent,
    live: live.has(id),
    lockFile: plan.lockFile === true,
    delegationDepth: plan.delegationDepth,
  }
}

/**
 * A deletion outcome normalized to lossless JSON — the same rule as
 * {@link listingRow}, applied to the fields that are absent on the happy path.
 * @param result - the outcome of {@link deleteSessionArtifacts}.
 * @returns a JSON-safe outcome.
 */
function outcomeJson(result) {
  return {
    id: result.id,
    deleted: result.deleted === true,
    removedFiles: result.removedFiles ?? 0,
    freedBytes: result.freedBytes ?? 0,
    cache: result.cache ?? 'skipped',
    detach: result.detach ?? 'skipped',
    unarchive: result.unarchive ?? 'skipped',
    errors: Array.isArray(result.errors) ? result.errors : [],
    reason: typeof result.reason === 'string' ? result.reason : null,
  }
}

/**
 * The archived conversations with the metadata a person needs to recognise one.
 * @param ctx - Host plugin context.
 * @param limit - maximum rows.
 * @returns the listing.
 */
async function listArchived(ctx, limit) {
  const ids = archivedSet()
  const live = liveSet()
  const rows = []
  for (const id of [...ids].slice(0, limit)) rows.push(listingRow(id, await planDeletion(ctx, id), live))
  rows.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
  return { total: ids.size, rows }
}

/** One JSON response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Read a bounded JSON request body. */
async function readJsonBody(req, maxBytes = 65536) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/**
 * Whether a request may act.
 *
 * These routes mutate the user's disk, so the attack that matters is a web page
 * reaching the loopback server. Three checks, and it is worth being precise about
 * what each one does and does not buy:
 *
 *  1. **`Sec-Fetch-Site`** — a browser sets this itself and page script cannot
 *     forge it, so `cross-site` is a definitive refusal. This is the check that
 *     actually stops a hostile page, including one that is served from an
 *     attacker's domain that resolves to loopback.
 *  2. **Host must be a loopback authority.** Comparing `Origin` to `Host` alone
 *     proves only that the two agree — under DNS rebinding both read
 *     `evil.example:19387` and the comparison passes. Restricting `Host` to
 *     loopback pins the request to the interface these routes are actually for.
 *  3. **`Origin`, when present, must equal `Host`.** Redundant with (1) for
 *     browsers, and useful for everything else.
 *
 * A request with no `Origin` and no `Sec-Fetch-Site` is a non-browser client
 * (curl, a script). It is allowed: it already had to reach loopback. That is a
 * deliberate choice, and it is the reason this plugin's routes must stay behind a
 * loopback bind — see the README's note on `webServer.host`.
 * @param req - the incoming request.
 * @param requireJson - whether the JSON content type is required.
 * @returns `undefined` when allowed, otherwise the refusal.
 */
function checkOrigin(req, requireJson) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return `Sec-Fetch-Site: ${site}，拒绝跨站请求`
  }
  const host = String(req.headers.host ?? '')
  if (!isLoopbackAuthority(host)) return `Host ${host === '' ? '(缺失)' : host} 不是回环地址，拒绝请求`
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let originHost
    try {
      originHost = new URL(origin).host
    } catch {
      return 'Origin 头无法解析'
    }
    if (originHost !== host) return 'Origin 与 Host 不一致，拒绝跨站请求'
  }
  if (requireJson) {
    const type = String(req.headers['content-type'] ?? '')
    if (!type.toLowerCase().startsWith('application/json')) return '写操作要求 content-type: application/json'
  }
  return undefined
}

/**
 * Whether a `Host` header names a loopback authority (`127.0.0.1:port`,
 * `localhost:port`, `[::1]:port`, with or without the port).
 * @param host - the raw `Host` header value.
 * @returns whether it is loopback.
 */
function isLoopbackAuthority(host) {
  if (host === '') return false
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.split(':')[0]
  const bare = name.startsWith('[') ? name.slice(1, -1) : name
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1' || bare === '0000:0000:0000:0000:0000:0000:0000:0001'
}

/**
 * Host half entry point.
 *
 * `export function apply` is the module face the Loader activates. Optional
 * services are reached with the dynamic `ctx.inject` form rather than a declared
 * `inject`, because a required service that is absent leaves the fiber PENDING
 * and `apply` never runs at all. Here that matters for `webServer` (a headless
 * profile has no browser surface) and for `tools` (a preset realm owns tool
 * registration on the Web surface, and a profile without it must still serve the
 * routes). The delete operation itself needs no injected service at all — it
 * reads the workspace registry through a guarded property access and does its
 * work on the filesystem — so the plugin stays functional in every composition.
 * @param ctx - Host plugin context.
 * @param config - the applied config, fields defaulted.
 */
export function apply(ctx, config) {
  ctx.logger?.info?.(`${PLUGIN_ID}: host half active, module generation ${String(MODULE_GENERATION)}`)

  // The one operation, defined once. The sidebar row and the Agent tool are two
  // CALLERS of it, never two implementations.
  const remove = (id, options) => deleteSessionArtifacts(ctx, id, options)

  // Every cross-plugin service this half needs, resolved through the inject form
  // and published to the module scope the read paths share. `sessions`,
  // `workspaceRegistry` and `storageDomain` live in the same composition as this
  // plugin on every shipped profile, so requiring them is safe — and requiring
  // them is also what makes the archive gate honest: a profile without the
  // registry never reaches the point of answering "nothing is archived".
  ctx.inject(['sessions'], (sessionCtx) => {
    sessionsHandle = sessionCtx.sessions
  })
  ctx.inject(['workspaceRegistry'], (registryCtx) => {
    registryHandle = registryCtx.workspaceRegistry
    ctx.logger?.info?.(`${PLUGIN_ID}: workspaceRegistry resolved; ${String(archivedSet().size)} archived session(s)`)
  })
  ctx.inject(['storageDomain'], (domainCtx) => {
    storageDomainHandle = domainCtx.storageDomain
  })

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/archived`,
      handler: (req, res) => {
        void (async () => {
          const refusal = checkOrigin(req, false)
          if (refusal !== undefined) {
            sendJson(res, 403, { error: refusal })
            return
          }
          const listing = await listArchived(ctx, DEFAULT_LIST_LIMIT)
          // `sessionsRoot` is deliberately absent: the client never needed it, and
          // a route that hands out this machine's layout to anything that can
          // reach loopback is a disclosure with no upside.
          sendJson(res, 200, {
            ...listing,
            menuEnabled: currentSettings(config).menuEnabled,
          })
        })().catch((error) => {
          ctx.logger?.error?.(`${PLUGIN_ID}: archived route failed`, error)
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
          else res.end()
        })
      },
    }), `${PLUGIN_ID}: archived route`)

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/diagnostic`,
      handler: (req, res) => {
        void (async () => {
          // Counts and codes only — never a session id, never a path, and no
          // stack trace either: an absolute path in an error message is the same
          // disclosure as an absolute path in a field. This route carries the one
          // exception to the origin guard because it has nothing a caller could
          // act on, and that exemption is only honest while it stays contentless.
          const steps = {
            moduleGeneration: MODULE_GENERATION,
            sessionsResolved: ready(sessionsHandle),
            registryResolved: ready(registryHandle),
            storageDomainResolved: ready(storageDomainHandle),
          }
          const attempt = async (label, run) => {
            try {
              steps[label] = await run()
            } catch {
              // The failure class, without its message: a message can embed a path.
              steps[label] = 'THREW'
            }
          }
          await attempt('archivedCount', () => archivedSet().size)
          await attempt('liveCount', () => liveSet().size)
          await attempt('listing', async () => {
            const listing = await listArchived(ctx, DEFAULT_LIST_LIMIT)
            return { total: listing.total, rows: listing.rows.length }
          })
          await attempt('serialize', async () => {
            const listing = await listArchived(ctx, DEFAULT_LIST_LIMIT)
            return JSON.stringify(listing).length
          })
          await attempt('menuEnabled', () => currentSettings(config).menuEnabled)
          sendJson(res, 200, { steps })
        })().catch((error) => {
          ctx.logger?.error?.(`${PLUGIN_ID}: diagnostic route failed`, error)
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
          else res.end()
        })
      },
    }), `${PLUGIN_ID}: diagnostic route`)

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/preview`,
      handler: (req, res) => {
        void (async () => {
          const refusal = checkOrigin(req, false)
          if (refusal !== undefined) {
            sendJson(res, 403, { error: refusal })
            return
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const id = url.searchParams.get('id')
          if (id === null || id === '') {
            sendJson(res, 400, { error: '缺少 id 参数' })
            return
          }
          const plan = await planDeletion(ctx, id)
          // Only what the confirmation dialog renders. The session's own directory
          // path and its log file names are deliberately NOT returned: the client
          // does not display them, and a route anybody on loopback can call should
          // not hand out this machine's layout. `cwd` stays because the dialog shows
          // the project a person recognises, which is the whole point of that row.
          sendJson(res, 200, {
            id,
            archived: plan.archived,
            live: plan.live,
            lockFile: plan.lockFile,
            writable: plan.writable,
            fileCount: plan.files.length,
            bytes: plan.bytes + (plan.cachePresent ? plan.cacheBytes : 0),
            createdAt: plan.createdAt ?? null,
            cwd: plan.cwd ?? null,
          })
        })().catch((error) => {
          ctx.logger?.error?.(`${PLUGIN_ID}: preview route failed`, error)
          if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
          else res.end()
        })
      },
    }), `${PLUGIN_ID}: preview route`)

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/delete`,
      handler: (req, res) => {
        void (async () => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'use POST' })
            return
          }
          const refusal = checkOrigin(req, true)
          if (refusal !== undefined) {
            sendJson(res, 403, { error: refusal })
            return
          }
          const body = await readJsonBody(req)
          const ids = Array.isArray(body.ids) ? body.ids : body.id === undefined ? [] : [body.id]
          const clean = ids.filter((id) => typeof id === 'string' && id !== '')
          if (clean.length === 0) {
            sendJson(res, 400, { error: 'ids 必须包含至少一个会话 id' })
            return
          }
          const results = []
          for (const id of clean) results.push(await remove(id, { force: false }))
          sendJson(res, 200, { results, deleted: results.filter((row) => row.deleted).length })
        })().catch((error) => {
          ctx.logger?.error?.(`${PLUGIN_ID}: delete route failed`, error)
          if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
          else res.end()
        })
      },
    }), `${PLUGIN_ID}: delete route`)
  })

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'archive_delete',
      description: [
        '永久删除【已归档】的会话及其磁盘产物（会话日志与投影缓存），不可撤销。',
        'DSH 本身没有会话删除接口，此工具与侧边栏的“永久删除”共用同一个实现。',
        'action="list" 只读列举已归档会话及其占用；',
        'action="delete" 必须再次传入同样的 ids 并 confirm=true 才真正删除。',
        '未归档或正在运行的会话会被拒绝；除非部署方在设置里显式允许，否则模型无权删除未归档会话。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'delete'],
            description: 'list 只读列举；delete 执行永久删除。',
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '要删除的会话 id；action="delete" 时必填，来自 action="list"。',
          },
          confirm: {
            type: 'boolean',
            description: 'action="delete" 时必须为 true，表示已向用户说明不可撤销。',
          },
          forceActive: {
            type: 'boolean',
            description: '请求删除未归档会话；仅当部署方把 allowAgentDeleteActive 设为 true 时生效。',
          },
        },
      },
      output: {
        // The output schema must describe what this tool ACTUALLY returns, and the
        // kernel validates a result against it before the model sees it. An
        // archived id with nothing left on disk legitimately has no creation time
        // and no recorded cwd, so those two are declared nullable rather than
        // dropped: `oneOf` with a `null` branch is the subset's way to say
        // "integer, or explicitly nothing". Getting this wrong is not cosmetic —
        // it fails the whole call, which is exactly what a real profile hit.
        schema: {
          type: 'object',
          additionalProperties: true,
          required: ['action'],
          properties: {
            action: { type: 'string' },
            total: { type: 'integer' },
            rows: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                required: ['id', 'createdAt', 'cwd'],
                properties: {
                  id: { type: 'string' },
                  createdAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                  cwd: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  bytes: { type: 'integer' },
                  files: { type: 'integer' },
                  exists: { type: 'boolean' },
                  live: { type: 'boolean' },
                  lockFile: { type: 'boolean' },
                  delegationDepth: { type: 'integer' },
                },
              },
            },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                required: ['id', 'deleted', 'reason'],
                properties: {
                  id: { type: 'string' },
                  deleted: { type: 'boolean' },
                  reason: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  cache: { type: 'string' },
                  // The number of workspace records actually detached, or one of
                  // the 'skipped'/'failed' markers — hence a union, not a string.
                  detach: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
                  unarchive: { type: 'string' },
                  removedFiles: { type: 'integer' },
                  freedBytes: { type: 'integer' },
                  errors: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = []
          if (Array.isArray(value.rows)) {
            lines.push(`已归档会话 ${value.rows.length} / ${value.total ?? value.rows.length} 个：`)
            for (const row of value.rows) {
              const when = typeof row.createdAt === 'number' ? new Date(row.createdAt).toISOString() : '未知时间'
              lines.push(`- ${row.id}  ${when}  ${String(row.bytes ?? 0)} 字节  ${row.cwd ?? ''}`)
            }
            if (value.rows.length === 0) lines.push('- （没有已归档会话）')
          }
          if (Array.isArray(value.results)) {
            const ok = value.results.filter((row) => row.deleted === true).length
            lines.push(`删除结果：成功 ${ok} / 共 ${value.results.length}`)
            for (const row of value.results) {
              lines.push(`- ${row.id}  ${row.deleted === true ? '已永久删除' : `未删除：${row.reason ?? '未知原因'}`}`)
            }
          }
          if (lines.length === 0) lines.push('没有结果。')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        if (args.action === 'list') {
          const listing = await listArchived(ctx, DEFAULT_LIST_LIMIT)
          return { action: 'list', total: listing.total, rows: listing.rows }
        }
        const ids = Array.isArray(args.ids) ? args.ids : []
        if (ids.length === 0) throw new Error('action="delete" 需要 ids：先运行 action="list" 取得会话 id')
        if (args.confirm !== true) {
          throw new Error('action="delete" 需要 confirm=true；请先向用户说明这些会话将被永久删除且不可撤销')
        }
        const settings = currentSettings(config)
        const force = settings.allowAgentDeleteActive && args.forceActive === true
        const results = []
        for (const id of ids) results.push(outcomeJson(await remove(id, { force })))
        return { action: 'delete', total: ids.length, results }
      },
    }), `${PLUGIN_ID}: archive_delete tool`)
  })
}

/**
 * Publish the Host services the deletion path reads — the same three handles
 * {@link apply} resolves through `ctx.inject`.
 *
 * Exported for the offline suite, which drives `deleteSessionArtifacts` without
 * a Cordis composition. In production nothing calls this: `apply` is the only
 * publisher, which is what keeps "the archive set is empty" and "the registry was
 * never resolved" from ever being confused for one another.
 * @param services - the resolved service handles.
 */
function setHostServices(services) {
  if (services.sessions !== undefined) sessionsHandle = services.sessions
  if (services.workspaceRegistry !== undefined) registryHandle = services.workspaceRegistry
  if (services.storageDomain !== undefined) storageDomainHandle = services.storageDomain
}

export {
  PLUGIN_ID,
  ROUTE,
  MODULE_GENERATION,
  encodeSegment,
  projectKey,
  readLogHeader,
  listArchived,
  deleteSessionArtifacts,
  setHostServices,
}

/** Session ids with a deletion in progress, so two callers cannot both report success. */
const IN_FLIGHT = new Set()
