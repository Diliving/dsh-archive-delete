// dsh-archive-delete — offline Client-half suite.
//
// The Host half is proven by `verify-dry-run.mjs`. This one covers the browser
// half, which is where the first shipped build failed in the field: the menu row
// rendered, but clicking it did nothing, because the dialog was mounted with
// `runtime.createRoot(...)` while the module table's `React` is a TRIMMED runtime
// that has no `createRoot` at all — the call was `undefined(...)` and threw
// inside the click's state update.
//
// So this suite loads the REAL `client.js` through a fake
// `window.__ModuleLoader__`, renders the menu row through a minimal hook runtime
// that models EXACTLY the module table's React surface (`createElement` and the
// hooks, and NO root API — reading `createRoot`/`createPortal` is recorded as a
// failure), clicks the row, and drives the dialog's cancel and confirm paths
// against a fake `fetch`.
//
// Two rules keep this suite honest and terminating:
//   * every hook the component uses is provided, and nothing more;
//   * tree walks carry a visited set and a depth bound, so a malformed tree
//     reports a failure instead of looping.
//
// Run: node verify-client.mjs
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── the browser environment ─────────────────────────────────────────────────

/** Elements the bundle's `document` hands out; purely a stub, never walked. */
const styleTags = []
function makeElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: {},
    children: [],
    textContent: '',
    parentNode: null,
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    remove() {},
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  if (tag === 'style') styleTags.push(node)
  return node
}

const head = makeElement('head')
const body = makeElement('body')
/** Walk the whole (small) stub tree, so install-once checks can be honest. */
function findInTree(root, predicate, seen = new Set()) {
  if (root === null || root === undefined || seen.has(root)) return null
  seen.add(root)
  if (root.dataset !== undefined && predicate(root)) return root
  for (const child of root.children ?? []) {
    const found = findInTree(child, predicate, seen)
    if (found !== null) return found
  }
  return null
}

const clientLogs = []
const clientErrors = []
const consoleStub = {
  log: (...args) => clientLogs.push(args.map(String).join(' ')),
  warn: (...args) => clientLogs.push(`warn: ${args.map(String).join(' ')}`),
  error: (...args) => {
    clientErrors.push(args.map(String).join(' '))
    clientLogs.push(`error: ${args.map(String).join(' ')}`)
  },
}

const documentStub = {
  head,
  body,
  createElement: makeElement,
  // The bundle's install-once guard is
  // `querySelector('style[data-plugin-css="…"]')`, so the stub answers it by
  // actually looking for the marker instead of always saying "absent" — that is
  // what makes the "installed exactly once" assertion meaningful.
  querySelector: (selector) => {
    const match = /data-plugin-css="([^"]+)"/.exec(String(selector))
    if (match === null) return null
    return findInTree(head, (node) => node.dataset.pluginCss === match[1])
  },
  addEventListener() {},
  removeEventListener() {},
}

/** React APIs the browser module table does NOT expose; touching one is a defect. */
const forbiddenTouches = []

/**
 * The `React` the bundle gets: `createElement`, the hooks it declares, and
 * `Fragment`. Each forbidden name is an accessor that records the touch and
 * returns undefined, which is what the real table does (the property is simply
 * absent, so the read yields `undefined` and the call throws).
 */
function makeModuleTableReact() {
  const hookState = new Map()
  let cursor = 0
  const api = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
      }
    },
    useState(initial) {
      const index = cursor++
      if (!hookState.has(index)) hookState.set(index, typeof initial === 'function' ? initial() : initial)
      const setter = (next) => {
        hookState.set(index, typeof next === 'function' ? next(hookState.get(index)) : next)
      }
      return [hookState.get(index), setter]
    },
    useRef(initial) {
      const index = cursor++
      if (!hookState.has(index)) hookState.set(index, { current: initial })
      return hookState.get(index)
    },
    useEffect(effect) {
      const index = cursor++
      // React runs an effect after mounting. Running it here — once per slot,
      // immediately — is what lets the dialog host subscribe to the store the
      // same way it does in the page; a dependency array is ignored because the
      // components below pass none.
      if (!hookState.has(`effect:${index}`)) {
        hookState.set(`effect:${index}`, true)
        const cleanup = effect()
        if (typeof cleanup === 'function') hookState.set(`cleanup:${index}`, cleanup)
      }
    },
    useCallback(fn) {
      cursor += 1
      return fn
    },
    useMemo(fn) {
      cursor += 1
      return fn()
    },
    Fragment: Symbol.for('react.fragment'),
    __resetCursor() {
      cursor = 0
    },
    __forgetState() {
      hookState.clear()
    },
  }
  for (const missing of ['createRoot', 'createPortal', 'render', 'useSyncExternalStore']) {
    Object.defineProperty(api, missing, {
      get() {
        forbiddenTouches.push(missing)
        return undefined
      },
    })
  }
  return api
}

const React = makeModuleTableReact()
const ReactDomStub = {
  createRoot() {
    forbiddenTouches.push('react-dom.createRoot')
    return undefined
  },
}

// ── load the real bundle ────────────────────────────────────────────────────

const source = await readFile(fileURLToPath(new URL('./client.js', import.meta.url)), 'utf8')
// The bundle resolves `window.fetch` at call time, so the window stub is where
// the route stubs must live — not on `globalThis`, which the bundle never reads.
const windowStub = {
  __ModuleLoader__: {
    load(registration) {
      globalThis.__registration = registration
    },
  },
}
windowStub.fetch = async (url) => {
  throw new Error(`the bundle must not fetch during load or materialisation (saw ${url})`)
}
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'console', 'fetch', source)(
  windowStub,
  documentStub,
  consoleStub,
  // A pass-through, not a snapshot: the bundle captures this once at
  // materialisation, so it must delegate to whatever `window.fetch` holds at
  // CALL time — that is how the per-case route stubs below take effect.
  (url, options) => windowStub.fetch(url, options),
)

const registration = globalThis.__registration
console.log('\ncase A — the bundle contract')
check('it registers a factory under the plugin id', registration !== undefined && registration.id === 'dsh-archive-delete')
check('no React root API was touched while loading', forbiddenTouches.length === 0, forbiddenTouches.join(','))

const required = []
const exports = registration.factory((specifier) => {
  required.push(specifier)
  if (specifier === 'react') return React
  if (specifier === 'react-dom' || specifier === 'react-dom/client') return ReactDomStub
  throw new Error(`unexpected require(${specifier})`)
})
check('it requires react, and only react', required.join(',') === 'react', required.join(','))
check('it exports apply', typeof exports.apply === 'function')
check('no React root API was touched while materialising', forbiddenTouches.length === 0, forbiddenTouches.join(','))

// ── wire the client context the way the shell does ──────────────────────────

const registrations = []
const slots = {
  inject(key, factory) {
    return factory()
  },
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
}
let ownerCallback = null
exports.apply({ inject(names, callback) { ownerCallback = callback }, get: () => undefined })
check('apply reaches for its injection', ownerCallback !== null)
check('apply installed its stylesheet into head',
  head.children.filter((node) => node.dataset.pluginCss === 'dsh-archive-delete-style').length === 1,
  JSON.stringify(head.children.map((node) => node.tagName)))
ownerCallback({
  effect: (run) => run(),
  get: (name) => (name === 'slots' ? slots : undefined),
})
check('exactly two slot entries registered', registrations.length === 2, String(registrations.length))

const entry = registrations.find((candidate) => candidate.options.name === 'sidebar.workspaces.session.menu.item')
const overlayEntry = registrations.find((candidate) => candidate.options.name === 'shell.overlay')
console.log('\ncase B — the registrations')
check('the row targets the session menu seat', entry !== undefined)
check('the row id is the plugin id', entry.options.id === 'dsh-archive-delete')
check('the row sits after the shipped archive row (400)', entry.options.order === 500, String(entry.options.order))
check('the dialog host targets the root floating layer', overlayEntry !== undefined, JSON.stringify(registrations.map((r) => r.options.name)))
check('the dialog host has its own id', overlayEntry.options.id === 'dsh-archive-delete.dialog')

// ── the render harness ──────────────────────────────────────────────────────

const SESSION_ID = 'session-44444444-4444-4444-8444-444444444444'
let closeMenuCalls = 0
/**
 * The label function the entry injects. It is the Chinese dictionary the bundle
 * ships, minus the locale service, so the assertions below read the same words a
 * user does.
 */
const dictionary = {
  menuDelete: '永久删除',
  dialogTitle: '永久删除这个会话',
  dialogIntro: '只删除已归档的会话。确认后立刻从磁盘移除，无法恢复。',
  dialogSession: '会话',
  dialogLocation: '位置',
  dialogFiles: '文件',
  dialogBytes: '占用',
  dialogCreated: '创建于',
  dialogWarn: '将执行的操作：',
  dialogRemoveLog: '删除该会话目录（含会话日志）',
  dialogRemoveCache: '删除它的投影缓存记录',
  dialogKeepRow: '工作区里的归档条目会留下，但它已不再指向任何会话，等同于已删除。',
  cancel: '取消',
  confirm: '永久删除',
  working: '正在删除…',
  failed: '删除失败',
  previewFailed: '无法读取会话信息',
}
const t = (key) => dictionary[key] ?? key

/**
 * Render the menu row once, as a fresh mount: a fresh hook state and cursor,
 * which is what React does when the menu opens.
 * @param archivedList - the archive set the `useWorkspaces` hook should project.
 * @param menuOpen - whether the menu counts as open, to capture the dismiss call.
 */
function render(archivedList, menuOpen = true) {
  React.__resetCursor()
  React.__forgetState()
  const tree = entry.component({
    sessionId: SESSION_ID,
    displayTitle: '一个已归档会话',
    useWorkspaces: (selector) => selector({ archivedSessionIds: archivedList }),
    useMenuOpenState: () => [menuOpen, () => {
      closeMenuCalls += 1
    }],
    t,
  })
  // Expand function components exactly as React would, so the assertions below
  // see the dialog's real tree rather than the `<ConfirmDialog>` element itself.
  return expand(tree)
}

/**
 * Render the dialog host on the root floating layer.
 *
 * Read fresh from the store each time, which is what the subscription in the
 * component's effect causes React to do when the store notifies it.
 */
function renderOverlay() {
  React.__resetCursor()
  React.__forgetState()
  const tree = overlayEntry.component({ t })
  return expand(tree)
}

/** The CSS text of this bundle's style tag. */
function styleTagText() {
  const tag = head.children.find((node) => node.dataset.pluginCss === 'dsh-archive-delete-style')
  return tag === undefined ? '' : String(tag.textContent)
}

/** Click the menu row, as a user's pointer does. */
function openRow(menuOpen = true) {
  const tree = render([SESSION_ID], menuOpen)
  const button = find(tree, (node) => node.type === 'button' && node.props.role === 'menuitem')
  button.props.onClick({})
  return button
}

/** Resolve one element the way React would: a function type is a component. */
function resolveNode(node, depth) {
  if (node === null || node === undefined || depth > 32) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((child) => resolveNode(child, depth + 1))
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') {
    // A function component's own hooks run through the shared cursor, which is
    // exactly what a real render does.
    return resolveNode(node.type(node.props), depth + 1)
  }
  return {
    type: node.type,
    props: node.props,
    children: (Array.isArray(node.children) ? node.children : []).map((child) => resolveNode(child, depth + 1)),
  }
}

/** Fully expanded tree, ready for assertions. */
function expand(tree) {
  return resolveNode(tree, 0)
}

/** Depth- and cycle-bounded tree walk for one predicate. */
function find(tree, predicate) {
  const seen = new Set()
  const walk = (node, depth) => {
    if (node === null || node === undefined || depth > 64) return null
    if (typeof node !== 'object') return null
    if (seen.has(node)) return null
    seen.add(node)
    if (predicate(node)) return node
    for (const child of Array.isArray(node.children) ? node.children : []) {
      const found = walk(child, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  return walk(tree, 0)
}

function textOf(tree) {
  const seen = new Set()
  const walk = (node, depth) => {
    if (node === null || node === undefined || depth > 64) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (typeof node !== 'object' || seen.has(node)) return ''
    seen.add(node)
    return (Array.isArray(node.children) ? node.children : []).map((child) => walk(child, depth + 1)).join(' ')
  }
  return walk(tree, 0)
}

function buttonsWith(tree, text) {
  const found = []
  const seen = new Set()
  const walk = (node, depth) => {
    if (node === null || node === undefined || typeof node !== 'object' || depth > 64 || seen.has(node)) return
    seen.add(node)
    if (node.type === 'button' && textOf(node).includes(text)) found.push(node)
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, depth + 1)
  }
  walk(tree, 0)
  return found
}

// ── case C: only an archived conversation gets a row ────────────────────────

console.log('\ncase C — visibility follows the archive set')
check('a live conversation contributes no row', render([]) === null, JSON.stringify(render([])))
const first = render([SESSION_ID])
check('an archived conversation contributes a row', first !== null)

// The host is subscribed for the whole session, so subscribe it first: every
// notification the row causes must reach it, exactly as in the page.
const idleHost = renderOverlay()
check('the dialog host renders nothing while idle', idleHost === null, JSON.stringify(idleHost))

// ── case D: the click that used to do nothing ───────────────────────────────

console.log('\ncase D — clicking the row opens the confirmation dialog')
const fetches = []
windowStub.fetch = async (url, options) => {
  fetches.push({ url, options })
  if (url.startsWith('/plugins/dsh-archive-delete/preview')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: SESSION_ID,
        archived: true,
        live: false,
        lockFile: false,
        writable: true,
        directory: `C:\\Users\\X\\.dsh\\sessions\\--C-X--\\${SESSION_ID}`,
        logFiles: ['session.v4.jsonl.zstd'],
        fileCount: 1,
        bytes: 4096,
        createdAt: 1791386038511,
        cwd: 'C:\\X',
      }),
    }
  }
  if (url === '/plugins/dsh-archive-delete/delete') {
    return { ok: true, status: 200, json: async () => ({ results: [{ id: SESSION_ID, deleted: true }], deleted: 1 }) }
  }
  throw new Error(`unexpected fetch ${url}`)
}

const menuButton = find(first, (node) => node.type === 'button' && node.props.role === 'menuitem')
check('the row is a real menuitem button', menuButton !== null)
check('the row is labelled for deletion', textOf(menuButton).includes('永久删除'), textOf(menuButton))

menuButton.props.onClick({})
check('the click asked the Host for a preview before closing the menu',
  fetches.length === 1 && fetches[0].url.includes('/preview?id='), JSON.stringify(fetches))
check('the menu is not dismissed before the request resolves', closeMenuCalls === 0, String(closeMenuCalls))
check('the click touched no React root API', forbiddenTouches.length === 0, forbiddenTouches.join(','))

await new Promise((resolve) => setTimeout(resolve, 0))
check('the menu is dismissed once the request is published', closeMenuCalls === 1, String(closeMenuCalls))

// ── case D2: the regression that shipped ────────────────────────────────────
//
// The row lives inside the menu's portal and is UNMOUNTED the moment the menu
// closes; this harness never renders the row again, which is exactly that
// situation. The dialog must still appear, because it is rendered by the host on
// the root floating layer — not by the row.

console.log('\ncase D2 — the dialog survives the menu that opened it')
const afterPublish = renderOverlay()
const overlay = find(afterPublish, (node) => String(node.props.className ?? '').includes('dsa-overlay'))
check('the dialog renders on the root floating layer', overlay !== null, JSON.stringify(afterPublish).slice(0, 400))
if (overlay === null) {
  console.log('  --- host tree ---')
  console.log(JSON.stringify(afterPublish, (key, value) => (key === 'type' && typeof value === 'function' ? String(value.name) : value), 1).slice(0, 2000))
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(1)
}
const dialogText = textOf(overlay)
check('it states the deletion cannot be undone', dialogText.includes('无法恢复'), dialogText.slice(0, 160))
check('it names the session', dialogText.includes(SESSION_ID))
check('it names what is removed', dialogText.includes('会话目录') && dialogText.includes('投影缓存'))
check('it reports the size from the preview', dialogText.includes('4.00 KB'), dialogText)
check('the modal backdrop opts back into pointer events',
  /\.dsa-overlay\{[^}]*pointer-events:auto/.test(styleTagText()), 'the floating layer is click-through, so the backdrop must opt in')
check('nothing was appended to document.body', body.children.length === 0, String(body.children.length))

// ── case E: cancel ──────────────────────────────────────────────────────────

console.log('\ncase E — cancel closes the dialog and deletes nothing')
const cancel = buttonsWith(overlay, '取消')[0]
check('the dialog offers cancel', cancel !== undefined)
const confirmButton = buttonsWith(overlay, '永久删除').find((button) => String(button.props.className).includes('danger'))
check('the dialog offers a destructive confirm', confirmButton !== undefined)
cancel.props.onClick()
check('cancel sent no delete', fetches.filter((f) => f.url.endsWith('/delete')).length === 0)
check('cancel closes the dialog', find(renderOverlay(), (node) => String(node.props.className ?? '').includes('dsa-overlay')) === null)

// ── case F: confirm ─────────────────────────────────────────────────────────

console.log('\ncase F — confirming posts the delete and closes the dialog')
openRow()
await new Promise((resolve) => setTimeout(resolve, 0))
const reopened = find(renderOverlay(), (node) => String(node.props.className ?? '').includes('dsa-overlay'))
check('the dialog reopens for a second request', reopened !== null)
const confirmAgain = buttonsWith(reopened, '永久删除').find((button) => String(button.props.className).includes('danger'))
confirmAgain.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const deletes = fetches.filter((f) => f.url.endsWith('/delete'))
check('exactly one delete request', deletes.length === 1, String(deletes.length))
check('it is a JSON POST', deletes[0] !== undefined && deletes[0].options.method === 'POST'
  && String(deletes[0].options.headers['content-type']).startsWith('application/json'), JSON.stringify(deletes[0]?.options))
check('it carries exactly the clicked id', deletes[0] !== undefined && deletes[0].options.body === JSON.stringify({ ids: [SESSION_ID] }), deletes[0]?.options.body)
check('the dialog closed after success', find(renderOverlay(), (node) => String(node.props.className ?? '').includes('dsa-overlay')) === null)

// ── case G: a refused deletion ──────────────────────────────────────────────

console.log('\ncase G — a refused deletion keeps the dialog and shows the reason')
windowStub.fetch = async (url) => {
  if (url.startsWith('/plugins/dsh-archive-delete/preview')) {
    return { ok: true, status: 200, json: async () => ({ id: SESSION_ID, archived: true, bytes: 1, fileCount: 1 }) }
  }
  return { ok: false, status: 403, json: async () => ({ error: 'Origin 与 Host 不一致，拒绝跨站请求' }) }
}
openRow()
await new Promise((resolve) => setTimeout(resolve, 0))
const refusing = buttonsWith(find(renderOverlay(), (node) => String(node.props.className ?? '').includes('dsa-overlay')), '永久删除')
  .find((button) => String(button.props.className).includes('danger'))
refusing.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const refusedOverlay = find(renderOverlay(), (node) => String(node.props.className ?? '').includes('dsa-overlay'))
check('the dialog survives the refusal', refusedOverlay !== null)
check('the refusal reason is shown', textOf(refusedOverlay).includes('拒绝跨站请求'), textOf(refusedOverlay).slice(0, 200))
const stillDeletable = buttonsWith(refusedOverlay, '永久删除').find((button) => String(button.props.className).includes('danger'))
check('the dialog is not left busy after a refusal', stillDeletable !== undefined && stillDeletable.props.disabled !== true)
check('a failed delete issued no root API call', forbiddenTouches.length === 0, forbiddenTouches.join(','))

// ── case H: the invariant that broke in the field ───────────────────────────

console.log('\ncase H — the bundle never reaches for a React root API')
check('no createRoot/createPortal/render call anywhere', forbiddenTouches.length === 0, forbiddenTouches.join(','))
check('the client never logged an error', clientErrors.length === 0, clientErrors.join(' | '))
check('the stylesheet stayed installed exactly once',
  head.children.filter((node) => node.dataset.pluginCss === 'dsh-archive-delete-style').length === 1,
  String(head.children.filter((node) => node.dataset.pluginCss === 'dsh-archive-delete-style').length))

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0 && clientLogs.length > 0) {
  console.log('--- client console output ---')
  for (const line of clientLogs) console.log(`  ${line}`)
}
process.exit(failures === 0 ? 0 : 1)
