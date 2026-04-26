# GUI shell

Rin includes a cross-platform browser-hosted GUI shell as the first reusable GUI surface.

## Launch

```bash
rin gui
```

The command starts the target user's Rin daemon when needed, serves a local web UI, and opens the default browser. The UI talks to the same daemon RPC frontend used by the TUI, so it is a frontend surface rather than a separate runtime.

Useful options:

- `--host <host>`: bind address, default `127.0.0.1`
- `--port <port>`: bind port, default `0` for an ephemeral local port
- `--no-open`: print the URL without opening a browser

On Windows, the default `rin` launch path is GUI-first; Linux and macOS keep the existing TUI default while still allowing `rin gui`.

## GUI installer shell

```bash
rin-install --gui
```

On Windows, interactive `rin-install` starts the browser-hosted installer shell by default unless `--tui` or `--no-gui` is passed. The GUI installer currently owns the first planning surface: language, target user, install directory, provider/model/thinking-level selection from the local model registry, default-target choice, safety boundary, and install plan preview. When the selected provider already has stored auth and the target does not require a terminal privilege prompt, the browser can apply the installation directly through the existing child apply-plan boundary. Update mode and non-interactive child install paths stay non-GUI so release updates keep their existing automation boundary.

## Scope

This is the minimal GUI host/runtime and installer-planning/apply substrate for issue #85. It does not replace the provider-auth login flow, terminal privilege prompts for cross-user writes, target-user Windows service parity, or packaged desktop shell yet; those build on top of this shared frontend boundary.
