# GUI shell

Rin includes a native Windows GUI shell backed by the same daemon RPC frontend as the TUI. The earlier browser-hosted shell remains available only as an explicit web fallback.

## Launch

```bash
rin gui
rin gui --native
rin gui --web
```

The command starts the target user's Rin daemon when needed. On Windows, `rin gui` opens a native WPF desktop window with a status bar, conversation area, prompt input, Send, and Abort controls; it talks to the daemon through a local JSON bridge and does not host the UI in a browser. Linux and macOS keep the existing TUI default while still allowing the explicit web fallback for development.

Useful options:

- `--native`: request the native Windows GUI surface
- `--web`: request the browser-hosted fallback surface
- `--host <host>`: web fallback bind address, default `127.0.0.1`
- `--port <port>`: web fallback bind port, default `0` for an ephemeral local port
- `--no-open`: web fallback only; print the URL without opening a browser
- `--app`: web fallback only; open the local GUI in a browser app window when the platform supports it

On Windows, the default `rin` launch path is GUI-first and uses the native surface; Linux and macOS keep the existing TUI default.

## GUI installer shell

```bash
rin-install --gui
```

On Windows, interactive `rin-install` enters the GUI-first installer path by default unless `--tui` or `--no-gui` is passed. The current installer surface owns language, target user, install directory, provider/model/thinking-level selection from the local model registry, default-target choice, safety boundary, provider API-key auth saving, and install plan preview. When the selected provider already has stored auth and no terminal privilege prompt is required, it applies the installation directly through the existing child apply-plan boundary. If cross-user or protected-directory writes need terminal confirmation, the installer writes a private apply-plan file and shows a one-line terminal handoff command instead of embedding credentials in the UI. Update mode and non-interactive child install paths stay non-GUI so release updates keep their existing automation boundary.

## Scope

The installer also writes direct `rin-gui` launchers and, on finalized Windows installs, a user-scoped Start Menu/Desktop `Rin GUI.cmd` native GUI launcher plus a Startup launcher for the daemon. That gives Windows a GUI-first installed entry, daemon autostart, and terminal handoff without requiring a machine-wide service install. OAuth/browser-login orchestration can still be layered on this shared frontend boundary.
