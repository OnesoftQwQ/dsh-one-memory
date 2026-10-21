// dsh-one-memory — browser half.
//
// Adds one global panel: a sidebar icon and a memory management page. The
// page reads and writes the Host store through the plugin's same-origin
// /one-memory API, so a save here is the same write the model's tools make:
// it bumps the shared revision and therefore reaches every live session
// through the incremental injection path.

window.__ModuleLoader__.load({
  id: 'dsh-one-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'one-memory'
    const PANEL_ID = 'one-memory'
    const API = '/one-memory'
    const POLL_MS = 5000

    const zh = {
      'panel': '记忆',
      'title': '记忆',
      'subtitle': '跨会话共享的全局记忆与键值记忆',
      'refresh': '刷新',
      'loading': '加载中…',
      'loadFailed': '读取记忆失败：{message}',
      'saveFailed': '保存失败：{message}',
      'deleteFailed': '删除失败：{message}',
      'global': '全局记忆',
      'globalHint': '每轮会话开始时注入，并在变更后增量注入其他会话。',
      'globalEmpty': '（尚未写入全局记忆）',
      'entries': '键值记忆',
      'entriesCount': '共 {count} 条',
      'entriesHint': '会话开始时注入所有 key 的目录；模型按需用 memory_get 读取。',
      'entriesEmpty': '还没有键值记忆。',
      'new': '新建记忆',
      'search': '搜索 key、描述或内容',
      'noMatch': '没有匹配的记忆。',
      'key': 'key',
      'keyPlaceholder': '例如 project/build 或 user/preferences',
      'description': '描述',
      'descriptionPlaceholder': '一句话说明，显示在 key 目录里（可选）',
      'value': '内容',
      'valuePlaceholder': 'Markdown 正文；来源写成 [1](sessionId:turn)',
      'save': '保存',
      'cancel': '取消',
      'edit': '编辑',
      'delete': '删除',
      'confirmDelete': '确认删除',
      'revision': '版本 {revision}',
      'updated': '更新于 {time}',
      'cap': '容量 {count}/{max}',
      'chars': '{count}/{max} 字符'
    }
    const en = {
      'panel': 'Memory',
      'title': 'Memory',
      'subtitle': 'Global and key-value memory shared across sessions',
      'refresh': 'Refresh',
      'loading': 'Loading…',
      'loadFailed': 'Could not load memory: {message}',
      'saveFailed': 'Save failed: {message}',
      'deleteFailed': 'Delete failed: {message}',
      'global': 'Global memory',
      'globalHint': 'Injected at the start of every turn and incrementally after changes.',
      'globalEmpty': '(no global memory yet)',
      'entries': 'Key-value memory',
      'entriesCount': '{count} entries',
      'entriesHint': 'The key catalog is injected at session start; the model reads one entry with memory_get.',
      'entriesEmpty': 'No key-value memory yet.',
      'new': 'New memory',
      'search': 'Search key, description, or content',
      'noMatch': 'No matching memory.',
      'key': 'key',
      'keyPlaceholder': 'for example project/build or user/preferences',
      'description': 'Description',
      'descriptionPlaceholder': 'One line shown in the key catalog (optional)',
      'value': 'Content',
      'valuePlaceholder': 'Markdown body; write sources as [1](sessionId:turn)',
      'save': 'Save',
      'cancel': 'Cancel',
      'edit': 'Edit',
      'delete': 'Delete',
      'confirmDelete': 'Confirm delete',
      'revision': 'revision {revision}',
      'updated': 'updated {time}',
      'cap': '{count}/{max} used',
      'chars': '{count}/{max} chars'
    }

    const CSS = String.raw`
.am-page{width:100%;min-width:0;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6;display:flex;overflow:hidden}
.am-scroll{scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px;flex:1;min-height:0;overflow:auto}
.am-content{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.am-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));margin-bottom:6px}
.am-title{font-size:20px;font-weight:600;line-height:28px;margin:0}
.am-sub{color:var(--dsw-alias-label-tertiary);font-size:13px;margin:0 0 20px}
.am-meta{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-tertiary);font-size:12px;flex-wrap:wrap}
.am-btn{font:inherit;font-size:13px;line-height:20px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.am-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.am-btn:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:2px}
.am-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}
.am-btn-primary:hover{filter:brightness(1.05);background:var(--dsw-alias-state-business-primary)}
.am-btn-danger{color:var(--dsw-alias-state-error-primary)}
.am-btn:disabled{opacity:.5;cursor:default}
.am-section{margin-top:24px}
.am-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;flex-wrap:wrap}
.am-sectionTitle{font-size:14px;font-weight:600;margin:0}
.am-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0 0 10px}
.am-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;margin-bottom:10px}
.am-cardHead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
.am-key{font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-all}
.am-desc{color:var(--dsw-alias-label-secondary);font-size:13px;min-width:0}
.am-stamp{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-left:auto;white-space:nowrap}
.am-value{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
.am-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}
.am-field{display:flex;flex-direction:column;gap:4px;margin-top:10px}
.am-label{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.am-input,.am-textarea{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;width:100%;box-sizing:border-box}
.am-input:focus,.am-textarea:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px;border-color:transparent}
.am-textarea{min-height:110px;resize:vertical;line-height:20px;font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px}
.am-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.am-search{flex:1;min-width:180px}
.am-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:12px 0}
.am-notice{border-radius:8px;padding:8px 12px;font-size:13px;margin-top:16px;background:var(--dsw-alias-state-error-secondary, var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary)}
.am-caption{color:var(--dsw-alias-label-caption);font-size:12px;margin-left:6px}
`

    function MemoryIcon(props) {
      const size = props && props.size ? props.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true
      },
        h('path', {
          d: 'M9 3.75h6a2.25 2.25 0 0 1 2.25 2.25v12.75a.75.75 0 0 1-1.13.65L12 17.1l-4.12 2.3a.75.75 0 0 1-1.13-.65V6A2.25 2.25 0 0 1 9 3.75Z',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round'
        }),
        h('path', {
          d: 'M9.75 8.25h4.5M9.75 11.25h4.5',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round'
        })
      )
    }

    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    async function request(path, body) {
      const init = body === undefined
        ? { method: 'GET', headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body)
          }
      const response = await fetch(API + path, init)
      const text = await response.text()
      let payload = null
      try { payload = text === '' ? null : JSON.parse(text) } catch { payload = null }
      if (!response.ok) {
        throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status)
      }
      return payload
    }

    function Field(props) {
      return h('label', { className: 'am-field' },
        h('span', { className: 'am-label' }, props.label),
        props.children
      )
    }

    function Editor(props) {
      const { t, draft, setDraft, onSave, onCancel, showKey, showDescription, busy, maxChars } = props
      const length = draft.value.length
      return h('div', { className: 'am-card' },
        showKey
          ? h(Field, { label: t('key') },
              h('input', {
                className: 'am-input',
                value: draft.key,
                placeholder: t('keyPlaceholder'),
                spellCheck: false,
                autoFocus: true,
                onChange: (event) => setDraft({ ...draft, key: event.target.value })
              })
            )
          : null,
        showDescription
          ? h(Field, { label: t('description') },
              h('input', {
                className: 'am-input',
                value: draft.description,
                placeholder: t('descriptionPlaceholder'),
                maxLength: 160,
                onChange: (event) => setDraft({ ...draft, description: event.target.value })
              })
            )
          : null,
        h(Field, { label: t('value') + (maxChars ? ' · ' + t('chars', { count: length, max: maxChars }) : '') },
          h('textarea', {
            className: 'am-textarea',
            value: draft.value,
            placeholder: t('valuePlaceholder'),
            spellCheck: false,
            onChange: (event) => setDraft({ ...draft, value: event.target.value })
          })
        ),
        h('div', { className: 'am-actions' },
          h('button', { type: 'button', className: 'am-btn', onClick: onCancel }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'am-btn am-btn-primary',
            disabled: busy || draft.value.trim() === '',
            onClick: onSave
          }, t('save'))
        )
      )
    }

    function MemoryPage(props) {
      const t = props && typeof props.t === 'function' ? props.t : (key) => key
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [draft, setDraft] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)

      const apply = (payload) => {
        setState(payload)
        setError(null)
      }

      const load = React.useCallback(async () => {
        try {
          apply(await request('/state'))
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const payload = await request('/state')
            if (alive) apply(payload)
          } catch (failure) {
            if (alive) setError(failure.message)
          }
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const save = async (key, value, description) => {
        setBusy(true)
        try {
          apply(await request('/save', { key, value, description }))
          setDraft(null)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const remove = async (key) => {
        setBusy(true)
        try {
          apply(await request('/delete', { key }))
          setConfirming(null)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const entries = state ? state.entries : []
      const needle = query.trim().toLowerCase()
      const visible = needle === ''
        ? entries
        : entries.filter((entry) =>
            entry.key.toLowerCase().includes(needle) ||
            (entry.description || '').toLowerCase().includes(needle) ||
            entry.value.toLowerCase().includes(needle)
          )

      const style = h('style', { key: 'am-style', 'data-plugin-css': 'dsh-one-memory/page' }, CSS)

      if (state === null) {
        return h('div', { className: 'am-page' }, style,
          h('div', { className: 'am-scroll' },
            h('div', { className: 'am-content' },
              h('h1', { className: 'am-title' }, t('title')),
              error === null
                ? h('div', { className: 'am-empty' }, t('loading'))
                : h('div', { className: 'am-notice' }, t('loadFailed', { message: error }))
            )
          )
        )
      }

      const globalValue = state.global ? state.global.value : ''
      const globalDraft = draft && draft.mode === 'global' ? draft : null

      return h('div', { className: 'am-page' }, style,
        h('div', { className: 'am-scroll' },
          h('div', { className: 'am-content' },
            h('div', { className: 'am-heading' },
              h('div', null,
                h('h1', { className: 'am-title' }, t('title')),
                h('p', { className: 'am-sub' }, t('subtitle'))
              ),
              h('div', { className: 'am-meta' },
                h('span', null, t('revision', { revision: state.revision })),
                h('span', null, t('cap', { count: entries.length, max: state.maxEntries })),
                h('button', { type: 'button', className: 'am-btn', onClick: load }, t('refresh'))
              )
            ),
            error !== null ? h('div', { className: 'am-notice' }, error) : null,

            h('section', { className: 'am-section' },
              h('div', { className: 'am-sectionHead' },
                h('h2', { className: 'am-sectionTitle' }, t('global')),
                globalDraft === null
                  ? h('button', {
                      type: 'button',
                      className: 'am-btn',
                      onClick: () => setDraft({
                        mode: 'global',
                        key: '@global',
                        description: '',
                        value: globalValue
                      })
                    }, globalValue === '' ? t('edit') : t('edit'))
                  : null
              ),
              h('p', { className: 'am-hint' }, t('globalHint')),
              globalDraft === null
                ? (globalValue === ''
                    ? h('div', { className: 'am-card am-empty' }, t('globalEmpty'))
                    : h('div', { className: 'am-card' },
                        h('pre', { className: 'am-value', style: { marginTop: 0 } }, globalValue)
                      ))
                : h(Editor, {
                    t,
                    draft: globalDraft,
                    setDraft,
                    showKey: false,
                    showDescription: false,
                    maxChars: state.maxGlobalChars,
                    busy,
                    onCancel: () => setDraft(null),
                    onSave: () => save('@global', globalDraft.value, '')
                  })
            ),

            h('section', { className: 'am-section' },
              h('div', { className: 'am-sectionHead' },
                h('h2', { className: 'am-sectionTitle' },
                  t('entries'),
                  h('span', { className: 'am-caption' }, t('entriesCount', { count: entries.length }))
                ),
                h('button', {
                  type: 'button',
                  className: 'am-btn am-btn-primary',
                  onClick: () => setDraft({ mode: 'new', key: '', description: '', value: '' })
                }, t('new'))
              ),
              h('p', { className: 'am-hint' }, t('entriesHint')),
              h('div', { className: 'am-toolbar' },
                h('input', {
                  className: 'am-input am-search',
                  value: query,
                  placeholder: t('search'),
                  onChange: (event) => setQuery(event.target.value)
                })
              ),

              draft && draft.mode === 'new'
                ? h(Editor, {
                    t,
                    draft,
                    setDraft,
                    showKey: true,
                    showDescription: true,
                    maxChars: state.maxEntryChars,
                    busy,
                    onCancel: () => setDraft(null),
                    onSave: () => save(draft.key.trim(), draft.value, draft.description)
                  })
                : null,

              entries.length === 0
                ? h('div', { className: 'am-empty' }, t('entriesEmpty'))
                : visible.length === 0
                  ? h('div', { className: 'am-empty' }, t('noMatch'))
                  : visible.map((entry) => {
                      const editing = draft && draft.mode === 'entry' && draft.key === entry.key
                      if (editing) {
                        return h(Editor, {
                          key: entry.key,
                          t,
                          draft,
                          setDraft,
                          showKey: false,
                          showDescription: true,
                          maxChars: state.maxEntryChars,
                          busy,
                          onCancel: () => setDraft(null),
                          onSave: () => save(entry.key, draft.value, draft.description)
                        })
                      }
                      const pendingDelete = confirming === entry.key
                      return h('div', { className: 'am-card', key: entry.key },
                        h('div', { className: 'am-cardHead' },
                          h('span', { className: 'am-key' }, entry.key),
                          entry.description
                            ? h('span', { className: 'am-desc' }, entry.description)
                            : null,
                          h('span', { className: 'am-stamp' },
                            (entry.revision === null ? '' : t('revision', { revision: entry.revision }) + ' · ') +
                            t('updated', { time: formatTime(entry.updatedAt) })
                          )
                        ),
                        h('pre', { className: 'am-value' }, entry.value),
                        h('div', { className: 'am-actions' },
                          h('button', {
                            type: 'button',
                            className: 'am-btn',
                            onClick: () => setDraft({
                              mode: 'entry',
                              key: entry.key,
                              description: entry.description || '',
                              value: entry.value
                            })
                          }, t('edit')),
                          h('button', {
                            type: 'button',
                            className: 'am-btn' + (pendingDelete ? ' am-btn-danger' : ''),
                            disabled: busy,
                            onClick: () => {
                              if (!pendingDelete) { setConfirming(entry.key); return }
                              remove(entry.key)
                            }
                          }, pendingDelete ? t('confirmDelete') : t('delete'))
                        )
                      )
                    })
            )
          )
        )
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = (key) => key
        try {
          const locale = ctx.get('locale')
          if (locale !== undefined) {
            ctx.effect(() => locale.register(NS, { zh, en }), 'one-memory: dictionaries')
            t = locale.bind(NS)
          }
        } catch (error) {
          console.error('[one-memory] locale unavailable', error)
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t })
        }, MemoryPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel')
        }, MemoryIcon))
      }
    }
  }
})
