# GUI shell

Rin's user-facing `rin gui` shell is a native desktop surface, not a browser-hosted page. The Rin runtime side owns one reusable native desktop host contract: start the target user's daemon, launch a single desktop host over stdio, then bridge UI commands and daemon events as JSON lines.

The desktop host is intentionally one replaceable implementation boundary, not separate platform-specific UI implementations in core Rin. Core Rin should not keep browser fallback routes or compatibility flags for rejected GUI experiments.

## Launch

```bash
rin gui
```

`rin gui` starts the target user's Rin daemon when needed and launches the native desktop host command. The default host command is `rin-desktop-host --stdio`; advanced packaging or local development can point `RIN_GUI_NATIVE_HOST` at another compatible host command while preserving the same stdio JSON protocol.

No browser fallback is exposed. Browser-style switches such as `--web`, `--host`, `--port`, `--open`, `--no-open`, and `--app` are rejected. The former `--native` compatibility spelling is also rejected instead of being kept as a no-op before that interface has shipped.

On Windows, the default `rin` launch path is GUI-first and enters `rin gui`. Linux and macOS keep the existing TUI default, while still allowing explicit `rin gui` once a native desktop host is installed.

## GUI installer shell

```bash
rin-install --gui
```

On Windows, interactive `rin-install` enters the GUI-first installer path by default unless `--tui` or `--no-gui` is passed. The current installer path owns language, target user, install directory, provider/model/thinking-level selection from the local model registry, default-target choice, safety boundary, provider API-key auth saving, and install plan preview. When the selected provider already has stored auth and no terminal privilege prompt is required, it applies the installation directly through the existing child apply-plan boundary. If cross-user or protected-directory writes need terminal confirmation, the installer writes a private apply-plan file and shows a one-line terminal handoff command instead of embedding credentials in UI text. Update mode and non-interactive child install paths stay non-GUI so release updates keep their existing automation boundary.

The installer surface remains part of the draft GUI-first delivery line until its user-facing window is moved onto the same native desktop host contract as `rin gui`.

## Scope

The installer writes direct `rin-gui` launchers and, on finalized Windows installs, a user-scoped Start Menu/Desktop `Rin GUI.cmd` launcher plus a Startup launcher for the daemon. That gives Windows a GUI-first installed entry, daemon autostart, and terminal handoff without requiring a machine-wide service install.
