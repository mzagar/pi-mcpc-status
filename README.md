# pi-mcpc-status

A [Pi](https://pi.dev) package that keeps a compact [mcpc](https://github.com/apify/mcpc) connection-health indicator in Pi's status area and provides an interactive connection panel.

```
mcpc 6● 1○
```

Use `/mcpc` to open the panel. It refreshes status every 15 seconds and supports:

- `r` — restart/reconnect the selected session (`mcpc restart @session --json`)
- `a` — re-authenticate an HTTP/OAuth session, then restart it
- `R` — restart/reconnect every session (with confirmation)
- `x` — close and remove the selected session (with confirmation; preserves its OAuth profile)
- `X` — remove all `mcpc` sessions, OAuth profiles, and bridge logs (with confirmation)
- `f` — refresh status immediately
- `↑`/`↓` (or `j`/`k`) — select a session
- `Esc` — close the panel

`a` is only offered for remote URL sessions. Local stdio sessions (for example `npx …`) do not have an OAuth flow.

## Requirements

- [Pi](https://pi.dev)
- [Apify mcpc CLI](https://github.com/apify/mcpc) on `PATH`

## Installation

Install the published package globally for your Pi profile:

```sh
pi install git:github.com/mzagar/pi-mcpc-status@v0.1.1
```

To install it only in the current project, run this from the project's root directory:

```sh
pi install -l git:github.com/mzagar/pi-mcpc-status@v0.1.1
```

Alternatively, install a local checkout globally or for the current project:

```sh
pi install /absolute/path/to/pi-mcpc-status
pi install -l /absolute/path/to/pi-mcpc-status
```

Restart Pi, then run `/mcpc` to open the connection panel. Project-local packages require the project to be trusted. When developing from a local checkout, use `/reload` to apply extension changes.

## Notes

The indicator obtains data from `mcpc --json`; it never parses the human-readable CLI output. Re-authentication invokes the standard interactive command:

```sh
mcpc login <server-url> --profile <profile>
```

It opens a browser and waits for the OAuth callback, then restarts the selected session.

> **Warning:** `X` runs `mcpc clean all --json`. This removes every saved `mcpc` session, OAuth profile, and bridge log, so the next connection will require a new login. `x` runs `mcpc close @session --json` only for the selected session and preserves its OAuth profile.

## Development

Try the extension without installing it:

```sh
pi -e ./extensions/mcpc-status.ts
```

There are no runtime npm dependencies. Pi supplies the declared peer dependencies.
