# GUI shell

Rin's user-facing `rin gui` shell is a native desktop surface, not a browser-hosted page. It uses the same daemon RPC frontend boundary as the TUI so the agent runtime, session ownership, abort handling, and daemon recovery stay shared across frontends.

## Launch

```bash
rin gui
rin gui --native
```

The command starts the target user's Rin daemon when needed, connects a native desktop host to the daemon, and then bridges UI commands and daemon events over local JSON lines. There is no browser fallback for this command.

Current native desktop hosts:

- Windows: PowerShell/WPF window with status, conversation, prompt input, Send, and Abort controls.
- macOS: Cocoa window launched through the system `osascript` JavaScript bridge.
- Linux: Tk desktop window launched through the system Python/Tk bridge.

`--native` is accepted as an explicit no-op for scripts that want to state the intended surface. Browser-style switches such as `--web`, `--host`, `--port`, `--open`, `--no-open`, and `--app` are rejected so a rejected browser-hosted GUI cannot silently remain as the product fallback.

On Windows, the default `rin` launch path is GUI-first and uses the native desktop surface. Linux and macOS keep the existing TUI default, while still allowing explicit `rin gui` for the native desktop shell.

## GUI installer shell

```bash
rin-install --gui
```

On Windows, interactive `rin-install` enters the GUI-first installer path by default unless `--tui` or `--no-gui` is passed. The current installer path owns language, target user, install directory, provider/model/thinking-level selection from the local model registry, default-target choice, safety boundary, provider API-key auth saving, and install plan preview. When the selected provider already has stored auth and no terminal privilege prompt is required, it applies the installation directly through the existing child apply-plan boundary. If cross-user or protected-directory writes need terminal confirmation, the installer writes a private apply-plan file and shows a one-line terminal handoff command instead of embedding credentials in UI text. Update mode and non-interactive child install paths stay non-GUI so release updates keep their existing automation boundary.

The installer surface remains part of the draft GUI-first delivery line until its user-facing window is moved onto the same native desktop host contract as `rin gui`.

## Scope

The installer writes direct `rin-gui` launchers and, on finalized Windows installs, a user-scoped Start Menu/Desktop `Rin GUI.cmd` launcher plus a Startup launcher for the daemon. That gives Windows a GUI-first installed entry, daemon autostart, and terminal handoff without requiring a machine-wide service install.
