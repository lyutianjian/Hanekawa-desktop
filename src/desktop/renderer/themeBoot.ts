/**
 * The first frame's two attributes, written before the stylesheet paints.
 *
 * `app.js` is a module script, and module scripts run after parsing — late
 * enough that Chromium may already have painted the bare `:root` (dark, with the
 * cross-platform font stacks). For a light-theme user that is a black flash on
 * every launch, and for everyone a font swap once `bindWindowChrome` writes
 * `data-platform`. This file is bundled on its own as a classic script
 * (`theme-boot.js`, IIFE) and loaded synchronously in `<head>`, ahead of the
 * stylesheets, so both attributes are on `<html>` before anything is drawn. The
 * CSP's `script-src 'self'` admits it; only an *inline* script is refused.
 *
 * It decides nothing of its own: the preference is read and resolved by the
 * same `model/theme.ts` functions `app.ts` uses, and `app.ts` writes both
 * attributes again when it boots — this only moves the first write earlier.
 * `main.ts` opens the window on the remembered theme's background, so the frame
 * before *this* one is the right colour too.
 *
 * Every read is guarded: a storage that throws (a locked profile) must cost the
 * remembered theme, never the page — an exception here would stop nothing, but
 * would leave a stack in the console of every launch.
 */
import {
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  systemThemeFromMatches,
} from './model/theme.js'

const root = document.documentElement

let stored: string | null = null
try {
  stored = window.localStorage.getItem(THEME_STORAGE_KEY)
} catch {
  // Unreadable storage reads as "no choice made", which follows the system.
}

let systemDark = true
try {
  systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
} catch {
  // No media queries: the dark default the bare `:root` already paints.
}

root.dataset.theme = resolveTheme(parseThemePreference(stored), systemThemeFromMatches(systemDark))

// The preload has exposed the bridge before any page script runs, so the
// platform font stacks (`:root[data-platform=…]`) apply from the first frame.
const platform = window.hanekawa?.platform
if (platform !== undefined) root.dataset.platform = platform
