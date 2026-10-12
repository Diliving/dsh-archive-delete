// dsh-archive-delete — offline deletion suite.
//
// Runs the Host half's REAL deletion path against a synthetic DSH home, so the
// gate, the artifact set and the cleanup are all proven without touching the
// live deployment. The only thing stubbed is the plugin context: `sessions`,
// `workspaceRegistry` and `storageDomain` are the three Host services
// `deleteSessionArtifacts` reads, and the shapes below mirror what the live
// services answer (verified against the running Host).
//
// Run: node verify-dry-run.mjs
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, zstdCompressSync } from 'node:zlib'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** A synthetic DSH home; every case below runs against this one tree. */
const HOME = await mkdtemp(join(tmpdir(), 'dsh-archive-delete-verify-'))
process.env.DSH_HOME = HOME

const plugin = await import(new URL('./index.js', import.meta.url).href)

let failures = 0
let checks = 0

/** One assertion with a readable line. */
function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Assert deep equality of two plain values. */
function checkEqual(label, actual, expected) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  check(label, left === right, `expected ${right}, got ${left}`)
}

// ── the synthetic deployment ────────────────────────────────────────────────

const CWD = 'C:\\work\\demo'
const ARCHIVED = 'session-11111111-1111-4111-8111-111111111111'
const ACTIVE = 'session-22222222-2222-4222-8222-222222222222'
const ALREADY_GONE = 'session-33333333-3333-4333-8333-333333333333'

/** Where the JSONL backend would put a session, derived by the plugin's own port. */
function expectedSessionDir(id) {
  return join(HOME, 'sessions', plugin.projectKey(CWD), plugin.encodeSegment(id))
}

/** Write the two log generations a migrated session can hold, plus a stray file. */
async function writeSessionDir(id, { migrated = false } = {}) {
  const dir = expectedSessionDir(id)
  await mkdir(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session',
    version: 4,
    id,
    createdAt: 1791386038511,
    cwd: CWD,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${header}\n`)))
  if (migrated) await writeFile(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(`${header}\n`)))
  await writeFile(join(dir, 'notes.txt'), 'a session-local artifact')
  return dir
}

/** The projection-cache document the JSON per-record backend would write. */
async function writeProjectionCache(id) {
  const dir = join(HOME, 'storages', 'session_projcache', 'sessions')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${plugin.encodeSegment(id)}.json`)
  await writeFile(path, JSON.stringify({ version: 7, record: { identity: { formatVersion: 4 } } }))
  return path
}

/**
 * A context stub plus the services the deletion path reads.
 *
 * The services reach the plugin ONLY through the handles `apply` publishes, the
 * same wiring production uses. A bare `ctx.sessions`/`ctx.workspaceRegistry` read
 * is deliberately not available: on a real Cordis context it THROWS
 * `cannot get property "<name>" without inject` rather than answering undefined,
 * and that is precisely the defect this suite must not be able to hide.
 *
 * The registry stub models the two APIs the deletion path cleans up through —
 * `Workspace.detachSession` and `WorkspaceRegistry.unarchiveSession` — and
 * records every call, so the suite can prove the record cleanup happens, and
 * happens through those APIs rather than by rewriting the storage file.
 */
function makeContext({ archived, live, workspaces = [] }) {
  const deleted = []
  const detached = []
  const unarchived = []
  const archiveSet = new Set(archived)
  const table = {
    async delete(key) {
      deleted.push(key)
      const path = join(HOME, 'storages', 'session_projcache', 'sessions', `${plugin.encodeSegment(key)}.json`)
      if (!existsSync(path)) return false
      await rm(path, { force: true })
      return true
    },
  }
  const records = workspaces.map((sessionIds) => ({
    sessionIds: [...sessionIds],
    async detachSession(sessionId) {
      detached.push(sessionId)
      if (!this.sessionIds.includes(sessionId)) return
      this.sessionIds = this.sessionIds.filter((id) => id !== sessionId)
    },
  }))
  plugin.setHostServices({
    sessions: { list: () => live.map((id) => ({ id })) },
    workspaceRegistry: {
      get archivedSessionIds() {
        return [...archiveSet]
      },
      list: () => records,
      async unarchiveSession(sessionId) {
        unarchived.push(sessionId)
        archiveSet.delete(sessionId)
      },
    },
    storageDomain: { get: (name) => (name === 'session_projcache' ? { table: () => table } : undefined) },
  })
  return {
    logger: { info() {}, warn() {}, error() {} },
    deletedViaDomain: deleted,
    detached,
    unarchived,
    records,
  }
}

/**
 * A context stub that runs `apply` and records what it registers, without a
 * Cordis runtime: `inject` queues its callbacks so the test can hand them the
 * services it wants available.
 */
function makeApplyHarness({ archived, live }) {
  const routes = new Map()
  const tools = new Map()
  const disposers = []
  // The registry stub models the APIs the deletion path cleans up through, the
  // same ones `makeContext` models, so `apply`-driven cases can delete too.
  const detached = []
  const unarchived = []
  const archiveSet = new Set(archived)
  const tables = []
  const table = {
    async delete(key) {
      const path = join(HOME, 'storages', 'session_projcache', 'sessions', `${plugin.encodeSegment(key)}.json`)
      if (!existsSync(path)) return false
      await rm(path, { force: true })
      return true
    },
  }
  const services = {
    sessions: { list: () => live.map((id) => ({ id })) },
    workspaceRegistry: {
      get archivedSessionIds() {
        return [...archiveSet]
      },
      list: () => tables,
      async unarchiveSession(sessionId) {
        unarchived.push(sessionId)
        archiveSet.delete(sessionId)
      },
    },
    storageDomain: { get: (name) => (name === 'session_projcache' ? { table: () => table } : undefined) },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  const pending = []
  const logger = { info() {}, warn() {}, error() {} }
  const effect = (run) => {
    const dispose = run()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }
  const context = {
    logger,
    inject(names, callback) {
      pending.push({ names, callback })
      return undefined
    },
    effect,
  }
  // An `inject` callback receives a real child context carrying the same
  // facilities — `effect`, `logger` and the resolved services — so the harness
  // can hand it something the plugin's own code can actually use.
  const childFor = (names) => ({
    logger,
    effect,
    ...Object.fromEntries(names.map((name) => [name, services[name]])),
  })
  return { context, services, routes, tools, pending, disposers, childFor, detached, unarchived, tables }
}

/** A fake `res` that records what a route handler wrote. */
function makeResponse() {
  const state = { status: 0, headers: undefined, body: '' }
  return {
    state,
    headersSent: false,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
      this.headersSent = true
    },
    end(text) {
      if (text !== undefined) state.body += String(text)
    },
  }
}

// ── case 1: the archive gate ────────────────────────────────────────────────

console.log('\ncase 1 — an unarchived session is refused and untouched')
const activeDir = await writeSessionDir(ACTIVE)
const activeCache = await writeProjectionCache(ACTIVE)
{
  const ctx = makeContext({ archived: [], live: [] })
  const result = await plugin.deleteSessionArtifacts(ctx, ACTIVE)
  check('refused', result.deleted === false)
  check('reason names archiving', String(result.reason).includes('归档'), result.reason)
  check('session directory survives', existsSync(activeDir))
  check('projection cache survives', existsSync(activeCache))
  check('nothing reached the storage domain', ctx.deletedViaDomain.length === 0)
  check('no workspace record was touched', ctx.detached.length === 0 && ctx.unarchived.length === 0)
}

// ── case 2: the live guard, with force on ───────────────────────────────────

console.log('\ncase 2 — a force request still refuses a session live in this process')
{
  const ctx = makeContext({ archived: [ACTIVE], live: [ACTIVE] })
  const result = await plugin.deleteSessionArtifacts(ctx, ACTIVE, { force: true })
  check('refused', result.deleted === false)
  check('reason names liveness', String(result.reason).includes('活动'), result.reason)
  check('session directory survives', existsSync(activeDir))
}

// ── case 3: an archived id with nothing left on disk ────────────────────────
//
// This is the case a real profile produced: a conversation still listed in the
// archived group whose log and cache were already gone. It is not a refusal — it
// is the stale bookkeeping this plugin exists to clear.

console.log('\ncase 3 — an archived id with nothing left on disk has its records cleared')
{
  const ctx = makeContext({ archived: [ALREADY_GONE], live: [], workspaces: [[ALREADY_GONE]] })
  const result = await plugin.deleteSessionArtifacts(ctx, ALREADY_GONE)
  check('reported as deleted', result.deleted === true, JSON.stringify(result))
  check('nothing was removed from disk', result.removedFiles === 0, String(result.removedFiles))
  checkEqual('the archive entry was cleared', ctx.unarchived, [ALREADY_GONE])
  checkEqual('the grouping record was cleared', ctx.detached, [ALREADY_GONE])
  check('no reason is reported', result.reason === undefined, String(result.reason))
}

console.log('\ncase 3b — an UNARCHIVED id with nothing on disk is still refused')
{
  const ctx = makeContext({ archived: [], live: [] })
  const result = await plugin.deleteSessionArtifacts(ctx, ALREADY_GONE)
  check('refused', result.deleted === false)
  check('reason names archiving', String(result.reason).includes('归档'), result.reason)
  check('no record was touched', ctx.detached.length === 0 && ctx.unarchived.length === 0)
}

// ── case 4: the real thing ──────────────────────────────────────────────────

console.log('\ncase 4 — an archived session loses its log, its cache, its project shell and its records')
const archivedDir = await writeSessionDir(ARCHIVED, { migrated: true })
const archivedCache = await writeProjectionCache(ARCHIVED)
{
  // The workspace that recorded this session, plus a second one that did not —
  // so the suite can prove only the holding record is touched.
  const BYSTANDER_SESSION = 'session-88888888-8888-4888-8888-888888888888'
  const ctx = makeContext({
    archived: [ARCHIVED],
    live: [],
    workspaces: [
      [BYSTANDER_SESSION],
      [BYSTANDER_SESSION, ARCHIVED],
    ],
  })
  const result = await plugin.deleteSessionArtifacts(ctx, ARCHIVED)
  check('deleted', result.deleted === true, JSON.stringify(result))
  check('session directory removed', !existsSync(archivedDir))
  check('projection cache removed', !existsSync(archivedCache))
  check('both log generations were counted', result.removedFiles === 3, String(result.removedFiles))
  check('freed bytes are non-zero', result.freedBytes > 0, String(result.freedBytes))
  check('the cache went through the storage domain', ctx.deletedViaDomain.includes(ARCHIVED))
  checkEqual('no errors', result.errors, [])
  // The archive entry and the grouping membership are gone, through the
  // registry's own API.
  checkEqual('the holding workspace was detached', ctx.detached, [ARCHIVED])
  checkEqual('the archive entry was removed', ctx.unarchived, [ARCHIVED])
  check('the holding record no longer lists the session', !ctx.records[1].sessionIds.includes(ARCHIVED), JSON.stringify(ctx.records[1].sessionIds))
  check('the bystander record is untouched', ctx.records[0].sessionIds.length === 1 && ctx.records[0].sessionIds[0] === BYSTANDER_SESSION, JSON.stringify(ctx.records[0].sessionIds))
  check('the result reports the cleanup', result.detach === 1 && result.unarchive === 'done', JSON.stringify({ detach: result.detach, unarchive: result.unarchive }))
  // A sibling session still lives in this project directory, so the shell must
  // survive — the cleanup may only drop a project directory that is now empty.
  check('a shared project directory survives', existsSync(join(HOME, 'sessions', plugin.projectKey(CWD))))
}

// ── case 4b: an emptied project directory is cleaned up ─────────────────────

console.log('\ncase 4b — the project shell goes only when its last session does')
{
  const SOLO_CWD = 'C:\\work\\solo'
  const SOLO_A = 'session-55555555-5555-4555-8555-555555555555'
  const SOLO_B = 'session-66666666-6666-4666-8666-666666666666'
  const soloDir = join(HOME, 'sessions', plugin.projectKey(SOLO_CWD))
  const write = async (id) => {
    const dir = join(soloDir, plugin.encodeSegment(id))
    await mkdir(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd: SOLO_CWD, isSeeded: false, delegationDepth: 0 })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${header}\n`)))
  }
  await write(SOLO_A)
  await write(SOLO_B)
  const ctx = makeContext({ archived: [SOLO_A, SOLO_B], live: [] })
  await plugin.deleteSessionArtifacts(ctx, SOLO_A)
  check('the shell survives its first deletion', existsSync(soloDir))
  await plugin.deleteSessionArtifacts(ctx, SOLO_B)
  check('the shell goes with its last session', !existsSync(soloDir))
}

// ── case 5: the preflight preview reports exactly what deletion removes ─────

console.log('\ncase 5 — the preview a person confirms against matches the deletion')
const PREVIEWED = 'session-44444444-4444-4444-8444-444444444444'
{
  await writeSessionDir(PREVIEWED, { migrated: true })
  await writeProjectionCache(PREVIEWED)
  const ctx = makeContext({ archived: [PREVIEWED], live: [] })
  const listing = await plugin.listArchived(ctx, 50)
  const row = listing.rows.find((entry) => entry.id === PREVIEWED)
  check('the archived session is listed', row !== undefined)
  check('the listing saw the files', row !== undefined && row.files === 3, JSON.stringify(row))
  check('the listing saw a creation time', row !== undefined && row.createdAt === 1791386038511, JSON.stringify(row?.createdAt))
  check('the listing saw the recorded cwd', row !== undefined && row.cwd === CWD, JSON.stringify(row?.cwd))
  check('the listing is not marked live', row !== undefined && row.live === false)
  const cached = await readProjectionCache(PREVIEWED)
  check('preview counted the cache document too', row !== undefined && row.bytes > cached, String(row?.bytes))
  check('the cache size is a number', typeof cached === 'number', typeof cached)
  const result = await plugin.deleteSessionArtifacts(ctx, PREVIEWED)
  check('deletion then succeeds', result.deleted === true, JSON.stringify(result))
  const previewedDir = expectedSessionDir(PREVIEWED)
  check('the derived directory is a primitive string',
    typeof previewedDir === 'string' && Object.getPrototypeOf(previewedDir) === String.prototype,
    `${typeof previewedDir} / ${Object.prototype.toString.call(previewedDir)}`)
  const cachedPath = join(HOME, 'storages', 'session_projcache', 'sessions', `${plugin.encodeSegment(PREVIEWED)}.json`)
  check('everything the preview counted is gone', !existsSync(previewedDir) && !existsSync(cachedPath))
}

// ── case 6: the path ports match the backend's own algorithms ───────────────

console.log('\ncase 6 — the ported path algorithms reproduce the backend\'s own output')
{
  // Expected values are the backend's own, taken from a real deployment: a
  // non-ASCII path encodes one `~XXXX` escape per code unit, and a Windows path
  // collapses its separators into `-`.
  checkEqual('projectKey of a CJK path', plugin.projectKey('E:\\示例\\演示项目\\输出'), '--E-~793A~4F8B-~6F14~793A~9879~76EE-~8F93~51FA--')
  checkEqual('projectKey of a plain Windows path', plugin.projectKey(CWD), '--C-work-demo--')
  checkEqual('projectKey collapses separator runs', plugin.projectKey('C:\\\\a//b'), '--C-a-b--')
  // `C:\` keeps a trailing separator run, so the backend's own key ends in three
  // dashes: two from the `--…--` wrapper plus the one the drive separator became.
  checkEqual('projectKey of a bare root', plugin.projectKey('C:\\'), '--C---')
  checkEqual('encodeSegment leaves a session id alone', plugin.encodeSegment('session-abc.def_1'), 'session-abc.def_1')
  // `.` and `/` are treated differently on purpose: `.` is a safe literal unless
  // the whole segment is `.`/`..`, while `/` is escaped — which is exactly what
  // makes a traversal-shaped id a harmless directory name.
  checkEqual('encodeSegment neutralizes traversal', plugin.encodeSegment('../x'), '..~002Fx')
  checkEqual('encodeSegment escapes a lone dot segment', plugin.encodeSegment('.'), '~002E')
  checkEqual('encodeSegment escapes a dot-dot segment', plugin.encodeSegment('..'), '~002E~002E')
  checkEqual('encodeSegment escapes a separator', plugin.encodeSegment('a/b'), 'a~002Fb')
  check('encodeSegment rejects the empty id', throws(() => plugin.encodeSegment('')), 'it did not throw')
  const header = await plugin.readLogHeader(join(expectedSessionDir(ACTIVE), 'session.v4.jsonl.zstd'))
  checkEqual('readLogHeader decodes the first frame', header?.id, ACTIVE)
  checkEqual('readLogHeader reports the cwd', header?.cwd, CWD)
}

// ── case 7: a traversal-shaped id cannot escape the sessions root ───────────

console.log('\ncase 7 — a hostile session id cannot escape the sessions root')
{
  const evil = '..\\..\\..\\Windows\\System32'
  const canary = join(HOME, 'canary.txt')
  await writeFile(canary, 'must survive')
  const ctx = makeContext({ archived: [evil], live: [] })
  const result = await plugin.deleteSessionArtifacts(ctx, evil)
  // The safety property is about the FILESYSTEM, not about the verdict: an id
  // like this is encoded into one harmless directory name, so the operation may
  // legitimately clear its (non-existent) bookkeeping — what it must never do is
  // touch anything outside the sessions root.
  check('no file was removed', result.removedFiles === 0, JSON.stringify(result))
  check('no directory path was resolved', result.dir === undefined, String(result.dir))
  check('canary survives', existsSync(canary))
  check('sessions root survives', existsSync(join(HOME, 'sessions')))
  check('the encoded name stayed one segment', !plugin.encodeSegment(evil).includes('/') && !plugin.encodeSegment(evil).includes('\\'), plugin.encodeSegment(evil))
}

/** Whether a thunk throws. */
function throws(fn) {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

/** The cache document size, for the comparison in case 5. */
async function readProjectionCache(id) {
  return (await stat(join(HOME, 'storages', 'session_projcache', 'sessions', `${plugin.encodeSegment(id)}.json`))).size
}

// ── case 8: `apply` wiring, against the defect that shipped once ────────────
//
// The first build answered a bare `ctx.workspaceRegistry` read behind a
// try/catch. On a real Cordis context that read THROWS, so `/archived` answered
// 500 and the archive gate believed nothing was archived. This case runs `apply`
// itself, serves both routes through the harness, and asserts a 200 payload —
// which a bare-property read cannot produce, because the harness context has no
// service properties at all.

console.log('\ncase 8 — apply() resolves its services through inject and serves the routes')
{
  const APPLY_CWD = 'C:\\work\\apply-case'
  const APPLY_ID = 'session-77777777-7777-4777-8777-777777777777'
  const applyDir = join(HOME, 'sessions', plugin.projectKey(APPLY_CWD), plugin.encodeSegment(APPLY_ID))
  await mkdir(applyDir, { recursive: true })
  const applyHeader = JSON.stringify({ type: 'session', version: 4, id: APPLY_ID, createdAt: 42, cwd: APPLY_CWD, isSeeded: false, delegationDepth: 0 })
  await writeFile(join(applyDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${applyHeader}\n`)))
  const applyCache = await writeProjectionCache(APPLY_ID)

  const harness = makeApplyHarness({ archived: [APPLY_ID], live: [] })
  plugin.apply(harness.context, { menuEnabled: true })

  check('apply queued its injections', harness.pending.length >= 4, String(harness.pending.length))
  // Resolve each injection exactly as the loader would: when every named service
  // is available, the callback runs with a child context carrying them.
  for (const entry of harness.pending) {
    const available = entry.names.every((name) => harness.services[name] !== undefined)
    if (available) entry.callback(harness.childFor(entry.names))
  }
  check('routes registered', harness.routes.has(`${plugin.ROUTE}/archived`) && harness.routes.has(`${plugin.ROUTE}/preview`))
  check('the agent tool registered', harness.tools.has('archive_delete'))

  const listing = makeResponse()
  await harness.routes.get(`${plugin.ROUTE}/archived`).handler({ method: 'GET', url: `${plugin.ROUTE}/archived`, headers: { host: '127.0.0.1:19387' } }, listing)
  await settle(listing)
  check('the archived route answers 200', listing.state.status === 200, `${String(listing.state.status)} ${listing.state.body}`)
  const listingBody = JSON.parse(listing.state.body)
  check('the archived route reports the archived session', listingBody.total === 1 && listingBody.rows[0].id === APPLY_ID, listing.state.body)

  const preview = makeResponse()
  await harness.routes.get(`${plugin.ROUTE}/preview`).handler({
    method: 'GET',
    url: `${plugin.ROUTE}/preview?id=${APPLY_ID}`,
    headers: { host: '127.0.0.1:19387' },
  }, preview)
  await settle(preview)
  check('the preview route answers 200', preview.state.status === 200, `${String(preview.state.status)} ${preview.state.body}`)
  check('the preview reports it archived', JSON.parse(preview.state.body).archived === true, preview.state.body)

  // The write route, exactly as the browser half calls it.
  const removal = makeResponse()
  const request = {
    method: 'POST',
    url: `${plugin.ROUTE}/delete`,
    headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ ids: [APPLY_ID] }))
    },
  }
  await harness.routes.get(`${plugin.ROUTE}/delete`).handler(request, removal)
  await settle(removal)
  check('the delete route answers 200', removal.state.status === 200, `${String(removal.state.status)} ${removal.state.body}`)
  check('the delete route deleted the session', !existsSync(applyDir), removal.state.body)
  check('the delete route removed the cache', !existsSync(applyCache), removal.state.body)

  // A cross-site page must not be able to reach the write route.
  const crossSite = makeResponse()
  await harness.routes.get(`${plugin.ROUTE}/delete`).handler({ ...request, headers: { ...request.headers, origin: 'http://evil.example' } }, crossSite)
  await settle(crossSite)
  check('a cross-origin write is refused', crossSite.state.status === 403, `${String(crossSite.state.status)} ${crossSite.state.body}`)

  // And the tool refuses an unconfirmed deletion rather than trusting the model.
  let toolRefused = false
  try {
    await harness.tools.get('archive_delete').execute({ action: 'delete', ids: [APPLY_ID] })
  } catch {
    toolRefused = true
  }
  check('the tool demands confirm=true', toolRefused)
}

// ── case 9: the tool's own output must be lossless JSON ─────────────────────
//
// This is the defect a real profile produced. A tool result is validated with
// `snapshotJsonValue`, which rejects an object property whose value is
// `undefined` — and an archived id with nothing left on disk legitimately has no
// `createdAt` and no `cwd`. The listing therefore answered
// "value is not lossless JSON" and the Agent could not delete anything at all.
// The check below walks the tool's REAL result the way that validator does.

console.log('\ncase 9 — the Agent tool answers with lossless JSON, ghosts included')
{
  const GHOST = 'session-99999999-9999-4999-8999-999999999999'
  const ghostDir = join(HOME, 'sessions', plugin.projectKey(CWD), plugin.encodeSegment(GHOST))
  await mkdir(ghostDir, { recursive: true })
  const ghostHeader = JSON.stringify({ type: 'session', version: 4, id: GHOST, createdAt: 1791386038511, cwd: CWD, isSeeded: false, delegationDepth: 0 })
  await writeFile(join(ghostDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${ghostHeader}\n`)))

  const harness = makeApplyHarness({ archived: [GHOST, ALREADY_GONE], live: [] })
  plugin.apply(harness.context, { menuEnabled: false, allowAgentDeleteActive: false })
  for (const entry of harness.pending) {
    if (entry.names.every((name) => harness.services[name] !== undefined)) entry.callback(harness.childFor(entry.names))
  }
  const tool = harness.tools.get('archive_delete')
  check('the tool is registered', tool !== undefined)

  const listing = await tool.execute({ action: 'list' })
  const violations = findUndefined(listing)
  checkEqual('no undefined survives in the listing', violations, [])
  check('the listing reports both archived ids', listing.total === 2 && listing.rows.length === 2, JSON.stringify(listing))
  const ghostRow = listing.rows.find((row) => row.id === ALREADY_GONE)
  check('a row with nothing on disk still carries explicit nulls',
    ghostRow !== undefined && ghostRow.createdAt === null && ghostRow.cwd === null, JSON.stringify(ghostRow))

  const deletion = await tool.execute({ action: 'delete', ids: [GHOST], confirm: true })
  const deleteViolations = findUndefined(deletion)
  checkEqual('no undefined survives in the delete result', deleteViolations, [])
  check('the ghost-free session was deleted', deletion.results[0].deleted === true, JSON.stringify(deletion))
  check('a missing artifact path is an explicit null', deletion.results[0].dir === null || typeof deletion.results[0].dir === 'string', JSON.stringify(deletion.results[0]))

  // A refusal is the other shape the tool returns, and it must be JSON-safe too.
  const refused = await tool.execute({ action: 'delete', ids: [ALREADY_GONE], confirm: true })
  checkEqual('no undefined survives in a refusal either', findUndefined(refused), [])
  check('the archived-but-empty id is cleared rather than refused', refused.results[0].deleted === true, JSON.stringify(refused))

  check('the tool rendered a text result', typeof tool.output.render === 'function'
    && Array.isArray(tool.output.render({ action: 'list' }, listing)), 'render must return content blocks')
}

/**
 * Every path at which a value is `undefined`, the way the kernel's
 * `snapshotJsonValue` sees it: an object property or array slot that holds
 * `undefined` makes the whole value non-lossless.
 * @param value - the candidate tool output.
 * @returns dotted paths of every `undefined` found.
 */
function findUndefined(value, path = '', seen = new Set()) {
  if (value === undefined) return [path === '' ? '(root)' : path]
  if (typeof value !== 'object' || value === null || seen.has(value)) return []
  seen.add(value)
  const found = []
  for (const key of Object.keys(value)) {
    found.push(...findUndefined(value[key], path === '' ? key : `${path}.${key}`, seen))
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findUndefined(item, `${path}[${String(index)}]`, seen)))
  }
  return found
}

/** Wait until a route handler's floating promise has written its response. */
async function settle(response) {
  for (let i = 0; i < 200; i++) {
    if (response.state.status !== 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ── teardown ────────────────────────────────────────────────────────────────

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) console.log(`HOME kept for inspection: ${HOME}`)
else await rm(HOME, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
