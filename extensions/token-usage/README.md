# Token Usage Telemetry

Builtin Rin extension for detailed token telemetry.

It records runtime events into `~/.rin/data/token-usage/usage.db`, including:

- session lifecycle events
- input / agent / turn / tool events
- assistant message usage with provider, model, thinking level, tool-call metadata, and token breakdown

The `rin usage` command reads this database and renders a simple text dashboard or custom aggregate tables.
