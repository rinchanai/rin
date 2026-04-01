# message-header

Adds a per-message header before the user body.

Features:

- always generates a hidden per-turn header context separated from the body with `---`
- always includes the message send time
- for `rin -u` cross-user sessions, injects the invoking system user into the turn context and appends a system-prompt warning when that user differs from the agent runtime user
- for Koishi bridge messages, also includes chatKey, chat name, sender user id, nickname, and bridge identity
- for Koishi bridge messages, appends system-prompt guidance exposing the current chatKey/chat name and requiring plain-text replies without Markdown
- keeps TUI user-message previews clean because the added header context is injected as a hidden turn message instead of rewriting the visible input
