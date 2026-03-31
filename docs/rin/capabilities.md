# Agent-facing Capabilities

This document summarizes only the capabilities and conventions an agent needs as a Rin user.

## Run modes

- `rin` normally prefers daemon + RPC TUI mode
- `rin --std` uses the standard foreground TUI and does not depend on the RPC daemon
- if the daemon goes offline temporarily, Rin tries to resume the interrupted session when it returns

## Memory

Rin provides its own memory system. As an agent, you should know that:

- it has multiple layers such as resident, progressive, and recall memory
- not all memory is injected into the prompt automatically
- when you need historical memory, prefer using the memory tool instead of assuming the content is already in context
- before saving a new memory, search first and avoid creating duplicates when possible

## Scheduled tasks

Rin provides scheduled task support. As an agent, you should know that:

- you can create one-time, interval, and cron-style tasks
- it is suitable for reminders, periodic checks, delayed follow-ups, and background automation
- when a task is permanently finished, mark it complete so it does not linger forever

## Koishi bridge

Rin can bridge chat platforms through Koishi. As an agent, you should know that:

- the sender in a Koishi bridge chat is not the local shell user; it is the chat-platform sender
- the prompt may include `chatKey`, chat name, sender identity, and related context
- in Koishi bridge chats, avoid Markdown in replies
- `koishi_send_message` should only be used when the user explicitly asks to send something to a specific `chatKey`

## Web search

Rin provides live web search. As an agent, you should know that:

- for latest, time-sensitive, version-sensitive, or potentially changed information, you should search proactively
- do not rely only on stale memory for those questions

## Attention resources

Rin provides the `discover_attention_resources` tool. As an agent, you should know that:

- it can discover ancestor `AGENTS.md` / `CLAUDE.md` files
- it can also discover `.agents/skills/*/SKILL.md`
- when you need project-specific rules, this is often one of the best first entrypoints

## Stable documentation paths

Rin installs docs into stable locations:

- `~/.rin/docs/rin/`: Rin-specific user docs
- `~/.rin/docs/pi/`: installed copies of upstream pi docs

Prefer these stable paths over specific `app/releases/<timestamp>/...` paths.
