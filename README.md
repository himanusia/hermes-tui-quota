# Hermes TUI Quota

Standalone Hermes TUI widget for provider quota. Uses the installed read-only probe from [Hermes Provider Quota Dashboard](https://github.com/himanusia/hermes-provider-quota-dashboard); this repository does not contain provider credentials.

## Install

Copy `quota.mjs` into `~/.hermes/tui-widgets/quota.mjs`, then run `/widgets-reload` in the TUI. `/quota` toggles the widget. Requires the desktop Quota Dashboard's `probe.py` installed at `~/.hermes/desktop-plugins/quota-dash/probe.py`, or set `HERMES_QUOTA_PROBE` to its absolute path. Override the Python interpreter with `HERMES_PYTHON` if needed.

## Status

Initial backup of the experimental widget. The baseline displays several providers in a bordered overlay; a provider-aware plain-text status line is being developed separately. Do not treat this baseline as the final UI.
