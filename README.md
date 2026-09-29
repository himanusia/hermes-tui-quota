# Hermes TUI Quota

A single plain-text line in the Hermes TUI showing how much quota is **left** on the provider the current chat actually runs on.

```
Codex · 5h 9% left · week 37% left
```

No border, no panel — it sits in the composer dock directly above the `Ready · model` rule, which sits above the input.

## How it reads the provider

Provider awareness comes from the live session (`session.info.provider`), never from the configured default model and never from a guess based on the model name. Switching model or session re-targets the line.

That fact is not reachable from a user widget in stock Hermes, so this widget needs one SDK hook:

```ts
// ui-tui/src/sdk/userWidgets.ts — add to widgetSdk
useSessionProvider: () => useStore($uiState).info?.provider ?? null,
```

Without it the widget renders `Quota · needs Hermes SDK hook` instead of a wrong number.

`patches/` carries the two Hermes-side changes as commit patches. Apply them in a Hermes checkout, then rebuild:

```
git am patches/*.patch
cd ui-tui && npm run build
```

- `0001` — the SDK hook, with its test.
- `0002` — `dock-top` renders **above** the `Ready · model` rule instead of below it. Without it the line lands between the rule and the prompt, under the header it is supposed to accompany.

These travel as patch files rather than a branch because a Hermes fork here has a truncated history — pushing the 38k-commit ancestry is not viable, while a handful of lines is.

## How it reads the quota

It shells out to the read-only probe shipped with the [Hermes Provider Quota Dashboard](https://github.com/himanusia/hermes-provider-quota-dashboard) — the same file the desktop pane uses. This repository holds no credentials; the probe reads the local credential pool itself and prints one JSON line.

The probe's `pct` is **used**, not remaining. This widget displays `100 - pct` and says `left`, so the number means what it looks like. Missing windows stay `—` and are never turned into a fake `0%`.

## Install

1. Copy `quota.mjs` to `~/.hermes/tui-widgets/quota.mjs`.
2. Apply the two patches below to your Hermes checkout and rebuild the TUI (`npm run build` in `ui-tui`), then restart the TUI.
3. `/quota` toggles the line. It is not auto-opened, so it stays off until you ask for it.
4. `/widgets-reload` picks up edits to the widget file without a restart.

Requires `probe.py` at `~/.hermes/desktop-plugins/quota-dash/probe.py`; override the path with `HERMES_QUOTA_PROBE`.

### Interpreter

The probe imports `httpx`, and picking the wrong interpreter looks like a quota problem rather than a dependency one. In the TUI, Hermes exports `HERMES_PYTHON` as its bare tool interpreter — one that only has `httpx` through the inherited `PYTHONPATH`. Preferring that variable *and* clearing `PYTHONPATH` (to stop the global value shadowing the venv) leaves no `httpx` at all, and the probe exits 1.

So the order is:

1. `HERMES_QUOTA_PYTHON` if set — used as-is, `PYTHONPATH` left alone.
2. `$HERMES_HOME/hermes-agent/venv/bin/python` if it exists — run with `PYTHONPATH` cleared, since the venv carries its own `httpx`.
3. `HERMES_PYTHON`, else `python3` — `PYTHONPATH` left alone, because that is the only thing giving it dependencies.

As a last resort set `HERMES_QUOTA_PYTHON` to an interpreter that has `httpx`.

## Refresh

Re-probes every 60 seconds while the line is open, and immediately when the provider changes. The probe runs with `PYTHONPATH` cleared, since the global value shadows the Hermes venv.

A probe that fails says why, in one short word, instead of hiding behind a generic label: `probe failed`, `probe timeout`, `probe returned no data`, `probe missing deps`, `python not found`. `no quota window` and `not configured` are real answers from the probe, not failures.

## Test

```
node --test test/widget.test.mjs
```

Covers the used→remaining inversion, clamping, pooled accounts taking the most constrained value, and the not-configured/unavailable/unknown-provider labels.

## Limits

- Codex, OpenCode Go, and CommandCode only — an unknown provider id renders `<id> · quota unsupported` rather than an invented figure.
- The probe reads the local credential pool, so a provider you are not authenticated against reads as `not configured`.
