import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.HERMES_HOME || join(homedir(), '.hermes')
const probe = process.env.HERMES_QUOTA_PROBE || join(home, 'desktop-plugins', 'quota-dash', 'probe.py')
const providers = {
  'openai-codex': 'Codex',
  'opencode-go': 'OpenCode Go',
  commandcode: 'CommandCode',
  'claude-subscription': 'Claude'
}
// Session provider id (session.info.provider) → probe provider id. The Claude
// subscription plugins drive Claude Code's own OAuth login, which the probe
// meters as `claude-subscription`.
const aliases = {
  'claude-subscription-directsdk-experimental': 'claude-subscription',
  'claude-subscription-directsdk': 'claude-subscription'
}

/** The probe id that meters a session provider, or null when unsupported. */
export function probeIdFor(sessionProvider) {
  const id = aliases[sessionProvider] || sessionProvider
  return id && Object.hasOwn(providers, id) ? id : null
}
const intervalMs = 60_000

/**
 * Which interpreter runs the probe, and whether PYTHONPATH must be cleared.
 *
 * The probe imports httpx. Inside the TUI, HERMES_PYTHON points at the bare
 * tool interpreter, which only has httpx via the inherited PYTHONPATH — so
 * preferring HERMES_PYTHON *and* clearing PYTHONPATH leaves no httpx at all
 * (`ModuleNotFoundError`, probe exits 1). The Hermes venv carries its own
 * httpx, so it goes first and is safe to run with a clean PYTHONPATH (the
 * global value would otherwise shadow the venv). A non-venv fallback keeps
 * PYTHONPATH, because that is the only thing giving it dependencies.
 */
export function interpreterFor(env = process.env, has = existsSync) {
  if (env.HERMES_QUOTA_PYTHON) return { cleanPythonPath: false, cmd: env.HERMES_QUOTA_PYTHON }
  const venv = join(env.HERMES_HOME || join(homedir(), '.hermes'), 'hermes-agent', 'venv', 'bin', 'python')
  if (has(venv)) return { cleanPythonPath: true, cmd: venv }
  return { cleanPythonPath: false, cmd: env.HERMES_PYTHON || 'python3' }
}

/** Countdown to an ISO reset instant: 16m, 2h 15m, 3d 5h, now, —. */
export function resetIn(iso, now = Date.now()) {
  const at = iso ? new Date(iso).getTime() : NaN
  if (!Number.isFinite(at)) return '—'
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

export function formatQuota(data, providerId, now = Date.now()) {
  const name = providers[providerId] || providerId || 'Unknown provider'
  const accounts = data.providers?.find(row => row.id === providerId)?.accounts || []
  if (!accounts.length) return `${name} · not configured`
  // Probe pct means USED. Display REMAINING explicitly; missing is never 0%.
  const valid = [...new Map(accounts.map(row => [row.acct || row.fp, row])).values()]
    .filter(row => !row.error && Array.isArray(row.windows) && row.windows.length)
  if (!valid.length) return `${name} · no quota window`
  // Highest used pct across accounts is the binding window; its reset is when
  // the shown remaining quota comes back.
  const windowAt = label => valid.flatMap(row => row.windows.filter(w => label.test(w.k)))
    .filter(w => Number.isFinite(Number(w.pct)))
    .reduce((a, b) => (!a || Number(b.pct) > Number(a.pct) ? b : a), null)
  const remaining = label => {
    const w = windowAt(label)
    return w ? `${Math.max(0, Math.min(100, 100 - Number(w.pct))).toFixed(0)}%` : '—'
  }
  const reset = label => resetIn(windowAt(label)?.reset, now)
  const first = `${name} · 5h ${remaining(/5h|session/i)} left · reset ${reset(/5h|session/i)}`
  // Claude reports per-model weekly caps beside the all-models one; the
  // all-models window ("weekly") is the headline, the rest fall back.
  const week = windowAt(/^week(ly)?$/i) ? /^week(ly)?$/i : /week/i
  const second = `week ${remaining(week)} left · reset ${reset(week)}`
  // Monthly is optional: providers that publish it (CommandCode's $ credit
  // budget, OpenCode Go's monthly window) get a third segment. Three segments
  // overrun a narrow dock, and the tail is what gets truncated — which is the
  // segment being asked for — so the monthly case WRAPS onto a second line.
  // Two-window providers (Codex) keep the single line.
  if (!windowAt(/month/i)) {
    return `${first} · ${second}`
  }
  return `${first}\n${second} · month ${remaining(/month/i)} left · reset ${reset(/month/i)}`
}

/** The widget paints one Text per line: a wrapped month stays visible in a
 *  narrow dock instead of being truncated off the end of one long line. */
export function quotaLines(text) {
  return String(text ?? '').split('\n')
}

/** Rejects with a short reason that is safe to put on the status line. */
export function probeQuota(providerId, env = process.env) {
  const { cleanPythonPath, cmd } = interpreterFor(env)
  const childEnv = { ...env, HERMES_HOME: env.HERMES_HOME || home }
  if (cleanPythonPath) delete childEnv.PYTHONPATH
  return new Promise((resolve, reject) => {
    execFile(cmd, [probe, '--provider', providerId], { timeout: 45_000, maxBuffer: 1024 * 1024, env: childEnv },
      (error, stdout, stderr) => {
        if (error) {
          const reason = error.killed ? 'probe timeout'
            : /ENOENT/.test(String(error.message)) ? 'python not found'
              : /ModuleNotFoundError/.test(String(stderr)) ? 'probe missing deps'
                : 'probe failed'
          return reject(new Error(reason))
        }
        const line = stdout.split('\n').find(x => x.startsWith('@@QUOTA@@ '))
        if (!line) return reject(new Error('probe returned no data'))
        try { resolve(JSON.parse(line.slice('@@QUOTA@@ '.length))) }
        catch { reject(new Error('probe returned bad data')) }
      })
  })
}

export default function register(sdk) {
  const { Box, defineWidgetApp, h, Text, React } = sdk
  let app
  function Body({ state, t }) {
    // Provider awareness comes from the TUI SDK hook (session.info.provider),
    // never from the configured default or a model-name guess.
    const hasProviderHook = typeof sdk.useSessionProvider === 'function'
    const sessionProvider = hasProviderHook ? sdk.useSessionProvider() : null
    const providerId = probeIdFor(sessionProvider)
    React.useEffect(() => {
      if (!providerId) return
      let alive = true
      const name = providers[providerId]
      const refresh = () => {
        probeQuota(providerId).then(data => {
          if (alive) sdk.updateWidget(app, s => ({ ...s, provider: providerId, text: formatQuota(data, providerId) }))
        }, error => {
          if (alive) sdk.updateWidget(app, s => ({ ...s, provider: providerId, text: `${name} · ${error.message}` }))
        })
      }
      refresh()
      const timer = setInterval(refresh, intervalMs)
      return () => { alive = false; clearInterval(timer) }
    }, [providerId])
    const text = !hasProviderHook ? 'Quota · needs Hermes SDK hook'
      : !sessionProvider ? 'Quota · provider unavailable'
        : !providerId ? `${sessionProvider} · quota unsupported`
          : state.provider === providerId ? state.text : `${providers[providerId]} · loading…`
    // One Text per line: the dock is an in-flow flex row, so a second Text in
    // a column Box reserves a real second row instead of being cut off.
    return h(Box, { flexDirection: 'column' }, quotaLines(text).map((line, index) =>
      h(Text, { key: index, color: t.color.muted, wrap: 'truncate-end' }, line)))
  }
  app = defineWidgetApp({
    id: 'quota', help: 'toggle quota for the active provider',
    mode: 'ambient', zone: 'dock-top',
    init: () => ({ provider: null, text: '' }),
    reduce: state => state,
    render: ({ state, t }) => h(Body, { state, t })
  })
  // Auto-dock on TUI launch, once per process. register() re-runs on EVERY
  // widget-dir rescan (any .mjs save, /widgets-reload), so a plain
  // sdk.openWidget(...) would re-dock the card after a /quota close and the
  // off state could not survive a reload. The globalThis flag keeps the
  // launch dock while a close lasts for the rest of the session; the next
  // TUI launch auto-docks again. /quota stays the manual toggle.
  if (!globalThis.__hermesQuotaWidgetAutoOpened) {
    sdk.openWidget(app, app.init(''))
    globalThis.__hermesQuotaWidgetAutoOpened = true
  }
}
