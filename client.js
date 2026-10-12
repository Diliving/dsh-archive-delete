// DSH_archive_delete — Client half.
//
// One contribution: a row in the sidebar Session "..." menu that permanently
// deletes the conversation, contributed ONLY while that conversation is
// archived. The row is the plugin's whole reason to exist — the Host half can
// already delete, but a capability a person cannot reach is not a feature — and
// it is a menu row rather than a new page because it operates on exactly the
// thing the menu already addresses: `sidebar.workspaces.session.menu.item` is
// the seat `pin` (100), `rename` (200), `fork` (300) and `archive` (400) already
// occupy, and it arrives with the session id and its display title as owner
// props.
//
// Four facts about this surface were read out of the shipped client bundle
// rather than assumed, and each one shapes the code below:
//
//   1. The owner renders the slot as
//      `renderSlot(SLOT, { sessionId, displayTitle }, { hookContext })`, so the
//      session identity is an OWNER prop and the archive state comes from the
//      standard `useWorkspaces` selector hook. This plugin declares no state
//      hook of its own and therefore cannot disagree with the row about which
//      session it is on.
//   2. `ctx.slots.register` must be reached through `ctx.slots.inject(KEY, …)`.
//      `inject` forbids a duplicate KEY only, so a re-entry could still
//      double-register the ENTRY — and a duplicate registration throws inside
//      the ledger's notification, which kills the mounted row's updates while
//      leaving its DOM in place. The contribute/withdraw pair below is what
//      makes a repeat harmless.
//   3. Registering from the menu item's own `onSelect` would paint a modal inside
//      the menu, and the menu closes on the click that opens it. The confirm
//      dialog is therefore rendered as a sibling INSIDE this component's own tree,
//      on a fixed viewport-covering layer — see the note at the render site for
//      why a second React root on `document.body` is both unavailable here and
//      forbidden by the UI contract.
//   4. The menu is a menu: `role="menuitem"` on a real button is what keeps the
//      list's keyboard walk working, since that walk reads the DOM.
//
// The browser reaches the Host through same-origin `fetch` on the plugin's own
// routes; the Host validates `Origin` against `Host` on every one of them.

window.__ModuleLoader__.load({
  id: 'dsh-archive-delete',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    // What this bundle is allowed to assume about the module table's `React`.
    //
    // The table hands out a TRIMMED runtime — `createElement` plus the hooks that
    // a decoration needs — and NOT the full `react-dom` client face. There is no
    // `createRoot` and no `createPortal`, which is why the dialog below renders
    // in-tree and why this guard exists: a missing element fails loudly here, in
    // the console, instead of silently inside a click handler where the symptom is
    // an inert-looking menu row.
    const MISSING = ['createElement', 'useState', 'useEffect', 'useRef', 'Fragment']
      .filter((name) => React === null || React === undefined || React[name] === undefined)
    if (MISSING.length > 0) {
      console.error(`dsh-archive-delete: the module table's React lacks ${MISSING.join(', ')}; the menu row cannot render`)
    }

    /** This plugin's Host routes. */
    const API_ARCHIVED = '/plugins/dsh-archive-delete/archived'
    const API_PREVIEW = '/plugins/dsh-archive-delete/preview'
    const API_DELETE = '/plugins/dsh-archive-delete/delete'

    /** The seats this plugin occupies, and its ids within them. */
    const SLOT = 'sidebar.workspaces.session.menu.item'
    const ENTRY_ID = 'dsh-archive-delete'
    /** The root-scoped floating layer that hosts the dialog — see {@link DeleteDialogHost}. */
    const OVERLAY_SLOT = 'shell.overlay'
    const OVERLAY_ID = 'dsh-archive-delete.dialog'
    const LOCALE_NAMESPACE = 'archiveDelete'

    /** Every style tag this bundle owns, so the marker finds exactly its own. */
    const STYLE_ID = 'dsh-archive-delete-style'

    /**
     * Copy. `locale` is reached through `ctx.inject` and may be absent, so a
     * profile without the locale service still renders every label; registering
     * the dictionary is the polish, not the requirement.
     */
    const DICTIONARY_ZH = {
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
      loading: '正在读取…',
      failed: '删除失败',
      previewFailed: '无法读取会话信息',
    }

    const DICTIONARY_EN = {
      menuDelete: 'Delete permanently',
      dialogTitle: 'Permanently delete this conversation',
      dialogIntro: 'Only archived conversations can be deleted here. Confirming removes the files from disk immediately; it cannot be undone.',
      dialogSession: 'Session',
      dialogLocation: 'Location',
      dialogFiles: 'Files',
      dialogBytes: 'Size',
      dialogCreated: 'Created',
      dialogWarn: 'What will happen:',
      dialogRemoveLog: 'Delete the session directory, its log included',
      dialogRemoveCache: 'Delete its projection-cache record',
      dialogKeepRow: 'The workspace archive entry stays behind, pointing at nothing — equivalent to deleted.',
      cancel: 'Cancel',
      confirm: 'Delete permanently',
      working: 'Deleting…',
      loading: 'Reading…',
      failed: 'Deletion failed',
      previewFailed: 'Could not read the session',
    }

    /**
     * Install this bundle's stylesheet once. Run from the module body rather than
     * from a component so the tag exists before the first render, and marked so a
     * hot reload can withdraw exactly its own.
     */
    function ensureStyle() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-archive-delete'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = [
        // `shell.overlay` is a deliberately click-through layer: an entry opts
        // back into pointer events. The backdrop below is the whole viewport, so
        // opting in is what makes the dialog modal in practice — and while no
        // request is pending the host renders nothing at all, so the app
        // underneath is never blocked.
        '.dsa-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
        'justify-content:center;padding:24px;background:rgba(0,0,0,.45);pointer-events:auto}',
        '.dsa-card{width:min(520px,100%);max-height:80vh;overflow:auto;box-sizing:border-box;',
        'background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);',
        'border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:20px 20px 16px;',
        'box-shadow:0 16px 48px rgba(0,0,0,.28);font-size:13px;line-height:1.6}',
        '.dsa-title{margin:0 0 8px;font-size:15px;font-weight:600}',
        '.dsa-intro{margin:0 0 12px;color:var(--dsw-alias-label-secondary)}',
        '.dsa-rows{margin:0 0 12px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}',
        '.dsa-key{color:var(--dsw-alias-label-secondary)}',
        '.dsa-val{word-break:break-all;font-variant-numeric:tabular-nums}',
        '.dsa-warn{margin:0 0 6px;color:var(--dsw-alias-state-warn-primary);font-weight:600}',
        '.dsa-list{margin:0 0 12px;padding-left:18px;color:var(--dsw-alias-label-secondary)}',
        '.dsa-note{margin:0 0 14px;color:var(--dsw-alias-label-secondary)}',
        '.dsa-actions{display:flex;justify-content:flex-end;gap:8px}',
        '.dsa-btn{font:inherit;padding:6px 14px;border-radius:8px;cursor:pointer;',
        'border:1px solid var(--dsw-alias-border-l2);background:transparent;',
        'color:var(--dsw-alias-label-primary)}',
        '.dsa-btn:disabled{opacity:.55;cursor:default}',
        '.dsa-btn-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}',
        '.dsa-status{margin:10px 0 0;color:var(--dsw-alias-state-error-primary)}',
        '.dsa-menuitem{display:block;width:100%;text-align:left;font:inherit;padding:6px 10px;',
        'border:0;border-radius:6px;background:transparent;cursor:pointer;',
        'color:var(--dsw-alias-state-error-primary)}',
      ].join('')
      document.head.appendChild(tag)
    }

    /** `12.34 MB` / `912.00 KB` / `512 B`. */
    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let scaled = value
      let unit = 0
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024
        unit += 1
      }
      return `${unit === 0 ? String(scaled) : scaled.toFixed(2)} ${units[unit]}`
    }

    /** Local date/time for an epoch-millisecond value, or null. */
    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      try {
        return new Date(value).toLocaleString()
      } catch {
        return new Date(value).toISOString()
      }
    }

    /** One JSON fetch against this plugin's own routes. */
    async function requestJson(url, options) {
      const response = await fetch(url, { credentials: 'same-origin', ...options })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok) {
        const detail = body !== undefined && typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`
        throw new Error(detail)
      }
      return body
    }

    /**
     * The bridge between the menu row and the dialog host, and the dialog's own
     * state.
     *
     * The two live in different slots with different lifetimes — the row inside
     * the menu's portal (disposed the moment the menu closes), the host on the
     * root-scoped `shell.overlay` (mounted for the app's lifetime) — and the row
     * is the one that knows which conversation was clicked while the host is the
     * one that is still on screen afterwards. A module-scope store is the smallest
     * thing that connects them.
     *
     * The store owns ALL of the dialog's state — the pending request, whether a
     * deletion is in flight, and the last failure — so the host component is a
     * pure view over `current()`. That is deliberate: the host renders on the
     * root floating layer, far from the row, and two independent pieces of React
     * state (one here, one there) is exactly how the first attempt ended up
     * showing nothing at all.
     *
     * It is created lazily and cached, so a hot reload that re-evaluates this
     * module cannot leave two stores behind.
     * @returns the store.
     */
    let deletionRequests
    function createDeletionRequests() {
      if (deletionRequests !== undefined) return deletionRequests
      let value = null
      const listeners = new Set()
      const publish = (next) => {
        value = next
        for (const listener of [...listeners]) listener(value)
      }
      deletionRequests = {
        /** The current dialog state, or null while nothing is pending. */
        current: () => value,
        /** Subscribe to every change; returns the unsubscriber. */
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** Open the dialog on a resolved request. */
        open: (sessionId, preview) => publish({ sessionId, preview, busy: false, failure: null }),
        /**
         * Delete the pending conversation.
         *
         * The store owns the success/failure decision, because it is the only
         * place that sees the Host's answer. A `200` whose body reports
         * `deleted: false` is a REFUSAL — the archive gate, a live session, a lock
         * — and it rejects with that reason instead of resolving. The first version
         * returned `undefined` for both outcomes, so the refusal had nowhere to go
         * and the dialog closed as if the deletion had happened.
         * @returns the Host's result, on success only.
         */
        async confirm() {
          const request = value
          if (request === null || request.busy) return undefined
          publish({ ...request, busy: true, failure: null })
          let result
          try {
            result = await requestJson(API_DELETE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids: [request.sessionId] }),
            })
          } catch (error) {
            // The request itself failed. Keep the dialog open with its reason: the
            // user asked to delete something and did not get it, so the failure is
            // theirs to read and retry, not a toast that disappears.
            publish({ ...request, busy: false, failure: String(error?.message ?? error) })
            return undefined
          }
          const outcomes = Array.isArray(result?.results) ? result.results : []
          const refusal = outcomes.find((row) => row !== null && row !== undefined && row.deleted !== true)
          if (refusal !== undefined) {
            const reason = typeof refusal.reason === 'string' && refusal.reason !== '' ? refusal.reason : 'Host 没有执行删除'
            publish({ ...request, busy: false, failure: reason })
            return undefined
          }
          publish(null)
          return result
        },
        /** Dismiss the dialog, whether by cancel or after a success. */
        settle: () => {
          if (value !== null && value.busy) return
          publish(null)
        },
      }
      return deletionRequests
    }

    /**
     * The confirmation dialog: a pure view over one store snapshot.
     *
     * A plain div rather than the shell's own Modal primitive: a plugin must not
     * import a Harness Client package, and the primitive is not reachable from
     * the module table. The behaviour a user relies on is kept — `role="dialog"`
     * with `aria-modal`, focus moved onto the destructive action, Escape
     * cancelling, a busy state that blocks both buttons, and a failure that keeps
     * the dialog open with its reason visible.
     * @param props - the store snapshot, the two actions and the label function.
     * @returns the overlay element.
     */
    function ConfirmDialog(props) {
      const { request, t, onCancel, onConfirm } = props
      const { preview, busy, failure } = request
      const confirmRef = React.useRef(null)

      React.useEffect(() => {
        const node = confirmRef.current
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }, [])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) onCancel()
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
        }
      }, [busy, onCancel])

      const rows = []
      if (typeof preview.cwd === 'string' && preview.cwd !== '') {
        rows.push(h('div', { className: 'dsa-key', key: 'cwd-key' }, t('dialogLocation')))
        rows.push(h('div', { className: 'dsa-val', key: 'cwd-value' }, preview.cwd))
      }
      rows.push(h('div', { className: 'dsa-key', key: 'files-key' }, t('dialogFiles')))
      rows.push(h('div', { className: 'dsa-val', key: 'files-value' }, String(preview.fileCount ?? 0)))
      rows.push(h('div', { className: 'dsa-key', key: 'bytes-key' }, t('dialogBytes')))
      rows.push(h('div', { className: 'dsa-val', key: 'bytes-value' }, formatBytes(preview.bytes)))
      const created = formatTime(preview.createdAt)
      if (created !== null) {
        rows.push(h('div', { className: 'dsa-key', key: 'created-key' }, t('dialogCreated')))
        rows.push(h('div', { className: 'dsa-val', key: 'created-value' }, created))
      }

      return h('div', {
        className: 'dsa-overlay',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dsa-dialog-title',
        onClick: (event) => {
          if (event.target === event.currentTarget && !busy) onCancel()
        },
      }, h('div', { className: 'dsa-card' },
        h('h2', { className: 'dsa-title', id: 'dsa-dialog-title' }, t('dialogTitle')),
        h('p', { className: 'dsa-intro' }, t('dialogIntro')),
        h('div', { className: 'dsa-rows' },
          h('div', { className: 'dsa-key' }, t('dialogSession')),
          h('div', { className: 'dsa-val' }, preview.id),
          rows,
        ),
        h('p', { className: 'dsa-warn' }, t('dialogWarn')),
        h('ul', { className: 'dsa-list' },
          h('li', null, t('dialogRemoveLog')),
          h('li', null, t('dialogRemoveCache')),
        ),
        h('p', { className: 'dsa-note' }, t('dialogKeepRow')),
        h('div', { className: 'dsa-actions' },
          h('button', {
            type: 'button',
            className: 'dsa-btn',
            disabled: busy,
            onClick: onCancel,
          }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'dsa-btn dsa-btn-danger',
            ref: confirmRef,
            disabled: busy,
            onClick: onConfirm,
          }, busy ? t('working') : t('confirm')),
        ),
        failure === null || failure === undefined
          ? null
          : h('p', { className: 'dsa-status' }, `${t('failed')}: ${failure}`),
      ))
    }

    /**
     * The `sidebar.workspaces.session.menu.item` row.
     *
     * Owner props give the session identity; `useWorkspaces` gives the archive
     * set. The row renders nothing at all for a conversation that is not
     * archived, so a live conversation's menu is exactly what it was before this
     * plugin existed.
     *
     * The row does NOT own the dialog, and that is the whole point of this
     * shape. The slot is rendered inside the menu's own portal, so the row's
     * component is UNMOUNTED the moment the menu closes — which is the same
     * moment the click causes. A dialog owned by this component therefore could
     * not appear at all: the preview request landed, `setPreview(...)` ran, and
     * the update was applied to a component that no longer existed. So the row
     * resolves the preview, hands it to {@link createDeletionRequests}, and only
     * then dismisses the menu. The dialog itself lives on `shell.overlay`.
     * @param props - the owner props, the standard hooks, and this entry's inject face.
     * @returns the menu row, or null.
     */
    function ArchiveDeleteMenuItem(props) {
      const { sessionId, useWorkspaces, useMenuOpenState, t } = props
      const [, setMenuOpen] = useMenuOpenState()
      const [state, setState] = React.useState('idle')
      // `menuEnabled` is a real switch, so the row has to consult it. It is read
      // from the Host once per mount: the request itself is what a row click
      // already costs, and the answer changes only when a person edits settings.
      const [enabled, setEnabled] = React.useState(null)
      React.useEffect(() => {
        let live = true
        void fetch(API_ARCHIVED, { credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : undefined))
          .then((body) => {
            // Fail OPEN on an unreadable answer: the switch's purpose is "hide the
            // row", and a broken probe must not present itself as the user having
            // turned it off.
            if (live && body !== undefined && body !== null) setEnabled(body.menuEnabled !== false)
          })
          .catch(() => {})
        return () => {
          live = false
        }
      }, [])

      const archived = useWorkspaces((store) => {
        const ids = store === null || store === undefined ? undefined : store.archivedSessionIds
        return Array.isArray(ids) && ids.includes(sessionId)
      })

      const open = () => {
        setState('loading')
        // The menu is dismissed only after the request is published, because
        // dismissing it disposes this component (and its pending promise).
        requestJson(`${API_PREVIEW}?id=${encodeURIComponent(sessionId)}`)
          .then((preview) => {
            createDeletionRequests().open(sessionId, preview)
            setMenuOpen(false)
          })
          .catch((error) => {
            setState({ failed: String(error?.message ?? error) })
          })
      }

      // Hooks run before either return, so the row's hook order is identical for
      // every session — archived or not.
      if (archived !== true) return null
      if (enabled === false) return null

      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsa-menuitem',
        disabled: state === 'loading',
        onClick: open,
      }, typeof state === 'object' && state !== null && state.failed !== undefined
        ? `${t('previewFailed')}: ${state.failed}`
        : (state === 'loading' ? t('loading') : t('menuDelete')))
    }

    /**
     * The `shell.overlay` entry that actually shows the confirmation dialog.
     *
     * `shell.overlay` is the frame-wide floating layer, root-scoped and therefore
     * mounted for the app's whole lifetime — it does not come and go with a menu.
     * The kernel uses it for exactly this: `workspace.session-archive` renders its
     * "stop the running work and archive?" dialog there. Two consequences shape
     * the code below: the layer itself is click-through and an entry opts back
     * into pointer events (which `.dsa-overlay` does), and the entry must render
     * NOTHING while no request is pending.
     * @param props - this entry's inject face.
     * @returns the dialog, or null.
     */
    function DeleteDialogHost(props) {
      const { t, refresh } = props
      // No local state: the store IS the dialog's state, and this component only
      // mirrors it. `useEffect` hands React the same subscription the store
      // already supports, so a notification re-renders this entry and nothing
      // else.
      const [request, setRequest] = React.useState(() => createDeletionRequests().current())
      React.useEffect(() => createDeletionRequests().subscribe(setRequest), [])
      if (request === null) return null
      return h(ConfirmDialog, {
        request,
        t,
        onCancel: () => createDeletionRequests().settle(),
        onConfirm: () => {
          // `confirm()` reports its own success: it clears the request only when the
          // Host actually deleted something. So this handler only has to refresh the
          // sidebar afterwards, and a refusal needs no special arm here — the store
          // leaves the dialog open with the reason.
          return createDeletionRequests().confirm().then((result) => {
            if (result !== undefined && typeof refresh === 'function') void refresh()
          })
        },
      })
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        ensureStyle()
        if (ctx === null || ctx === undefined || typeof ctx.inject !== 'function') return

        ctx.inject(['slots', 'locale', 'sessions'], (owner) => {
          const slots = serviceAt(owner, 'slots')
          if (slots === null || slots === undefined || typeof slots.inject !== 'function') return

          const locale = serviceAt(owner, 'locale')
          if (locale !== null && locale !== undefined && typeof locale.register === 'function') {
            const dictionaries = () => locale.register(LOCALE_NAMESPACE, { zh: DICTIONARY_ZH, en: DICTIONARY_EN })
            if (typeof owner.effect === 'function') owner.effect(dictionaries, 'dsh-archive-delete: dictionaries')
            else dictionaries()
          }
          const t = locale !== null && locale !== undefined && typeof locale.bind === 'function'
            ? locale.bind(LOCALE_NAMESPACE)
            : (key) => (DICTIONARY_ZH[key] === undefined ? key : DICTIONARY_ZH[key])
          // Optional: the session list refresh after a successful deletion. The
          // delete itself does not depend on it.
          const sessions = serviceAt(owner, 'sessions')
          const refresh = sessions !== null && sessions !== undefined && typeof sessions.refresh === 'function'
            ? () => sessions.refresh()
            : undefined

          let registration = null
          let overlayRegistration = null
          const contribute = () => {
            if (registration === null) {
              try {
                registration = slots.inject(SLOT, () => slots.register({
                  name: SLOT,
                  id: ENTRY_ID,
                  order: 500,
                  inject: () => ({ t }),
                }, ArchiveDeleteMenuItem))
              } catch (error) {
                registration = null
                console.warn('dsh-archive-delete: menu row not registered', error)
              }
            }
            // The dialog host: one entry on the root-scoped floating layer, alive
            // for as long as the plugin is, and rendering nothing until a row
            // publishes a request.
            if (overlayRegistration === null) {
              try {
                overlayRegistration = slots.inject(OVERLAY_SLOT, () => slots.register({
                  name: OVERLAY_SLOT,
                  id: OVERLAY_ID,
                  order: 500,
                  inject: () => ({ t, refresh }),
                }, DeleteDialogHost))
              } catch (error) {
                overlayRegistration = null
                console.warn('dsh-archive-delete: dialog host not registered', error)
              }
            }
          }
          const withdraw = () => {
            for (const dispose of [registration, overlayRegistration]) {
              if (typeof dispose !== 'function') continue
              try {
                dispose()
              } catch (error) {
                console.warn('dsh-archive-delete: entry not withdrawn', error)
              }
            }
            registration = null
            overlayRegistration = null
          }
          contribute()
          if (typeof owner.effect === 'function') owner.effect(() => withdraw, 'dsh-archive-delete: slot entries')
        })
      },
    }
  },
})

/**
 * Read one awaited service from the injected owner context.
 *
 * `get` first, because that is the form every working plugin in this deployment
 * uses and the property proxy is topology-sensitive; the property is the fallback
 * for a context that has the service declared.
 * @param owner - the context passed to the inject callback.
 * @param name - service name.
 * @returns the service, or undefined when it is not reachable.
 */
function serviceAt(owner, name) {
  try {
    if (owner !== null && owner !== undefined && typeof owner.get === 'function') {
      const value = owner.get(name)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    // A global-store miss is the expected miss; the property may still answer.
  }
  try {
    return owner === null || owner === undefined ? undefined : owner[name]
  } catch {
    return undefined
  }
}
