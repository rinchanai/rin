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

When `rin` is confirmed missing on the current account, treat that as a cross-user setup clue.

In that case, do not keep reasoning about the current account's launcher metadata.
Instead, jump straight to the target install manifest workflow:

1. find `installDir` for the real target install:
   - inspect managed service files for `RIN_DIR`
   - Linux: `~/.config/systemd/user/rin-daemon*.service`
   - macOS: `~/Library/LaunchAgents/com.rin.daemon.*.plist`
   - if you already know the target home, also probe the common default `<targetHome>/.rin/`
2. open the target install manifest:
   - `<installDir>/installer.json`
   - this file records `targetUser` and `installDir`
3. invoke the stable runtime entry directly:
   - `node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>`

In short: no `rin` on the current account usually means “wrong user for the launcher”, so the recovery path is service file → target install dir → `installer.json` → `app/current/.../main.js update`.

Important implications:

- interpret “current account has no `rin` command” as a launcher-placement clue rather than as evidence that Rin cannot self-update
- the current local account may be only the execution account; the launcher may belong to a different interactive account, and that is a normal setup
- reason in terms of installed runtime path, target user, launcher ownership, and permissions
- prefer the stable `app/current/` path over release-specific timestamps when invoking an installed runtime directly
- keep `rin update` as the canonical workflow for updating an installed Rin runtime
- treat `install.sh` as installation/bootstrap rather than the normal update path
- keep repo-checkout maintenance and installed-runtime maintenance as separate workflows; updating a repo checkout is not the same thing as updating the installed Rin runtime under `~/.rin/...`

## Memory and self-improve

Rin separates session history memory from self-improvement state. As an agent, you should know that:

- `search_memory` is for archived session history recall
- memory recall summarizes matched sessions with the active model at fixed `low` thinking
- always-on baselines live under `~/.rin/self_improve/prompts`
- agent-managed skills live under `~/.rin/self_improve/skills`
- not all self-improve content is injected into the prompt automatically
- before saving a new self-improve prompt, search first and avoid creating duplicates when possible
- reusable procedures, checklists, and operating playbooks belong in skills rather than prompts

## Scheduled tasks

Rin provides scheduled task support. As an agent, you should know that:

- you can create one-time, interval, and cron-style tasks
- it is suitable for reminders, periodic checks, delayed follow-ups, and background automation
- when a task should stop running without being removed, pause it; when it should be removed entirely, delete it

## Chat bridge

Rin can bridge chat platforms through a framework-neutral chat bridge layer. The direct built-in runtime currently includes Telegram, OneBot, QQ, Feishu / Lark, Discord, Slack, and Minecraft / QueQiao. As an agent, you should know that:

- the sender in a chat bridge conversation is not the local shell user; it is the chat-platform sender
- the prompt may include `chatKey`, chat name, sender identity, and related context
- in chat bridge conversations, avoid Markdown in replies
- `chat_bridge` is the live bridge tool for advanced chat-platform operations
- read `~/.rin/docs/rin/docs/chat-bridge.md` for runtime objects, examples, and adapter notes
- `/chat` is the TUI command for configuring the built-in official adapters
- `/chat` goes directly into platform selection in the TUI; the installer keeps the separate yes/no gate
- official adapter setup should prefer the minimum runnable fields, default to polling / socket modes when the adapter supports them, avoid webhook-only setup when possible, and include direct official links for required values

### Custom chat bridge adapters

The product-facing name is chat bridge. The internal runtime config key currently remains `settings.json -> koishi` for compatibility.

If a user wants a custom chat bridge adapter that Rin does not ship as a built-in guided option, use the internal config shape below:

```json
{
  "koishi": {
    "customAdapters": [
      {
        "packageName": "koishi-plugin-adapter-example",
        "version": "latest",
        "pluginKey": "adapter-example",
        "config": {
          "token": "..."
        }
      }
    ]
  }
}
```

Notes for the agent:

- `packageName` is the npm package name
- `version` is optional and defaults to `latest`
- `pluginKey` is the internal adapter key for that package
- `config` can be a single config object, an array of named instances, or a keyed object map just like other adapter config blocks
- after editing `settings.json`, restart Rin or let the chat bridge sidecar restart; Rin will materialize the custom runtime package and install any missing custom adapter dependencies automatically before loading the bridge config
- treat custom adapters as trusted-code execution because they run as third-party Node.js code under the Rin user account

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

## Token usage telemetry

Rin records detailed token telemetry for runtime events and assistant usage.

As an agent, you should know that:

- telemetry is stored under `~/.rin/data/token-usage/usage.db`
- it tracks session, event, model, source, tool, and capability metadata alongside token counts
- `rin usage` shows a simple text dashboard and supports grouped queries over the recorded dimensions

## Stable documentation paths

Rin installs docs into stable locations:

- `~/.rin/docs/rin/`: Rin-specific user docs
- `~/.rin/docs/pi/`: installed copies of upstream pi docs

Prefer these stable paths over specific `app/releases/<timestamp>/...` paths.
