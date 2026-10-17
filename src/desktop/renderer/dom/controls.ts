import { el, reconcile } from './dom.js'
import { createPresence } from './presence.js'
import { followPointer, rovingFocus } from './focus.js'
import { icon, type IconName } from './icons.js'

/**
 * The shared form controls.
 *
 * `button()` moved here from `sidebarView.ts` when the settings screen became
 * the second caller; the text and select fields are new with it. Nothing in
 * here holds a colour or a layout decision — that is the stylesheet's, and
 * `test/rendererStyleTokens.test.ts` enforces it by scanning for `.style.*`.
 *
 * No `innerHTML`, ever: every node is built with `el()`, and the one file
 * allowed to reach for `createElementNS` is `icons.ts`.
 */

export function button(
  className: string,
  label: string,
  title: string,
  onClick: () => void,
  options: { enabled?: boolean; icon?: IconName; trailingIcon?: IconName } = {},
): HTMLButtonElement {
  const node = el('button', className)
  node.type = 'button'
  node.title = title
  node.setAttribute('aria-label', title)
  // Built up rather than assigned as `textContent`, because an icon child would
  // be wiped by it. An icon-only button passes an empty label and relies on the
  // `aria-label` above for its name.
  //
  // Two parameters rather than one plus a convention: `icon` used to be inserted
  // before the label unconditionally, which drew every dropdown as `⌵ 跟随系统`
  // while `design_guidance.md` asks for 「左图标 + 文本 + `⌵`」 (六), 「项目名 +
  // `⌵`」 (三.2) and 「已处理 Xm Xs `⌵`」 (四.3). Where the glyph goes is now the
  // call site's explicit decision instead of something it has to remember.
  if (options.icon) node.appendChild(icon(options.icon))
  if (label) node.appendChild(el('span', 'btn-label', label))
  if (options.trailingIcon) node.appendChild(icon(options.trailingIcon))
  node.disabled = options.enabled === false
  node.addEventListener('click', (event) => {
    // Rows are clickable too; a button inside one must not also activate it.
    event.stopPropagation()
    onClick()
  })
  return node
}

/**
 * A text input that commits on `change` and on Enter — **never per keystroke**,
 * unless `live` says otherwise.
 *
 * A settings *row* ends every commit in a config write, so a keystroke-level
 * handler there would rewrite `config.json` once per character typed and fan a
 * runtime rebuild out to every open lane while doing it. A *form* field is the
 * opposite: it writes `SettingsState.draft`, which never leaves the renderer
 * until 保存 is pressed. `live` is for those, and it is not a nicety — a
 * blur-commit re-renders the screen on `mousedown`, which used to rebuild the
 * 保存 button before `mouseup` reached it and swallow the click whole.
 *
 * Escape is not handled: it belongs to the container, which uses it to unwind
 * the form. The input stops propagation only for Enter, which it consumes.
 */
export function textField(options: {
  className?: string
  value: string
  placeholder?: string
  ariaLabel: string
  mono?: boolean
  live?: boolean
  onCommit: (value: string) => void
  /** Runs after the Enter commit: a dialog's fields submit it. */
  onEnter?: () => void
}): HTMLInputElement {
  const node = el('input', options.className ?? 'settings-input')
  node.type = 'text'
  node.value = options.value
  node.setAttribute('aria-label', options.ariaLabel)
  if (options.placeholder) node.placeholder = options.placeholder
  if (options.mono) node.classList.add('mono')
  // One of the two, never both. A `live` field has already committed every
  // character by the time it loses focus, so a `change` on top of that is a
  // *second* commit fired by the blur — and that blur is the `mousedown` on 保存,
  // whose re-render rebuilt the button before `mouseup` reached it. The click the
  // user aimed at the footer was swallowed, once per edit.
  if (options.live) node.addEventListener('input', () => options.onCommit(node.value))
  else node.addEventListener('change', () => options.onCommit(node.value))
  node.addEventListener('keydown', (event) => {
    // Mid-IME composition Enter commits the pinyin letters, not the field.
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    event.stopPropagation()
    options.onCommit(node.value)
    options.onEnter?.()
  })
  return node
}

/**
 * A switch.
 *
 * A `<button role="switch">` rather than a checkbox: a checkbox has to be
 * un-styled before it can be re-styled (`appearance: none` plus a replacement
 * for every state), while a button is a blank surface already, and `aria-checked`
 * says the same thing to a screen reader that `checked` would.
 *
 * The knob is a child element rather than a pseudo-element so the stylesheet can
 * move it without either file knowing a colour.
 */
export interface ToggleOptions {
  className?: string
  value: boolean
  ariaLabel: string
  enabled?: boolean
  onChange: (value: boolean) => void
}

export function toggleField(options: ToggleOptions): HTMLButtonElement {
  const node = el('button', options.className ?? 'settings-toggle')
  node.type = 'button'
  node.setAttribute('role', 'switch')
  updateToggleField(node, options)
  node.appendChild(el('span', 'settings-toggle-knob'))
  node.addEventListener('click', (event) => {
    // Same reason as `button()`: settings rows are clickable containers.
    event.stopPropagation()
    if (!node.disabled) options.onChange(node.getAttribute('aria-checked') !== 'true')
  })
  return node
}

/** Update the switch in place, leaving its sliding knob and listener intact. */
export function updateToggleField(node: HTMLButtonElement, options: ToggleOptions): void {
  node.setAttribute('aria-checked', options.value ? 'true' : 'false')
  node.setAttribute('aria-label', options.ariaLabel)
  node.title = options.ariaLabel
  node.disabled = options.enabled === false
  node.classList.toggle('on', options.value)
}

/**
 * A select. `value` is assigned *after* the options are appended — assigning it
 * to an empty select silently does nothing, which reads as "the control forgot
 * the user's setting" and is invisible in review.
 */
export function selectField(options: {
  className?: string
  value: string
  ariaLabel: string
  choices: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
  onChange: (value: string) => void
}): HTMLSelectElement {
  const node = el('select', options.className ?? 'settings-select')
  node.setAttribute('aria-label', options.ariaLabel)
  for (const choice of options.choices) {
    const option = el('option')
    option.value = choice.value
    option.textContent = choice.label
    if (choice.disabled) option.disabled = true
    node.appendChild(option)
  }
  node.value = options.value
  node.addEventListener('change', () => options.onChange(node.value))
  return node
}

/**
 * A pill dropdown: a trigger button plus a `role="listbox"` of buttons.
 *
 * Used for the settings *rows*; the header's project picker and the form fields
 * stay on `selectField`, because a native `<select>` is keyboard- and
 * screen-reader-complete for free and a form is a keyboard flow. Everything this
 * one has to re-implement by hand is below.
 *
 * Open intent lives in `SettingsState.openMenu`; each retained shell owns its
 * visual phase and keeps the focused option across data refreshes.
 */
/**
 * `pillSelect` for a *set*: every option is checkable and a click does not close.
 *
 * Shares the `.settings-menu-shell` class rather than inventing one, so
 * `settingsView.ts`'s single `onPressOutside(['.settings-menu-shell'])` closes
 * this too — with `openMenu` and the screen's Escape handler that is all three
 * dismissal routes, none of them written twice.
 */
interface MenuFieldOptions {
  summary: string
  ariaLabel: string
  choices: ReadonlyArray<{ value: string; label: string }>
  selected: readonly string[]
  open: boolean
  multiple: boolean
  enabled?: boolean
  onFirstItem?: (item: HTMLButtonElement) => void
  onCloseFocus?: (item: HTMLButtonElement) => void
  onToggle: () => void
  onSelect: (value: string) => void
}

// The cache belongs to each kept shell, never to a setting name across screens.
const menuFields = new WeakMap<HTMLElement, (options: MenuFieldOptions) => void>()

function menuField(options: MenuFieldOptions, owner?: HTMLElement): HTMLElement {
  const shell = owner ?? el('div', 'settings-menu-shell')
  let update = menuFields.get(shell)
  if (!update) {
    let current = options
    const label = el('span', 'btn-label')
    const trigger = button('settings-pill', '', '', () => current.onToggle(), { trailingIcon: 'chevron-down' })
    trigger.insertBefore(label, trigger.firstChild)
    trigger.setAttribute('aria-haspopup', 'listbox')
    const menu = el('div', 'settings-menu')
    menu.setAttribute('role', 'listbox')
    const presence = createPresence(menu, { direction: 'drop' })
    const kept = new Map<string, { node: HTMLButtonElement; label: HTMLElement; check: SVGElement }>()
    let items: HTMLButtonElement[] = []
    shell.appendChild(trigger)
    shell.addEventListener('keydown', (event) => rovingFocus(event, items, current.open, current.onToggle))
    followPointer(menu, '.settings-menu-item')
    update = (next) => {
      const returning = current.open && !next.open && menu.contains(document.activeElement)
      current = next
      if (label.textContent !== next.summary) label.textContent = next.summary
      trigger.title = next.ariaLabel
      trigger.setAttribute('aria-label', next.ariaLabel)
      trigger.setAttribute('aria-expanded', String(next.open))
      trigger.disabled = next.enabled === false
      trigger.classList.toggle('open', next.open)
      menu.setAttribute('aria-label', next.ariaLabel)
      if (next.multiple) menu.setAttribute('aria-multiselectable', 'true')
      if (next.open) {
        if (menu.parentElement !== shell) shell.appendChild(menu)
        items = next.choices.map((choice) => {
          let row = kept.get(choice.value)
          if (!row) {
            const node = button('settings-menu-item', '', choice.label, () => current.onSelect(choice.value))
            node.setAttribute('role', 'option')
            row = { node, label: el('span', 'btn-label'), check: icon('check', 'icon settings-menu-check') }
            kept.set(choice.value, row)
          }
          const selected = next.selected.includes(choice.value)
          row.node.classList.toggle('checkable', next.multiple)
          row.node.classList.toggle('checked', next.multiple && selected)
          row.node.classList.toggle('active', !next.multiple && selected)
          row.node.setAttribute('aria-selected', String(selected))
          row.node.setAttribute('aria-label', choice.label)
          row.node.title = choice.label
          if (row.label.textContent !== choice.label) row.label.textContent = choice.label
          reconcile(row.node, [next.multiple && selected ? row.check : undefined, row.label])
          return row.node
        })
        reconcile(menu, items)
        const live = new Set(next.choices.map((choice) => choice.value))
        for (const key of kept.keys()) if (!live.has(key)) kept.delete(key)
      }
      presence.set(next.open)
      if (next.open && items[0]) next.onFirstItem?.(items[0])
      if (returning) next.onCloseFocus?.(trigger)
    }
    menuFields.set(shell, update)
  }
  update(options)
  return shell
}

export function multiSelectField(options: {
  summary: string
  ariaLabel: string
  choices: ReadonlyArray<{ value: string; label: string }>
  selected: readonly string[]
  open: boolean
  onFirstItem?: (item: HTMLButtonElement) => void
  onCloseFocus?: (item: HTMLButtonElement) => void
  onToggle: () => void
  onToggleValue: (value: string) => void
}, owner?: HTMLElement): HTMLElement {
  return menuField({ ...options, multiple: true, onSelect: options.onToggleValue }, owner)
}

export function pillSelect(options: {
  value: string
  ariaLabel: string
  choices: ReadonlyArray<{ value: string; label: string }>
  open: boolean
  enabled?: boolean
  onFirstItem?: (item: HTMLButtonElement) => void
  onCloseFocus?: (item: HTMLButtonElement) => void
  onToggle: () => void
  onChange: (value: string) => void
}, owner?: HTMLElement): HTMLElement {
  const summary = options.choices.find((choice) => choice.value === options.value)?.label ?? options.value
  return menuField({ ...options, summary, selected: [options.value], multiple: false, onSelect: options.onChange }, owner)
}
