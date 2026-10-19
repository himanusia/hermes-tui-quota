import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.HERMES_HOME || join(homedir(), '.hermes')
const probe = process.env.HERMES_QUOTA_PROBE || join(home, 'desktop-plugins', 'quota-dash', 'probe.py')
const providers = {
  'openai-codex': 'Codex',
  'opencode-go': 'OpenCode Go',
  commandcode: 'CommandCode',
  opendesign: 'Open Design',
  'claude-subscription': 'Claude',
  // Hermes' built-in Anthropic provider (provider id `anthropic`). It resolves
  // the same Claude Code login the DirectSDK plugin drives, but under its own
  // credential path, so it is metered by the probe's on-demand `anthropic` entry.
  anthropic: 'Anthropic',
  'antigravity-subscription': 'Antigravity'
}
// Session provider id (session.info.provider) → probe provider id. The Claude
// subscription plugins drive Claude Code's own OAuth login, which the probe
// meters as `claude-subscription`.
const aliases = {
  'claude-subscription-directsdk-experimental': 'claude-subscription',
  'claude-subscription-directsdk': 'claude-subscription',
  'antigravity-subscription-directsdk': 'antigravity-subscription',
  // Hermes registers the provider as `open-design`; the probe meters it as `opendesign`.
  'open-design': 'opendesign'
}

/** The probe id that meters a session provider, or null when unsupported. */
export function probeIdFor(sessionProvider) {
  const id = aliases[sessionProvider] || sessionProvider
  return id && Object.hasOwn(providers, id) ? id : null
}

/**
 * base_url host → probe id, for providers reached through a CUSTOM entry.
 *
 * A user-defined provider is billed and logged as `custom` with the endpoint in
 * `billing_base_url`, so neither the provider id nor the model name can tell
 * Open Design apart from any other custom endpoint. The host can. Extend this
 * table when another metered provider is configured as a custom entry.
 */
const baseHosts = {
  'amr-link.open-design.ai': 'opendesign'
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase() } catch { return '' }
}

/** One read-only handle on state.db, opened on first use. `node:sqlite` ships
 *  with the TUI's Node; an older runtime just means no session awareness. */
let sessionDb = null

async function openStateDb() {
  if (sessionDb) return sessionDb
  if (!existsSync(join(home, 'state.db'))) return null
  try {
    const { DatabaseSync } = await import('node:sqlite')
    sessionDb = new DatabaseSync(join(home, 'state.db'), { readOnly: true })
    return sessionDb
  } catch {
    return null
  }
}

/**
 * The active session as this TUI knows it: `{ model, provider, baseHost }`.
 *
 * `sdk.useSessionProvider` is NOT in every TUI build — the shipping widgetSdk
 * exposes no session hook at all, so a widget cannot ask which provider it is
 * metering. What the TUI does publish is the active session id
 * (`HERMES_TUI_ACTIVE_SESSION_FILE`), and state.db carries that session's
 * billing identity. One indexed read-only row, so this stays cheap enough to
 * re-run on every refresh.
 */
export async function activeSession(env = process.env) {
  const file = env.HERMES_TUI_ACTIVE_SESSION_FILE
  if (!file || !existsSync(file)) return null
  let id
  try {
    id = JSON.parse(readFileSync(file, 'utf8')).session_id
  } catch {
    return null
  }
  if (!id) return null
  const db = await openStateDb()
  if (!db) return null
  try {
    const row = db
      .prepare('select model, billing_provider, billing_base_url from sessions where id = ?')
      .get(id)
    if (!row) return null
    return {
      model: String(row.model || ''),
      provider: String(row.billing_provider || ''),
      baseHost: hostOf(row.billing_base_url || '')
    }
  } catch {
    return null
  }
}

/** Which probe meters the active session, from either identity it carries. */
export function probeIdForSession(session) {
  if (!session) return null
  return baseHosts[session.baseHost] || probeIdFor(session.provider)
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
  const providerRow = data.providers?.find(row => row.id === providerId)
  const accounts = providerRow?.accounts || []
  if (!accounts.length) return `${name} · not configured`
  // A pool benches one (credential, model) pair at a time, so a provider can be
  // configured and healthy-looking yet serve NOTHING for the model it will be
  // called with. Report that instead of metering a credential the pool refuses.
  const pool = providerRow?.pool
  if (pool && pool.state === 'empty') {
    return pool.model ? `${name} · no credential for ${pool.model}` : `${name} · pool empty`
  }
  // Probe pct means USED. Display REMAINING explicitly; missing is never 0%.
  // Credentials resolving to the same account share one quota (Codex OAuth
  // rows do), so collapse them — but carry the live flag through the collapse,
  // or the dock would name and meter a backup instead of the active credential.
  const byAccount = new Map()
  const usable = row => !row.error && Array.isArray(row.windows) && row.windows.length > 0
  for (const row of accounts) {
    const key = row.acct || row.fp
    const kept = byAccount.get(key)
    if (!kept) {
      byAccount.set(key, { row, active: Boolean(row.is_active) })
      continue
    }
    kept.active = kept.active || Boolean(row.is_active)
    // Data comes from a row that actually has a reading; a sibling credential
    // sharing the account must not leave the meter blank when one row errored.
    if (!usable(kept.row) && usable(row)) {
      kept.row = row
    }
  }
  const valid = [...byAccount.values()]
    .filter(({ row }) => usable(row))
    .map(({ row, active }) => ({ ...row, is_active: active }))
  if (!valid.length) {
    // Say WHY instead of a bare "no quota window": a rate-limited or expired
    // login is actionable, an empty answer is not. The probe's message leads
    // with its status ("HTTP 429 - …"), so the short form is the part before " - ".
    const reason = accounts.map(row => row.error).find(Boolean)
    if (reason) return `${name} · ${String(reason).split(' - ')[0]}`
    // A provider can be unmetered yet configured: Open Design publishes no
    // usage endpoint, so its only readable fact is the probe's note. Report
    // that instead of "no quota window", which reads like a broken probe.
    const note = accounts.flatMap(row => row.notes || []).find(Boolean)
    return note ? `${name} · ${note}` : `${name} · no quota window`
  }
  // The dock is space-constrained, so it meters ONE account: the live one. The
  // probe flags it (`is_active`) and stamps each row with the pool's verdict, so
  // a benched credential can never be presented as the one in use. `active_account`
  // is the belt-and-braces hint and the first row is the last resort (older payloads).
  const servable = valid.filter(row => !row.verdict || row.verdict === 'available')
  const pickFrom = servable.length ? servable : valid
  const marked = pickFrom.find(row => row.is_active)
    || pickFrom.find(row => row.fp && row.fp === providerRow?.active_account?.fp)
    || pickFrom[0]
  const active = [marked]
  // Name the account only when the provider meters more than one distinct
  // account; a single account (even with several credentials) keeps the terse
  // line it always had.
  const acctTag = valid.length > 1 && marked.label ? ` [${marked.label}]` : ''
  // Highest used pct within the live account is the binding window; its reset
  // is when the shown remaining quota comes back.
  const windowAt = label => active.flatMap(row => row.windows.filter(w => label.test(w.k)))
    .filter(w => Number.isFinite(Number(w.pct)))
    .reduce((a, b) => (!a || Number(b.pct) > Number(a.pct) ? b : a), null)
  const remaining = label => {
    const w = windowAt(label)
    return w ? `${Math.max(0, Math.min(100, 100 - Number(w.pct))).toFixed(0)}%` : '—'
  }
  const reset = label => resetIn(windowAt(label)?.reset, now)
  // Grouped quota (Antigravity: Gemini, Claude/GPT): every group has its own
  // 5h + weekly limits, so each group gets its own line.
  const groups = [...new Set(active.flatMap(row => row.windows).map(w => w.group).filter(Boolean))]
  if (groups.length) {
    return groups.map((group, index) => {
      const at = re => active.flatMap(row => row.windows.filter(w => w.group === group && re.test(w.k)))
        .filter(w => Number.isFinite(Number(w.pct)))
        .reduce((x, y) => (!x || Number(y.pct) > Number(x.pct) ? y : x), null)
      const seg = (tag, re) => {
        const w = at(re)
        const left = w ? `${Math.max(0, Math.min(100, 100 - Number(w.pct))).toFixed(0)}%` : '—'
        return `${tag} ${left} left · reset ${resetIn(w?.reset, now)}`
      }
      const head = index === 0 ? `${name}${acctTag} · ${group}` : group
      return `${head} · ${seg('5h', /5h|session/i)} · ${seg('week', /week/i)}`
    }).join('\n')
  }
  const first = `${name}${acctTag} · 5h ${remaining(/5h|session/i)} left · reset ${reset(/5h|session/i)}`
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
    // Prefer the SDK hook when this build ships one; otherwise read the active
    // session's billing identity (see activeSession). Either way the dock meters
    // the provider THIS chat calls — never the configured default.
    const hasProviderHook = typeof sdk.useSessionProvider === 'function'
    const hookProvider = hasProviderHook ? sdk.useSessionProvider() : null
    const [session, setSession] = React.useState(null)
    React.useEffect(() => {
      if (hasProviderHook) return
      let alive = true
      const load = () => {
        activeSession().then(next => { if (alive) setSession(next) }, () => {})
      }
      load()
      const timer = setInterval(load, 20_000)
      return () => { alive = false; clearInterval(timer) }
    }, [hasProviderHook])
    const providerId = hasProviderHook ? probeIdFor(hookProvider) : probeIdForSession(session)
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
    const label = session ? session.baseHost || session.provider : ''
    const text = providerId ? (state.provider === providerId ? state.text : `${providers[providerId]} · loading…`)
      : hasProviderHook ? (hookProvider ? `${hookProvider} · quota unsupported` : 'Quota · provider unavailable')
        : session ? `${label} · quota unsupported`
          : 'Quota · resolving provider…'
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
