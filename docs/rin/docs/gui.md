# GUI shell

Rin includes a cross-platform browser-hosted GUI shell as the first reusable GUI surface.

## Launch

```bash
rin gui
rin gui --app
```

The command starts the target user's Rin daemon when needed, serves a local web UI, and opens the default browser. `--app` asks the platform browser to use an app-style window, which is what installed desktop shortcuts use. The UI talks to the same daemon RPC frontend used by the TUI, so it is a frontend surface rather than a separate runtime.

Useful options:

- `--host <host>`: bind address, default `127.0.0.1`
- `--port <port>`: bind port, default `0` for an ephemeral local port
- `--no-open`: print the URL without opening a browser
- `--app`: open the local GUI in a browser app window when the platform supports it

On Windows, the default `rin` launch path is GUI-first; Linux and macOS keep the existing TUI default while still allowing `rin gui`.

## GUI installer shell

```bash
rin-install --gui
```

On Windows, interactive `rin-install` starts the browser-hosted installer shell by default unless `--tui` or `--no-gui` is passed. The GUI installer owns language, target user, install directory, provider/model/thinking-level selection from the local model registry, default-target choice, safety boundary, provider API-key auth saving, and install plan preview. When the selected provider already has stored auth and no terminal privilege prompt is required, the browser applies the installation directly through the existing child apply-plan boundary. If cross-user or protected-directory writes need terminal confirmation, the GUI writes a private apply-plan file and shows a one-line terminal handoff command instead of embedding credentials in the page. Update mode and non-interactive child install paths stay non-GUI so release updates keep their existing automation boundary.

## Scope

The installer also writes direct `rin-gui` launchers and, on finalized Windows installs, a user-scoped Start Menu/Desktop `Rin GUI.cmd` app-window launcher plus a Startup launcher for the daemon. That gives Windows a GUI-first installed entry, daemon autostart, and terminal handoff without requiring a machine-wide service install. OAuth/browser-login orchestration can still be layered on this shared frontend boundary.
