# Rin Agent Docs

These documents are the primary agent-facing documentation for Rin.

## Priority

Rin docs sit above upstream pi docs for Rin-operated behavior.

- read Rin docs first when they are relevant
- use upstream pi docs as the base reference only when Rin docs do not cover the topic
- if Rin docs and pi docs conflict, Rin docs take precedence

## Structure

- `README.md`: main entry for Rin agent documentation
- `docs/`: topic docs and override guides for Rin

## Start here

- `docs/pi-overrides.md`: how to interpret upstream pi docs inside Rin, including where Rin changes the meaning

## Topic entrypoints

- `docs/runtime-layout.md`: runtime layout, stable paths, launcher ownership, and which paths are safe to reference
- `docs/builtin-extensions.md`: builtin capabilities and default extra capabilities provided by Rin core
- `docs/capabilities.md`: compact agent-facing behavior and conventions for Rin features
- `docs/release-trains.md`: stable, beta, git release-channel rules and bootstrap branch flow
- `docs/releasing.md`: operator workflow for beta and stable releases
- `docs/first-stable-release-checklist.md`: first public stable npm release readiness and verification checklist

## Reading order

1. start with `README.md`
2. read `docs/pi-overrides.md` before relying on upstream pi docs
3. read the relevant topic entrypoint in `docs/`
4. consult upstream pi docs only as needed

## Notes

- These docs are installed into the agent working directory, typically `~/.rin/docs/rin/`
- Prefer the stable installed docs under `~/.rin/docs/rin/` and `~/.rin/docs/pi/`
