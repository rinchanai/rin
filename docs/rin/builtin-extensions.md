# Builtin Extensions

This document describes the extra capabilities Rin gives the agent.

## Default extra capabilities

- `discover_attention_resources`
  - provides the `discover_attention_resources` tool
  - helps the agent find ancestor `AGENTS.md` / `CLAUDE.md` files and `.agents/skills`
- `web-search`
  - provides live web search
- `memory`
  - provides Rin memory tools and memory-related prompt support
- `reset-system-prompt`
  - adds Rin's default stance and chat style prefix to the agent
- `message-header`
  - adds message metadata such as `sent at`; adds chat-specific context in Koishi bridge scenarios
- `rin-project-docs`
  - adds stable Rin doc paths and stable upstream pi doc paths to the system prompt
- `freeze-session-runtime`
  - keeps the effective system prompt stable within a session
- `tui-input-compat`
  - smooths over some TUI input compatibility issues
- `subagent`
  - provides subagent support
- `cron`
  - provides scheduled task support
- `koishi-send-message`
  - provides sending to an explicit Koishi `chatKey`

## Usage note

These capabilities are part of normal Rin behavior.
