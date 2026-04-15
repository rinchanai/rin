# Builtin Extensions

This document describes the extra capabilities Rin gives the agent.

## Default extra capabilities

- `rules`
  - provides the `rules` tool
  - helps the agent find ancestor `AGENTS.md` / `CLAUDE.md` files and `.agents/skills`
- `web-search`
  - provides live web search
- `fetch`
  - provides direct URL text fetching
- `memory`
  - provides `*_memory` tools and memory-related prompt support
- `reset-system-prompt`
  - adds Rin's default stance and chat style prefix to the agent
- `message-header`
  - adds message metadata such as `sent at`; adds chat-specific context in chat bridge scenarios
- `freeze-session-runtime`
  - keeps the effective system prompt stable within a session
- `tui-input-compat`
  - smooths over some TUI input compatibility issues
- `subagent`
  - provides `run_subagent` and `list_models`
- `task`
  - provides task management tools such as `list_tasks`, `save_task`, and `pause_task`
- `chat`
  - provides `send_chat_msg` and `get_chat_msg`
  - provides `/chat` for guided official adapter setup inside the TUI
- `token-usage`
  - records detailed token telemetry under `~/.rin/data/token-usage/usage.db`
  - powers the `rin usage` text dashboard and grouped usage queries

## Usage note

These capabilities are part of normal Rin behavior.
