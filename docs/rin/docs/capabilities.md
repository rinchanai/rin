# Agent-facing Capabilities

This document summarizes only the capabilities and conventions an agent needs as a Rin user.

## Run modes

- `rin` normally prefers daemon + RPC TUI mode
- if the daemon goes offline temporarily, Rin tries to resume the interrupted session when it returns
- keep `rin` as the normal recommendation in guidance
- mention `rin --std` mainly when RPC mode is failing and the user needs a foreground fallback for troubleshooting or repair

## Self-update behavior

Rin can update itself even when the current local account does not have a `rin` launcher.

As an agent, prefer this decision order when the user asks you to upgrade Rin:

1. try `rin update`
2. if `rin` is missing, try `~/.local/bin/rin update`
3. if no launcher exists for the current account, try the installed runtime entry directly:
   - `node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>`
4. if `installDir` or `targetUser` is unknown, discover them first from Rin install metadata or managed service files

Important implications:

- interpret “current account has no `rin` command” as a launcher-placement clue rather than as evidence that Rin cannot self-update
- the current local account may be only the execution account; the launcher may belong to a different interactive account, and that is a normal setup
- reason in terms of installed runtime path, target user, launcher ownership, and permissions
- prefer the stable `app/current/` path over release-specific timestamps when invoking an installed runtime directly
- keep `rin update` as the canonical workflow for updating an installed Rin runtime
- treat `install.sh` as installation/bootstrap rather than the normal update path
- keep repo-checkout maintenance and installed-runtime maintenance as separate workflows; updating a repo checkout is not the same thing as updating the installed Rin runtime under `~/.rin/...`

## Memory

Rin provides its own memory system. As an agent, you should know that:

- it has `memory_prompts` for short always-on baselines and `memory_docs` for searchable detailed guidance
- not all memory is injected into the prompt automatically
- when you need historical memory, prefer using the memory tool instead of assuming the content is already in context
- before saving a new memory, search first and avoid creating duplicates when possible

## Scheduled tasks

Rin provides scheduled task support. As an agent, you should know that:

- you can create one-time, interval, and cron-style tasks
- it is suitable for reminders, periodic checks, delayed follow-ups, and background automation
- when a task should stop running without being removed, pause it; when it should be removed entirely, delete it

## Koishi bridge

Rin can bridge chat platforms through Koishi. As an agent, you should know that:

- the sender in a Koishi bridge chat is not the local shell user; it is the chat-platform sender
- the prompt may include `chatKey`, chat name, sender identity, and related context
- in Koishi bridge chats, avoid Markdown in replies
- `send_chat_msg` should only be used when the user explicitly asks to send something to a specific `chatKey`

## Web search

Rin provides live web search. As an agent, you should know that:

- for latest, time-sensitive, version-sensitive, or potentially changed information, you should search proactively
- use fresh search results as the primary source for those questions, with memory as supporting context

## Direct URL fetch

Rin provides a `fetch` tool. As an agent, you should know that:

- use it when the user already gave you a specific URL and wants it read directly
- prefer it over `web_search` when discovery is not needed
- it returns readable text content rather than downloading files

## Attention resources

Rin provides the `rules` tool. As an agent, you should know that:

- it can discover ancestor `AGENTS.md` / `CLAUDE.md` files
- it can also discover `.agents/skills/*/SKILL.md`
- when you need project-specific rules, this is often one of the best first entrypoints

## Stable documentation paths

Rin installs docs into stable locations:

- `~/.rin/docs/rin/`: Rin-specific user docs
- `~/.rin/docs/pi/`: installed copies of upstream pi docs

Prefer these stable paths over specific `app/releases/<timestamp>/...` paths.
