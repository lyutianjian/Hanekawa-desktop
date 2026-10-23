import { el, reconcile, replace, show } from './dom.js'
import { button, multiSelectField, pillSelect, selectField, textField, toggleField, updateToggleField, type ToggleOptions } from './controls.js'
import { icon, type IconName } from './icons.js'
import { onPressOutside } from './dismiss.js'
import { trapTab } from './focus.js'
import { createModalPresence, createPresence, finishPresenceWithin } from './presence.js'
import type {
  SettingsAnchor,
  SettingsButton,
  SettingsCard,
  SettingsChord,
  SettingsEditor,
  SettingsForm,
  SettingsFormField,
  SettingsFormStatus,
  SettingsIntent,
  SettingsModelPicker,
  SettingsModelRowView,
  ModelRowTextField,
  SettingsNavItem,
  SettingsProbeView,
  SettingsRow,
  SettingsViewModel,
} from '../model/settings.js'

/**
 * The settings screen's nodes. Every decision — which rows exist, what they
 * say, what a keystroke means — already happened in `model/settings.ts`; this
 * file only builds elements and forwards intents.
 *
 * The screen fills `#canvas` rather than floating over it. `#overlay` and
 * `#rewind` cover the same canvas (S6) but are modal: each of them parks that
 * lane's agent loop until it is answered. Settings never parks anything, so it
 * hides its siblings from the stylesheet instead of scrimming them, and the
 * sidebar stays usable beside all three.
 *
 * **Nodes are kept by id and reconciled**, the rule `dom/transcriptView.ts`
 * already follows. A `replace()` of the whole column pulls every card out of
 * the page and puts it back, which cost this screen two things: the scroll
 * anchor (so a row disappearing scrolled the page under the reader) and, worse,
 * the node under the pointer. A form field commits on blur, so `mousedown` on
 * 保存 rebuilt that very button before `mouseup` reached it — the click was
 * never delivered, and the user had to press it twice. Kept nodes plus
 * `textField`'s `live` commit are what make one click enough.
 *
 * **And a kept leaf is only half of it: its wrappers have to be kept too.**
 * `appendChild` moves a node by detaching it first, so a focused `<input>` put
 * into a newly built `.settings-row-control` leaves the document for that instant
 * — which is all it takes for the browser to blur it. Every field commits `live`,
 * so that happened once per character: the 模型/服务商 form could not be typed in
 * at all without clicking back into the box between letters.
 *
 * No colours and no `.style.*` here; `styles.css` owns all of it.
 */

export interface SettingsViewHandle {
  render(view: SettingsViewModel): void
}

export function createSettingsView(
  container: HTMLElement,
  onIntent: (intent: SettingsIntent) => void,
  onKey: (chord: SettingsChord) => boolean,
): SettingsViewHandle {
  // Built once, outside `render()`: it lives in the nav column, which is replaced
  // on every render, and an `<input>` rebuilt under the user would drop the caret.
  const search = textField({
    className: 'settings-search',
    value: '',
    ariaLabel: '搜索设置',
    placeholder: '搜索设置…',
    onCommit: (query) => onIntent({ kind: 'search', query }),
  })
  // `textField` commits on blur/Enter, which is right for a setting and wrong for
  // a filter: the list has to move while typing.
  search.addEventListener('input', () => onIntent({ kind: 'search', query: search.value }))

  container.addEventListener('keydown', (event) => {
    // Backspace and the arrows belong to the search box. Escape does not: it is
    // this screen's documented way out, and `settingsKeyToIntent` is what decides
    // whether it clears the query or closes the screen.
    if (event.target === search && event.key !== 'Escape') return
    // Mid-IME composition Escape cancels the pinyin, not the form.
    if (event.isComposing || event.keyCode === 229) return
    const consumed = onKey({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    })
    if (!consumed) return
    // Both, because the global handler is on `document`: without the second an
    // Escape aimed at a form would also close the whole screen.
    event.preventDefault()
    event.stopPropagation()
  })

  // A press outside the open pill closes it — the hole `focusout` alone leaves
  // here as everywhere else: this screen is mostly cards and labels, none of
  // which take focus, so pressing one moved no focus and fired no `focusout`,
  // and the dropdown stayed up over the row the user was reading.
  //
  // Gated on `lastOpenMenu` rather than sent unconditionally: `runSettingsIntent`
  // repaints the whole screen for every intent it is handed, and this listener
  // sees every press in the window, including the ones while settings is shut.
  onPressOutside(['.settings-menu-shell'], () => {
    if (lastOpenMenu === undefined) return false
    onIntent({ kind: 'close-menu' })
    return true
  })

  // Focus leaving the screen closes an open dropdown. `relatedTarget === null` is
  // this view's own repaint — every render can fire one — and a target still
  // inside the container is a move between the trigger and its items.
  container.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    if (next === null) return
    if (next instanceof Node && container.contains(next)) return
    onIntent({ kind: 'close-menu' })
  })

  const nav = el('div', 'settings-nav')
  nav.id = 'settings-nav'
  const navList = el('div', 'settings-nav-list')
  const close = button('settings-nav-close', '返回会话', '关闭设置（Esc）', () =>
    onIntent({ kind: 'close' }),
    { icon: 'arrow-left' },
  )
  // First in the column, above the search box: this screen covers the whole
  // window (the sidebar included), so the way back has to be where the eye
  // starts. At the foot of the category list it was below a scroller, which is
  // the one place an exit must not be.
  nav.appendChild(close)
  nav.appendChild(search)
  nav.appendChild(navList)
  const body = el('div', 'settings-body')
  body.id = 'settings-body'
  // Two nodes, two jobs (todo V7): `body` is the full-width scroller, so its
  // scrollbar stays on the canvas edge, and `column` is the 880px reading measure
  // everything is rebuilt into. Built once here rather than per render — the
  // replaced region is the column's children.
  const column = el('div', 'settings-column')
  body.appendChild(column)
  container.appendChild(nav)
  container.appendChild(body)

  // The form dialog, over the whole screen. While it is up the nav and the page
  // behind it are `inert`, so neither the pointer nor Tab can leave the form.
  const dialogLayer = el('div', 'settings-dialog-layer')
  const dialog = el('div', 'settings-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  // Named by its own title and described by its error, so a screen reader
  // entering it hears which form this is, and hears why a save was refused.
  dialog.setAttribute('aria-labelledby', DIALOG_TITLE_ID)
  // Where focus goes when a paint disables or removes the focused control: still
  // inside the dialog, so Tab stays trapped and Esc still reaches the form.
  dialog.tabIndex = -1
  dialogLayer.appendChild(dialog)
  container.appendChild(dialogLayer)
  const dialogPresence = createModalPresence(dialogLayer, dialog, () => replace(dialog))
  // The backdrop, and only the backdrop: a press that starts inside the dialog
  // and bubbles here is not a dismissal.
  dialogLayer.addEventListener('pointerdown', (event) => {
    if (event.target === dialogLayer) onIntent({ kind: 'cancel-draft' })
  })
  dialog.addEventListener('keydown', (event) => trapTab(dialog, event))

  // Programmatically focusable but not a tab stop, exactly like the sidebar's
  // list. Without focus *inside* the screen the `keydown` above never fires, and
  // this screen is reached by `Ctrl+,` from a composer that the stylesheet then
  // hides — which left focus on `<body>` and made the close button's own promise,
  // 关闭设置（Esc）, false until the user happened to click something.
  container.tabIndex = -1
  const presence = createPresence(container, { kind: 'panel' })
  let wasOpen = false

  // The kept nodes, and what a kept node's handler reads *now*. Both are pruned
  // to the keys this paint claimed, which is the rule that keeps a stale ref from
  // outliving the node it belonged to.
  const kept = new Map<string, HTMLElement>()
  const commits = new Map<string, (value: string) => SettingsIntent>()
  const toggles = new Map<string, ToggleOptions>()
  let claimed = new Set<string>()
  // Which pill is open, as of the *previous* paint, so a menu that just opened can
  // be told from one that has been open all along and may hold the user's arrow key.
  let lastOpenMenu: string | undefined
  let lastError: string | undefined
  let lastTitle: string | undefined
  // The open form's identity and discard prompt as of the previous paint, and
  // the name of the control that opened it — the node itself may be rebuilt
  // while the dialog is up, so focus goes back to whatever answers to that name.
  let lastFormKey: string | undefined
  let lastRowIds = new Set<string>()
  let lastConfirmDiscard = false
  let opener: string | undefined
  // The node to focus once this paint is in the page. A list rather than a
  // variable: it is written from a callback the paint hands down, and narrowing
  // cannot see that — a `let` reset to `undefined` reads back as `never`.
  const pendingFocus: HTMLElement[] = []

  /** A kept element, created once per key and reused thereafter. */
  function node<K extends keyof HTMLElementTagNameMap>(
    key: string,
    tag: K,
    className: string,
    create?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    claimed.add(key)
    const existing = kept.get(key)
    if (existing) {
      existing.className = className
      return existing as HTMLElementTagNameMap[K]
    }
    const made = el(tag, className)
    create?.(made)
    kept.set(key, made)
    return made
  }

  /** The form's fields keep their nodes, so typing never rebuilds the caret away. */
  function keptInput(
    key: string,
    options: {
      value: string
      ariaLabel: string
      placeholder?: string
      mono?: boolean
      secret?: boolean
      live?: boolean
      onEnter?: () => void
      intentOnCommit: (value: string) => SettingsIntent
    },
  ): HTMLInputElement {
    commits.set(key, options.intentOnCommit)
    claimed.add(key)
    const existing = kept.get(key) as HTMLInputElement | undefined
    if (existing) {
      // The one write-back rule the search box already follows: never type over
      // the user. A focused field is theirs until they leave it.
      if (document.activeElement !== existing && existing.value !== options.value) {
        existing.value = options.value
      }
      return existing
    }
    const made = textField({
      value: options.value,
      ariaLabel: options.ariaLabel,
      ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
      ...(options.mono ? { mono: true } : {}),
      ...(options.live ? { live: true } : {}),
      ...(options.onEnter ? { onEnter: options.onEnter } : {}),
      // Through the map, not the closure: the node outlives this paint, and a
      // captured `intentOnCommit` would keep answering with the old row's value.
      onCommit: (value) => {
        const commit = commits.get(key)
        if (commit) onIntent(commit(value))
      },
    })
    if (options.secret) made.type = 'password'
    kept.set(key, made)
    return made
  }

  /**
   * A kept native select. Keyed by its choices too, so a list that changes gets
   * a new node, and one that does not keeps its focus across the paint its own
   * `change` causes.
   */
  function keptSelect(
    key: string,
    options: {
      value: string
      ariaLabel: string
      choices: ReadonlyArray<{ value: string; label: string }>
      field: string
      /** Overrides the default `draft-field` intent. */
      intentFor?: (value: string) => SettingsIntent
    },
  ): HTMLSelectElement {
    const id = `${key}:${options.choices.map((choice) => choice.value).join('|')}`
    claimed.add(id)
    const existing = kept.get(id) as HTMLSelectElement | undefined
    if (existing) {
      if (existing.value !== options.value) existing.value = options.value
      return existing
    }
    const made = selectField({
      value: options.value,
      ariaLabel: options.ariaLabel,
      choices: options.choices,
      onChange: (value) => onIntent(options.intentFor?.(value) ?? { kind: 'draft-field', field: options.field, value }),
    })
    kept.set(id, made)
    return made
  }

  /** A kept button whose intent never changes; its label and state follow the paint. */
  function keptButton(
    key: string,
    className: string,
    label: string,
    intent: SettingsIntent,
    options: { title?: string; enabled?: boolean; icon?: IconName } = {},
  ): HTMLButtonElement {
    claimed.add(key)
    let made = kept.get(key) as HTMLButtonElement | undefined
    if (!made) {
      made = button(className, label, options.title ?? label, () => onIntent(intent), options.icon ? { icon: options.icon } : {})
      kept.set(key, made)
    }
    made.className = className
    const text = made.querySelector('.btn-label')
    if (text && text.textContent !== label) text.textContent = label
    made.title = options.title ?? label
    made.setAttribute('aria-label', made.title)
    made.disabled = options.enabled === false
    return made
  }

  /** The dialog's three parts around whichever field list the form has. */
  function dialogNodes(
    form: SettingsForm & SettingsFormStatus,
    error: string | undefined,
    menus: FormMenuContext,
  ): Array<Node | null> {
    const key = formKeyOf(form)
    const submit = (): void => onIntent({ kind: 'submit-draft' })
    const head = node(`${key}:head`, 'div', 'settings-dialog-head')
    const header = form.kind === 'provider' ? form.header : undefined
    reconcile(head, [
      header
        ? el(
            'div',
            'settings-provider-identity',
            el('span', 'settings-provider-avatar', header.initial),
            titled(el('div', 'settings-dialog-title', header.name)),
            header.protocol ? el('span', 'settings-provider-badge', header.protocol) : null,
          )
        : titled(el('div', 'settings-dialog-title', form.title)),
      form.kind === 'mcp-server' ? docLinkNode(node(`${key}:doc`, 'a', 'mcp-form-doc-link')) : null,
      keptButton(`${key}:close`, 'settings-dialog-close', '', { kind: 'cancel-draft' }, { title: '关闭（Esc）', icon: 'close' }),
    ])
    const fieldContext = { node, keptInput, keptToggle, keptSelect, onIntent, submit, menus }
    const content = node(`${key}:body`, 'div', 'settings-dialog-body')
    reconcile(
      content,
      form.kind === 'mcp-server'
        ? mcpFieldNodes(form, node, keptInput, onIntent, submit)
        : form.kind === 'provider'
          ? providerNodes(form, key, () => fieldNodes(form, key, fieldContext))
          : fieldNodes(form, key, fieldContext),
    )
    const foot = node(`${key}:foot`, 'div', 'settings-dialog-foot')
    const cancel = keptButton(`${key}:cancel`, 'settings-btn', '取消', { kind: 'cancel-draft' }, { title: '取消（Esc）' })
    reconcile(
      foot,
      form.confirmDiscard
        ? [
            el('span', 'settings-dialog-prompt', '放弃未保存的修改？'),
            keptButton(`${key}:keep`, 'settings-btn', '继续编辑', { kind: 'keep-editing' }, { title: '继续编辑（Esc）' }),
            keptButton(`${key}:discard`, 'settings-btn danger', '放弃修改', { kind: 'discard-draft' }),
          ]
        : [
            cancel,
            keptButton(
              `${key}:submit`,
              'settings-btn primary',
              form.submitting ? '保存中…' : form.submitLabel,
              { kind: 'submit-draft' },
              { title: `${form.submitLabel}（Enter）`, enabled: !form.submitting },
            ),
          ],
    )
    if (error) dialog.setAttribute('aria-describedby', DIALOG_ERROR_ID)
    else dialog.removeAttribute('aria-describedby')
    return [head, content, error ? alerting(el('div', 'settings-error', error), DIALOG_ERROR_ID) : null, foot]
  }

  /** 获取模型列表's outcome, kept so a screen reader hears each change once. */
  function probeNode(probe: SettingsProbeView, key: string): HTMLElement | null {
    if (probe.status === 'idle') return null
    const line = node(`${key}:probe`, 'div', `settings-probe ${probe.status}`, (made) => made.setAttribute('role', 'status'))
    reconcile(line, [
      icon(probe.status === 'running' ? 'spinner' : probe.status === 'ok' ? 'check' : 'close'),
      el('span', 'settings-probe-text', probe.message ?? ''),
    ])
    return line
  }

  /** The provider dialog: the connection fields and the model table. */
  function providerNodes(
    form: Extract<SettingsForm, { kind: 'provider' }>,
    key: string,
    fields: () => Node[],
  ): Array<Node | null> {
    const connection = form.fields.length > 0 ? node(`${key}:fields`, 'div', 'settings-provider-fields') : null
    if (connection) reconcile(connection, fields())

    const running = form.probe?.status === 'running'
    const head = node(`${key}:models-head`, 'div', 'settings-models-head')
    reconcile(head, [
      el('div', 'settings-models-title', '模型'),
      el('span', 'settings-models-count', form.modelCount),
      form.probe
        ? keptButton(`${key}:fetch`, 'settings-btn', running ? '获取中…' : '获取模型列表', { kind: 'test-endpoint' }, { enabled: !running })
        : null,
    ])
    const table = node(`${key}:table`, 'div', 'settings-model-table')
    reconcile(table, [
      form.models.length > 0
        ? el(
            'div',
            'settings-model-head',
            el('span'),
            el('span', undefined, '模型 ID'),
            el('span', undefined, '上下文'),
            el('span', undefined, '显示名'),
            el('span'),
          )
        : el('div', 'settings-model-empty', '还没有模型。'),
      ...form.models.map((row) => modelRowNode(row, key)),
    ])
    return [
      connection,
      head,
      form.probe ? probeNode(form.probe, key) : null,
      form.picker ? pickerNode(form.picker, key) : null,
      table,
      form.canAddModel
        ? keptButton(`${key}:add-model`, 'mcp-form-add-btn', '添加模型', { kind: 'add-model-row' }, { icon: 'plus' })
        : null,
    ]
  }

  /** What 获取模型列表 found; a click adds the model to the table or takes it out. */
  function pickerNode(picker: SettingsModelPicker, key: string): HTMLElement {
    const box = node(`${key}:picker`, 'div', 'settings-model-picker')
    const list = node(`${key}:picker-list`, 'div', 'settings-model-list')
    reconcile(
      list,
      picker.empty
        ? [el('div', 'settings-model-empty', picker.empty)]
        : picker.rows.map((row) => {
            const item = node(`${key}:pick:${row.id}`, 'button', row.picked ? 'settings-model-row picked' : 'settings-model-row', (made) => {
              made.type = 'button'
              made.setAttribute('role', 'checkbox')
              made.addEventListener('click', () => onIntent({ kind: 'toggle-picked-model', id: row.id }))
            })
            item.setAttribute('aria-checked', String(row.picked))
            reconcile(item, [
              el('span', 'settings-model-check', row.picked ? icon('check') : null),
              el('span', 'settings-model-id', row.id),
              row.meta ? el('span', 'settings-model-meta', row.meta) : null,
            ])
            return item
          }),
    )
    const bar = node(`${key}:picker-bar`, 'div', 'settings-model-summary')
    reconcile(bar, [
      el('span', undefined, picker.summary),
      keptButton(`${key}:picker-close`, 'settings-probe-skip', '收起', { kind: 'close-model-picker' }, { title: '收起模型列表' }),
    ])
    reconcile(box, [
      bar,
      picker.filter !== undefined
        ? keptInput(`${key}:filter`, {
            value: picker.filter,
            ariaLabel: '筛选模型',
            placeholder: '筛选模型',
            live: true,
            intentOnCommit: (value) => ({ kind: 'draft-field', field: 'modelFilter', value }),
          })
        : null,
      list,
    ])
    return box
  }

  /** One model: its table line and, opened, its switches, limits and levels. */
  function modelRowNode(row: SettingsModelRowView, formKey: string): HTMLElement {
    const key = `${formKey}:row:${row.rowId}`
    const field = (
      name: ModelRowTextField,
      value: string,
      ariaLabel: string,
      placeholder: string,
      mono = false,
    ): HTMLInputElement => {
      const input = keptInput(`${key}:${name}`, {
        value,
        ariaLabel,
        placeholder,
        ...(mono ? { mono: true } : {}),
        live: true,
        intentOnCommit: (next) => ({ kind: 'model-row-field', rowId: row.rowId, field: name, value: next }),
      })
      input.placeholder = placeholder
      return input
    }
    const toggle = (name: 'thinking' | 'imageInput', label: string, value: boolean): HTMLElement => {
      const line = node(`${key}:${name}-line`, 'div', 'settings-model-switch')
      reconcile(line, [
        el('span', undefined, label),
        keptToggle(`${key}:${name}`, {
          value,
          ariaLabel: label,
          onChange: (next) => onIntent({ kind: 'model-row-switch', rowId: row.rowId, field: name, value: next }),
        }),
      ])
      return line
    }
    const labelled = (slot: string, label: string, input: HTMLInputElement): HTMLElement => {
      const box = node(`${key}:${slot}-box`, 'label', 'settings-model-number')
      reconcile(box, [el('span', undefined, label), input])
      return box
    }

    const item = node(key, 'div', row.expanded ? 'settings-model-item open' : 'settings-model-item')
    const line = node(`${key}:line`, 'div', 'settings-model-line')
    reconcile(line, [
      keptButton(
        `${key}:expand`,
        row.expanded ? 'settings-model-expand open' : 'settings-model-expand',
        '',
        { kind: 'toggle-model-row', rowId: row.rowId },
        { title: row.expanded ? `收起 ${row.model || '模型'}` : `展开 ${row.model || '模型'}`, icon: 'chevron-right' },
      ),
      field('model', row.model, '模型 ID', '模型 ID', true),
      el('span', 'settings-model-context', row.context),
      field('displayName', row.displayName, '显示名', row.displayPlaceholder),
      keptButton(`${key}:remove`, 'mcp-btn-trash', '', { kind: 'remove-model-row', rowId: row.rowId }, { title: `删除 ${row.model || '模型'}`, icon: 'trash' }),
    ])
    let detail: HTMLElement | null = null
    if (row.expanded) {
      detail = node(`${key}:detail`, 'div', 'settings-model-detail')
      const numbers = node(`${key}:numbers`, 'div', 'settings-model-numbers')
      reconcile(numbers, [
        labelled('context', '上下文长度', field('contextWindow', row.contextWindow, '上下文长度', '默认')),
        labelled('output', '最大输出 Token', field('maxOutputTokens', row.maxOutputTokens, '最大输出 Token', '默认')),
      ])
      let levels: HTMLElement | null = null
      if (row.thinking) {
        levels = node(`${key}:levels`, 'div', 'settings-model-levels')
        const trigger = node(`${key}:levels-trigger`, 'button', row.effortsOpen ? 'settings-levels-trigger open' : 'settings-levels-trigger', (made) => {
          made.type = 'button'
          made.addEventListener('click', () => onIntent({ kind: 'toggle-row-efforts', rowId: row.rowId }))
        })
        trigger.setAttribute('aria-expanded', String(row.effortsOpen))
        reconcile(trigger, [icon('chevron-right'), el('span', undefined, '思考档位'), el('span', 'settings-levels-summary', row.effortSummary)])
        reconcile(levels, [
          trigger,
          ...(row.effortsOpen
            ? row.efforts.map((level) => {
                const levelLine = node(`${key}:level:${level.level}`, 'div', 'settings-model-switch level')
                reconcile(levelLine, [
                  el('span', undefined, level.label),
                  keptToggle(`${key}:level-toggle:${level.level}`, {
                    value: level.on,
                    ariaLabel: `思考档位 ${level.label}`,
                    ...(level.locked ? { enabled: false } : {}),
                    onChange: () => onIntent({ kind: 'model-row-effort', rowId: row.rowId, level: level.level }),
                  }),
                ])
                return levelLine
              })
            : []),
        ])
      }
      const prices = node(`${key}:prices`, 'div', 'settings-model-prices')
      const pricesTrigger = node(`${key}:prices-trigger`, 'button', row.pricesOpen ? 'settings-levels-trigger open' : 'settings-levels-trigger', (made) => {
        made.type = 'button'
        made.addEventListener('click', () => onIntent({ kind: 'toggle-row-prices', rowId: row.rowId }))
      })
      pricesTrigger.setAttribute('aria-expanded', String(row.pricesOpen))
      reconcile(pricesTrigger, [icon('chevron-right'), el('span', undefined, '价格'), el('span', 'settings-levels-summary', row.priceSummary)])
      if (row.pricesOpen) {
        const priceGrid = node(`${key}:price-grid`, 'div', 'settings-model-numbers prices')
        const price = (name: 'inputPrice' | 'outputPrice' | 'cacheWritePrice' | 'cacheReadPrice', label: string, value: string, placeholder: string) =>
          labelled(name, label, field(name, value, `${label}（每百万 Token）`, placeholder))
        reconcile(priceGrid, [
          price('inputPrice', '输入', row.inputPrice, '未设置'),
          price('outputPrice', '输出', row.outputPrice, '未设置'),
          price('cacheWritePrice', '缓存写入', row.cacheWritePrice, '同输入'),
          price('cacheReadPrice', '缓存命中', row.cacheReadPrice, '同输入'),
        ])
        const currency = node(`${key}:currency-line`, 'div', 'settings-model-switch level')
        reconcile(currency, [
          el('span', undefined, '币种 · 单价按每百万 Token'),
          keptSelect(`${key}:currency`, {
            value: row.currency,
            ariaLabel: '币种',
            choices: row.currencyChoices,
            field: 'currency',
            intentFor: (value) => ({ kind: 'model-row-field', rowId: row.rowId, field: 'currency', value }),
          }),
        ])
        reconcile(prices, [pricesTrigger, priceGrid, currency])
      } else {
        reconcile(prices, [pricesTrigger])
      }
      reconcile(detail, [
        toggle('thinking', '支持扩展思考', row.thinking),
        toggle('imageInput', '支持图片输入', row.imageInput),
        numbers,
        levels,
        prices,
      ])
    }
    reconcile(item, [line, row.warning ? el('div', 'settings-row-warning', row.warning) : null, detail])
    return item
  }

  function keptToggle(key: string, options: ToggleOptions): HTMLButtonElement {
    claimed.add(key)
    toggles.set(key, options)
    let control = kept.get(key) as HTMLButtonElement | undefined
    if (!control) {
      control = toggleField({ ...options, onChange: (value) => toggles.get(key)?.onChange(value) })
      kept.set(key, control)
    } else updateToggleField(control, options)
    return control
  }

  /**
   * The 自定义指令 page. The page, the textarea and the button row are kept
   * nodes: a rebuilt ancestor would take the focused textarea out of the
   * document and drop the caret on every keystroke.
   */
  function editorNode(editor: SettingsEditor): HTMLElement {
    commits.set('editor', editor.intentOnInput)
    const page = node('editor:page', 'div', 'settings-editor-page')
    const area = node('editor:area', 'textarea', 'settings-textarea', (made) => {
      made.setAttribute('aria-label', '自定义指令')
      made.spellcheck = false
      made.addEventListener('input', () => {
        const commit = commits.get('editor')
        if (commit) onIntent(commit(made.value))
      })
    })
    area.placeholder = editor.placeholder
    area.maxLength = editor.maxLength
    // Never type over the user: a focused box is theirs.
    if (document.activeElement !== area && area.value !== editor.value) area.value = editor.value
    reconcile(page, [area])
    return page
  }

  return {
    render(view: SettingsViewModel): void {
      presence.set(view.open)
      if (!view.open) {
        wasOpen = false
        // A dropdown left open must not keep claiming presses on the screens behind.
        lastOpenMenu = undefined
        // Closed with a form up: the dialog goes with the screen, not on its next opening.
        if (lastFormKey !== undefined) {
          dialogPresence.set(false, true)
          for (const region of [nav, body]) region.removeAttribute('inert')
          lastFormKey = undefined
          lastConfirmDiscard = false
          opener = undefined
        }
        return
      }
      // Only on the transition: focusing on every render would pull the caret out
      // of a form field mid-edit.
      const opening = !wasOpen
      wasOpen = true

      // The only write-back, and conditional on purpose: `input` is synchronous,
      // so the model can only disagree with the box when something *other* than
      // typing emptied the query — Escape, or reopening the screen.
      if (view.query === '' && search.value !== '') search.value = ''

      claimed = new Set<string>()
      pendingFocus.length = 0
      const justOpened = view.openMenu !== lastOpenMenu ? view.openMenu : undefined
      lastOpenMenu = view.openMenu
      // Was the user in this screen before the paint? A pill's shell is rebuilt on
      // every render, so the trigger they were standing on is about to be replaced;
      // without the rescue below, focus lands on `<body>` and this screen's own
      // keydown — Esc included — stops firing until something is clicked.
      const focusWasInside =
        document.activeElement instanceof Node && container.contains(document.activeElement)
      // Read before the column is rebuilt: the button that opened a form may not survive it.
      const activeLabel = document.activeElement?.getAttribute('aria-label') ?? undefined

      replace(
        navList,
        ...view.navGroups.map((group) =>
          el(
            'div',
            'settings-nav-group',
            el('div', 'settings-nav-group-label', group.label),
            ...group.items.map((item) => navItemNode(item, onIntent)),
          ),
        ),
      )

      // A confirmation is drawn inside the card that owns it, so the answer to a
      // click appears where the click was. One whose card the search filtered
      // away falls back to the column, which beats not drawing it.
      const confirmHomeless =
        view.confirming !== undefined && !view.cards.some((card) => card.id === view.confirming!.anchor.cardId)
      const { form } = view
      const menus: FormMenuContext = {
        justOpened,
        focusAfterPaint: (element) => {
          pendingFocus.push(element)
        },
      }
      // An error goes where the user is looking: into the open form, under the
      // row it is about, or — with neither on screen — pinned to the bottom of
      // the scroller, in view however far the page is scrolled.
      const errorRow = view.error && !form
        ? view.errorRows?.find((id) => view.cards.some((card) => card.rows.some((row) => row.id === id)))
        : undefined
      reconcile(column, [
        headerNode(view, onIntent),
        confirmHomeless && view.confirming ? confirmNode(view.confirming.message, onIntent) : null,
        view.searchEmpty ? el('div', 'settings-empty', view.searchEmpty) : null,
        view.editor ? editorNode(view.editor) : null,
        ...view.cards.map((card) =>
          cardNode(card, {
            openMenu: view.openMenu,
            justOpened,
            focusAfterPaint: menus.focusAfterPaint,
            confirm:
              !confirmHomeless && view.confirming?.anchor.cardId === card.id
                ? view.confirming
                : undefined,
            ...(errorRow && view.error ? { rowError: { rowId: errorRow, message: view.error } } : {}),
            node,
            keptInput,
            keptToggle,
            onIntent,
          }),
        ),
        view.error && !form && !errorRow ? alerting(el('div', 'settings-error banner', view.error)) : null,
      ])

      // The dialog keeps its last content while it closes; only an open form repaints it.
      const formKey = form ? formKeyOf(form) : undefined
      if (form) reconcile(dialog, dialogNodes(form, view.error, menus))
      dialog.classList.toggle('wide', form?.kind === 'provider')
      for (const region of [nav, body]) {
        if (form) region.setAttribute('inert', '')
        else region.removeAttribute('inert')
      }
      dialogPresence.set(form !== undefined)
      const firstField = (): HTMLElement | null =>
        dialog.querySelector('.settings-dialog-body')?.querySelector('input, select, button') as HTMLElement | null
      if (formKey !== undefined && lastFormKey === undefined) {
        opener = activeLabel
        const first = firstField()
        if (first) pendingFocus.unshift(first)
      } else if (form?.kind === 'provider' && formKey === lastFormKey) {
        // A row 添加模型 just put in the table: straight to its model id.
        const added = form.models.at(-1)
        if (added && added.model === '' && !lastRowIds.has(added.rowId)) {
          const input = kept.get(`${formKey}:row:${added.rowId}:model`)
          if (input) pendingFocus.unshift(input)
        }
      } else if (form && !form.confirmDiscard && lastConfirmDiscard) {
        // The prompt's buttons are gone; back to the form rather than to nowhere.
        const first = firstField()
        if (first) pendingFocus.unshift(first)
      } else if (formKey === undefined && lastFormKey !== undefined) {
        const back = [...column.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === opener)
        pendingFocus.unshift(back ?? container)
        opener = undefined
      }
      if (form?.confirmDiscard && !lastConfirmDiscard) {
        const keep = dialog.querySelector('.settings-dialog-foot')?.querySelector('button')
        if (keep) pendingFocus.unshift(keep)
      }
      lastFormKey = formKey
      lastRowIds = new Set(form?.kind === 'provider' ? form.models.map((row) => row.rowId) : [])
      lastConfirmDiscard = form?.confirmDiscard === true

      if (view.error && view.error !== lastError) {
        container.querySelector('.settings-error, .settings-row-error')?.scrollIntoView({ block: 'nearest' })
      }
      lastError = view.error
      // A menu opens downward, so one on a low row may start below the fold.
      if (justOpened !== undefined) {
        const trigger = [...container.querySelectorAll('[aria-expanded]')]
          .find((candidate) => candidate.getAttribute('aria-expanded') === 'true')
        trigger?.closest('.settings-menu-shell')?.querySelector('.settings-menu')?.scrollIntoView({ block: 'nearest' })
      }
      // A new page starts at its top, not at the previous page's scroll offset.
      if (view.title !== lastTitle) body.scrollTop = 0
      lastTitle = view.title

      // Everything this paint did not ask for is gone for good, refs included —
      // otherwise a kept node keeps answering with the state that built it.
      for (const key of [...kept.keys()]) {
        if (claimed.has(key)) continue
        finishPresenceWithin(kept.get(key)!)
        kept.delete(key)
        commits.delete(key)
        toggles.delete(key)
      }

      // Only now: everything above is built before it is inserted, and `focus()`
      // on a node outside the document does nothing at all.
      container.classList.toggle('busy', view.busy)
      if (pendingFocus[0]) pendingFocus[0].focus()
      else if (opening) container.focus()
      else if (
        focusWasInside
        && !(document.activeElement instanceof Node && container.contains(document.activeElement))
      ) {
        // The paint took the focused node out from under the user. The screen is
        // the fallback rather than a guess at a replacement: it is what `Ctrl+,`
        // focuses too, and it is the node whose keydown answers Esc. With a form
        // up, the dialog is, for the same reasons.
        ;(form ? dialog : container).focus()
      }
    },
  }
}

/** The two kept-node factories, as the row and card builders below see them. */
type NodeFactory = <K extends keyof HTMLElementTagNameMap>(
  key: string,
  tag: K,
  className: string,
  create?: (element: HTMLElementTagNameMap[K]) => void,
) => HTMLElementTagNameMap[K]

type InputFactory = (
  key: string,
  options: {
    value: string
    ariaLabel: string
    placeholder?: string
    mono?: boolean
    secret?: boolean
    live?: boolean
    onEnter?: () => void
    intentOnCommit: (value: string) => SettingsIntent
  },
) => HTMLInputElement

type ToggleFactory = (key: string, options: ToggleOptions) => HTMLButtonElement

type SelectFactory = (
  key: string,
  options: { value: string; ariaLabel: string; choices: ReadonlyArray<{ value: string; label: string }>; field: string },
) => HTMLSelectElement

function navItemNode(
  item: SettingsNavItem,
  onIntent: (intent: SettingsIntent) => void,
): HTMLButtonElement {
  const node = button(
    item.selected ? 'settings-nav-item selected' : 'settings-nav-item',
    item.label,
    item.label,
    () => onIntent({ kind: 'select-category', category: item.category }),
  )
  // The selected category is said, not only drawn: `.selected` is a fill.
  if (item.selected) node.setAttribute('aria-current', 'page')
  return node
}

const DIALOG_TITLE_ID = 'settings-dialog-title'
const DIALOG_ERROR_ID = 'settings-dialog-error'

function titled(node: HTMLElement): HTMLElement {
  node.id = DIALOG_TITLE_ID
  return node
}

/** An error a screen reader hears when it appears, not only when it is read to. */
function alerting(node: HTMLElement, id?: string): HTMLElement {
  node.setAttribute('role', 'alert')
  if (id !== undefined) node.id = id
  return node
}

function headerNode(
  view: SettingsViewModel,
  onIntent: (intent: SettingsIntent) => void,
): HTMLElement {
  const header = el('div', 'settings-header', el('div', 'settings-title', view.title))
  if (view.editor) {
    const { editor } = view
    const enabled = editor.dirty && !editor.saving
    header.appendChild(
      el(
        'div',
        'settings-editor-actions',
        button('settings-btn', '取消', '放弃未保存的修改', () => onIntent(editor.intentOnCancel), { enabled }),
        button('settings-btn primary', '保存', '保存自定义指令', () => onIntent(editor.intentOnSave), { enabled }),
      ),
    )
  }
  // Only worth a selector when there is a choice to make.
  if (view.projectChoices.length > 1) {
    header.appendChild(
      selectField({
        className: 'settings-select settings-project',
        value: view.projectValue,
        ariaLabel: '选择项目',
        choices: view.projectChoices,
        onChange: (projectRoot) => onIntent({ kind: 'select-project', projectRoot }),
      }),
    )
  }
  if (view.subtitle) header.appendChild(hinted(el('div', 'settings-subtitle', view.subtitle), view.subtitleHint))
  return header
}

function confirmNode(message: string, onIntent: (intent: SettingsIntent) => void): HTMLElement {
  return el(
    'div',
    'settings-confirm',
    el('span', 'settings-confirm-text', message),
    button('settings-btn danger', '删除', `${message}（Enter）`, () =>
      onIntent({ kind: 'confirm-remove' }),
    ),
    button('settings-btn', '取消', '取消（Esc）', () => onIntent({ kind: 'cancel-remove' })),
  )
}

function cardNode(
  card: SettingsCard,
  context: {
    openMenu: string | undefined
    justOpened: string | undefined
    focusAfterPaint: (element: HTMLElement) => void
    confirm?: { message: string; anchor: SettingsAnchor }
    rowError?: { rowId: string; message: string }
    node: NodeFactory
    keptInput: InputFactory
    keptToggle: ToggleFactory
    onIntent: (intent: SettingsIntent) => void
  },
): HTMLElement {
  const { node, onIntent } = context
  const section = node(`card:${card.id}`, 'section', 'settings-card')
  const children: Array<Node | null> = [el('div', 'settings-card-title', card.title)]
  if (card.note) children.push(hinted(el('div', 'settings-card-note', card.note), card.noteHint))
  if (card.rows.length === 0 && card.empty) {
    children.push(el('div', 'settings-empty', card.empty))
  }
  for (const row of card.rows) {
    children.push(rowNode(card.id, row, context))
    // Directly under the row they are about, so the reader does not hunt for them.
    if (context.rowError?.rowId === row.id) {
      children.push(alerting(el('div', 'settings-row-error', context.rowError.message)))
    }
    if (context.confirm?.anchor.rowId === row.id) {
      children.push(confirmNode(context.confirm.message, onIntent))
    }
  }
  if (context.confirm && context.confirm.anchor.rowId === undefined) {
    children.push(confirmNode(context.confirm.message, onIntent))
  }
  if (card.footerButtons?.length) {
    const footer = el('div', 'settings-card-footer')
    for (const spec of card.footerButtons) footer.appendChild(buttonNode(spec, onIntent))
    children.push(footer)
  }
  reconcile(section, children)
  return section
}

function rowNode(
  cardId: string,
  row: SettingsRow,
  context: {
    openMenu: string | undefined
    justOpened: string | undefined
    focusAfterPaint: (element: HTMLElement) => void
    node: NodeFactory
    keptInput: InputFactory
    keptToggle: ToggleFactory
    onIntent: (intent: SettingsIntent) => void
  },
): HTMLElement {
  const { onIntent } = context
  const label = el('div', 'settings-row-label', el('div', 'settings-row-name', row.label))
  if (row.detail) label.appendChild(hinted(el('div', 'settings-row-desc', row.detail), row.detailHint))
  if (row.warning) label.appendChild(el('div', 'settings-row-warning', row.warning))

  // Kept, like the row around it, and for a reason the row alone does not cover:
  // a kept `<input>` appended into a *freshly built* control cell is taken out of
  // the document to get there, and a node that leaves the document is blurred on
  // the spot. Keeping the leaf is only half of it — the cell it sits in has to be
  // the same cell too, or the caret is dropped once per keystroke.
  const control = context.node(`control:${cardId}:${row.id}`, 'div', 'settings-row-control')
  const controls: Node[] = []
  switch (row.control.kind) {
    case 'text':
      controls.push(
        el('span', row.control.muted ? 'settings-row-value muted' : 'settings-row-value', row.control.value),
      )
      break
    case 'select': {
      const { intentOnChange } = row.control
      // Keyed by row id, which is already unique per page. The key stays in the
      // DOM so `SettingsControl` — and every model test of it — is untouched.
      const menu = `row:${row.id}`
      controls.push(
        pillSelect({
          value: row.control.value,
          ariaLabel: row.label,
          choices: row.control.choices,
          open: context.openMenu === menu,
          ...(row.pending ? { enabled: false } : {}),
          // Only on the paint that opened it: a menu that was already open may
          // hold a reader who has arrowed down it, and re-focusing the first
          // option would drag them back to the top once per repaint.
          ...(context.justOpened === menu
            ? { onFirstItem: (item: HTMLElement) => context.focusAfterPaint(item) }
            : {}),
          onToggle: () => onIntent({ kind: 'toggle-menu', menu }),
          onCloseFocus: context.focusAfterPaint,
          onChange: (value) => onIntent(intentOnChange(value)),
        }, context.node(`menu:${row.id}`, 'div', 'settings-menu-shell')),
      )
      break
    }
    case 'toggle': {
      const { intentOnChange } = row.control
      controls.push(
        context.keptToggle(`toggle:${row.id}`, {
          value: row.control.value,
          ariaLabel: row.label,
          // A row waiting on its own change is not a second switch to flip.
          ...(row.control.disabled || row.pending ? { enabled: false } : {}),
          onChange: (value) => onIntent(intentOnChange(value)),
        }),
      )
      break
    }
    case 'input': {
      const { intentOnCommit } = row.control
      controls.push(
        context.keptInput(`input:${row.id}`, {
          value: row.control.value,
          ariaLabel: row.label,
          ...(row.control.placeholder !== undefined ? { placeholder: row.control.placeholder } : {}),
          ...(row.control.mono ? { mono: true } : {}),
          intentOnCommit,
        }),
      )
      if (row.control.unit) controls.push(el('span', 'settings-row-unit', row.control.unit))
      break
    }
    case 'buttons':
      for (const spec of row.control.buttons) {
        controls.push(buttonNode(row.pending ? { ...spec, pending: true } : spec, onIntent))
      }
      break
    case 'toggle-and-buttons': {
      const { intentOnChange } = row.control.toggle
      controls.push(
        context.keptToggle(`toggle:${row.id}:with-buttons`, {
          value: row.control.toggle.value,
          ariaLabel: row.label,
          ...(row.control.toggle.disabled || row.pending ? { enabled: false } : {}),
          onChange: (value) => onIntent(intentOnChange(value)),
        }),
      )
      for (const spec of row.control.buttons) {
        controls.push(buttonNode(row.pending ? { ...spec, pending: true } : spec, onIntent))
      }
      break
    }
    default:
      // A control kind with no case here would draw an *empty* cell — a row whose
      // setting silently cannot be changed. `runSidebarIntent` was caught by the
      // same omission, which is why this is a compile error instead.
      assertNeverControl(row.control)
  }
  reconcile(control, controls)
  const element = context.node(
    `row:${cardId}:${row.id}`,
    'div',
    row.pending ? 'settings-row pending' : 'settings-row',
  )
  // Says "this row is waiting" to a screen reader, which the dimming alone does
  // not: colour may not be the only carrier.
  if (row.pending) element.setAttribute('aria-busy', 'true')
  else element.removeAttribute('aria-busy')
  reconcile(element, [label, control])
  return element
}

/** Hover text for the path or fine print a line of copy stands in for. */
function hinted(element: HTMLElement, hint: string | undefined): HTMLElement {
  if (hint) {
    element.title = hint
    element.classList.add('has-hint')
  }
  return element
}

function assertNeverControl(value: never): never {
  throw new Error(`Unhandled settings control: ${JSON.stringify(value)}`)
}

function buttonNode(spec: SettingsButton, onIntent: (intent: SettingsIntent) => void): HTMLButtonElement {
  return button(
    spec.danger ? 'settings-btn danger' : 'settings-btn',
    spec.label,
    spec.title,
    () => onIntent(spec.intent),
    {
      ...(spec.icon ? { icon: spec.icon } : {}),
      ...(spec.pending ? { enabled: false } : {}),
    },
  )
}

/** What a form's menu fields need from the paint, mirroring `cardNode`'s. */
export interface FormMenuContext {
  justOpened: string | undefined
  focusAfterPaint: (element: HTMLElement) => void
}

/**
 * The key a form's kept nodes share. From the anchor, never a counter: opening
 * a *different* form drops this one's nodes, while repainting the same form
 * keeps every field's caret.
 */
function formKeyOf(form: SettingsForm): string {
  return `form:${form.anchor.cardId}:${form.anchor.rowId ?? ''}${form.kind === 'mcp-server' ? ':mcp' : ''}`
}

function docLinkNode(link: HTMLAnchorElement): HTMLAnchorElement {
  if (!link.firstChild) {
    link.replaceChildren(el('span', 'btn-label', '文档'), icon('external'))
    link.href = 'https://modelcontextprotocol.io'
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    link.title = 'MCP 文档'
  }
  return link
}

/**
 * A form's fields, label above control. Every wrapper is kept, not just the
 * control: `appendChild` moves a node by detaching it first, and a focused
 * `<input>` that leaves the document for that instant is blurred — once per
 * character, since a form field commits `live`.
 */
function fieldNodes(
  form: { readonly fields: readonly SettingsFormField[] },
  key: string,
  context: {
    node: NodeFactory
    keptInput: InputFactory
    keptToggle: ToggleFactory
    keptSelect: SelectFactory
    onIntent: (intent: SettingsIntent) => void
    submit: () => void
    menus: FormMenuContext
  },
): Node[] {
  const { node, onIntent, menus } = context
  return form.fields.map((field) => {
    const wrapper = node(`${key}:field:${field.id}`, 'div', field.toggle ? 'settings-field switch' : 'settings-field')
    const label = el('div', 'settings-field-label', field.label)
    const note = field.note ? el('div', 'settings-field-note', field.note) : null
    if (field.toggle) {
      const control = context.keptToggle(`${key}:toggle:${field.id}`, {
        value: field.value === 'on',
        ariaLabel: field.label,
        onChange: (value) => onIntent({ kind: 'draft-field', field: field.id, value: value ? 'on' : '' }),
      })
      reconcile(wrapper, [el('div', 'settings-field-text', label, note), control])
      return wrapper
    }
    let control: HTMLElement
    if (field.multi) {
      const multi = field.multi
      control = multiSelectField({
        summary: multi.summary,
        ariaLabel: field.label,
        choices: multi.options,
        selected: multi.selected,
        open: multi.open,
        // Focus moves into the menu only on the paint that opened it; a click
        // that merely checks an item must leave the caret where it was.
        ...(menus.justOpened === multi.menuId
          ? { onFirstItem: (item: HTMLElement) => menus.focusAfterPaint(item) }
          : {}),
        onToggle: () => onIntent(multi.intentOnToggleMenu),
        onCloseFocus: menus.focusAfterPaint,
        onToggleValue: (value) => onIntent(multi.intentOnToggle(value)),
      }, node(`${key}:menu:${field.id}`, 'div', 'settings-menu-shell'))
    } else if (field.choices) {
      control = context.keptSelect(`${key}:select:${field.id}`, {
        value: field.value,
        ariaLabel: field.label,
        choices: field.choices,
        field: field.id,
      })
    } else {
      const input = context.keptInput(`${key}:${field.id}`, {
        value: field.value,
        ariaLabel: field.label,
        ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
        ...(field.mono ? { mono: true } : {}),
        ...(field.secret ? { secret: true } : {}),
        live: true,
        onEnter: context.submit,
        intentOnCommit: (value) => ({ kind: 'draft-field', field: field.id, value }),
      })
      control = input
      if (field.reveal) {
        const { visible, intent } = field.reveal
        input.type = visible ? 'text' : 'password'
        control = node(`${key}:reveal:${field.id}`, 'div', 'settings-secret')
        reconcile(control, [
          input,
          // Rebuilt rather than kept: its glyph follows `visible`.
          button('settings-secret-toggle', '', visible ? '隐藏 API Key' : '显示 API Key', () => onIntent(intent), {
            icon: visible ? 'eye-off' : 'eye',
          }),
        ])
      }
    }
    reconcile(wrapper, [label, control, note])
    return wrapper
  })
}

/** The MCP server form's fields: identity, then the transport's own. */
function mcpFieldNodes(
  form: Extract<SettingsForm, { kind: 'mcp-server' }>,
  node: NodeFactory,
  keptInput: InputFactory,
  onIntent: (intent: SettingsIntent) => void,
  submit: () => void,
): Node[] {
  const { draft } = form
  const key = formKeyOf(form)
  const children: Node[] = []

  const identityCard = node(`${key}:card:identity`, 'div', 'mcp-form-card')
  const nameInput = keptInput(`${key}:name`, {
    value: draft.name,
    ariaLabel: '名称',
    placeholder: '例如 sqlite',
    live: true,
    onEnter: submit,
    intentOnCommit: (value) => ({ kind: 'draft-field', field: 'name', value }),
  })
  const typeRow = node(`${key}:type:row`, 'div', 'mcp-type-row')
  const segmented = node(`${key}:segmented:transport`, 'div', 'mcp-segmented-control')
  const stdioBtn = button(
    draft.transport === 'stdio' ? 'mcp-segmented-btn active' : 'mcp-segmented-btn',
    'STDIO',
    'STDIO',
    () => onIntent({ kind: 'draft-field', field: 'transport', value: 'stdio' }),
  )
  const sseBtn = button(
    draft.transport === 'sse' ? 'mcp-segmented-btn active' : 'mcp-segmented-btn',
    '流式 HTTP',
    '流式 HTTP',
    () => onIntent({ kind: 'draft-field', field: 'transport', value: 'sse' }),
  )
  reconcile(segmented, [stdioBtn, sseBtn])
  reconcile(typeRow, [el('div', 'mcp-form-label', '类型'), segmented])
  reconcile(identityCard, [el('div', 'mcp-form-label', '名称'), nameInput])
  children.push(identityCard, typeRow)

  /** One labelled single field. */
  const single = (slot: string, label: string, value: string, placeholder: string, field: string): HTMLElement => {
    const card = node(`${key}:card:${slot}`, 'div', 'mcp-form-card')
    reconcile(card, [
      el('div', 'mcp-form-label', label),
      keptInput(`${key}:${slot}`, {
        value,
        ariaLabel: label,
        placeholder,
        mono: true,
        live: true,
        onEnter: submit,
        intentOnCommit: (next) => ({ kind: 'draft-field', field, value: next }),
      }),
    ])
    return card
  }

  /** One labelled list of single values with a remove button each. */
  const list = (
    slot: string,
    label: string,
    noun: string,
    addLabel: string,
    values: readonly string[],
    placeholder: string | undefined,
    intents: {
      update: (index: number, value: string) => SettingsIntent
      remove: (index: number) => SettingsIntent
      add: SettingsIntent
    },
  ): HTMLElement => {
    const card = node(`${key}:card:${slot}`, 'div', 'mcp-form-card')
    const rows = node(`${key}:list:${slot}`, 'div', 'mcp-form-list')
    reconcile(rows, values.map((value, idx) => {
      const row = node(`${key}:${slot}:row:${idx}`, 'div', 'mcp-form-row')
      reconcile(row, [
        keptInput(`${key}:${slot}:${idx}`, {
          value,
          ariaLabel: `${noun} ${idx + 1}`,
          ...(placeholder !== undefined ? { placeholder } : {}),
          mono: true,
          live: true,
          onEnter: submit,
          intentOnCommit: (next) => intents.update(idx, next),
        }),
        button('mcp-btn-trash', '', `删除${noun} ${idx + 1}`, () => onIntent(intents.remove(idx)), { icon: 'trash' }),
      ])
      return row
    }))
    reconcile(card, [
      el('div', 'mcp-form-label', label),
      rows,
      button('mcp-form-add-btn', addLabel, addLabel, () => onIntent(intents.add), { icon: 'plus' }),
    ])
    return card
  }

  /** One labelled list of key/value pairs — the env list and the header list differ only in wording. */
  const pairs = (
    slot: string,
    label: string,
    noun: string,
    entries: readonly { readonly key: string; readonly value: string }[],
    intents: {
      update: (index: number, part: { key?: string; value?: string }) => SettingsIntent
      remove: (index: number) => SettingsIntent
      add: SettingsIntent
    },
  ): HTMLElement => {
    const card = node(`${key}:card:${slot}`, 'div', 'mcp-form-card')
    const rows = node(`${key}:list:${slot}`, 'div', 'mcp-form-list')
    reconcile(rows, entries.map((item, idx) => {
      const row = node(`${key}:${slot}:row:${idx}`, 'div', 'mcp-form-row mcp-env-row')
      reconcile(row, [
        keptInput(`${key}:${slot}:key:${idx}`, {
          value: item.key,
          ariaLabel: `${noun}键 ${idx + 1}`,
          placeholder: '键',
          mono: true,
          live: true,
          onEnter: submit,
          intentOnCommit: (next) => intents.update(idx, { key: next }),
        }),
        keptInput(`${key}:${slot}:val:${idx}`, {
          value: item.value,
          ariaLabel: `${noun}值 ${idx + 1}`,
          placeholder: '值',
          mono: true,
          live: true,
          onEnter: submit,
          intentOnCommit: (next) => intents.update(idx, { value: next }),
        }),
        button('mcp-btn-trash', '', `删除${noun} ${idx + 1}`, () => onIntent(intents.remove(idx)), { icon: 'trash' }),
      ])
      return row
    }))
    reconcile(card, [
      el('div', 'mcp-form-label', label),
      rows,
      button('mcp-form-add-btn', `添加${noun}`, `添加${noun}`, () => onIntent(intents.add), { icon: 'plus' }),
    ])
    return card
  }

  if (draft.transport === 'stdio') {
    children.push(
      single('command', '启动命令', draft.command, 'npx -y @modelcontextprotocol/server-sqlite', 'command'),
      list('args', '参数', '参数', '添加参数', draft.args, undefined, {
        update: (index, value) => ({ kind: 'mcp-update-arg', index, value }),
        remove: (index) => ({ kind: 'mcp-remove-arg', index }),
        add: { kind: 'mcp-add-arg' },
      }),
      // Only for stdio — an environment cannot follow an HTTP request.
      pairs('env', '环境变量', '环境变量', draft.env, {
        update: (index, part) => ({ kind: 'mcp-update-env', index, ...part }),
        remove: (index) => ({ kind: 'mcp-remove-env', index }),
        add: { kind: 'mcp-add-env' },
      }),
      list('pt', '环境变量传递', '环境变量传递', '添加变量', draft.envPassthrough, '例如 PATH 或 API_KEY', {
        update: (index, value) => ({ kind: 'mcp-update-env-passthrough', index, value }),
        remove: (index) => ({ kind: 'mcp-remove-env-passthrough', index }),
        add: { kind: 'mcp-add-env-passthrough' },
      }),
      single('cwd', '工作目录', draft.cwd, '~/code', 'cwd'),
    )
  } else {
    children.push(
      single('url', 'URL', draft.url, 'http://localhost:3000/sse', 'url'),
      // Where a hosted endpoint's bearer token goes.
      pairs('headers', '请求头', '请求头', draft.headers, {
        update: (index, part) => ({ kind: 'mcp-update-header', index, ...part }),
        remove: (index) => ({ kind: 'mcp-remove-header', index }),
        add: { kind: 'mcp-add-header' },
      }),
    )
  }
  return children
}
