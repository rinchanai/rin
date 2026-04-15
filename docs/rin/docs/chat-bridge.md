# Chat Bridge Tool

`chat_bridge` runs constrained TypeScript/JavaScript code against the live chat bridge runtime.

## When to use it

Use `chat_bridge` for tasks such as:

- sending a message to a specified chat
- sending mixed text / mention / image / file content
- using platform-specific bridge APIs
- chat management actions
- complex interactive chat flows

## Runtime objects

The code runs as an async function body.

Available globals:

- `chat`
  - current bound chat scope when the current session is already bound to a chat
  - `null` when there is no current bound chat
- `bot`
  - cross-platform methods for the current bound chat scope
- `internal`
  - platform-specific adapter API for the current bound chat scope
- `h`
  - message element builder
- `store`
  - local message / chat-log helpers for the current bound chat scope
- `identity`
  - local trust helpers for the current bound chat scope
- `helpers`
  - bridge helpers

## `helpers`

- `helpers.currentChatKey`
  - current bound chat key, if any
- `helpers.useChat(chatKey)`
  - returns a bound scope for another chat
  - the returned object has:
    - `chat`
    - `bot`
    - `internal`
    - `h`
    - `store`
    - `identity`
    - `helpers`
- `helpers.send(input)`
  - tracked outbound send for the current bound scope
- `helpers.reply(replyToMessageId, input)`
  - tracked outbound reply for the current bound scope
- `helpers.serialize(value)`
  - safe JSON-like serialization helper

## Message input

`helpers.send()` and `helpers.reply()` accept either:

- a string
- one part object
- an array of parts
- an object with `parts`

Supported parts:

- `{ type: "text", text: "hello" }`
- `{ type: "at", id: "123", name?: "name" }`
- `{ type: "quote", id: "456" }`
- `{ type: "image", path?: "/abs/file.png", url?: "https://...", mimeType?: "image/png" }`
- `{ type: "file", path?: "/abs/file.zip", url?: "https://...", name?: "file.zip", mimeType?: "application/zip" }`

## Basic template

```ts
const scope = chat ?? helpers.useChat("onebot/2301401877:1067390680");

return await scope.bot.getGuild(scope.chat.chatId);
```

## Examples

### Send text to a specified chat

```ts
const room = helpers.useChat("onebot/2301401877:1067390680");
await room.helpers.send("你好");
return "ok";
```

### Send mixed content

```ts
const room = helpers.useChat("telegram/8623230033:-1001234567890");
await room.helpers.send([
  { type: "text", text: "看这个" },
  { type: "image", url: "https://example.com/demo.png" },
]);
return "sent";
```

### Use a cross-platform method

```ts
const scope = chat ?? helpers.useChat("telegram/8623230033:-1001234567890");
return await scope.bot.getGuildMember(scope.chat.chatId, "123456789");
```

### Use a platform-specific method

```ts
const scope = helpers.useChat("telegram/8623230033:-1001234567890");
return await scope.internal.getChatMember({
  chat_id: scope.chat.chatId,
  user_id: 123456789,
});
```

### Inspect local stored message context

```ts
const scope = chat ?? helpers.useChat("onebot/2301401877:1067390680");
return scope.store.getMessage("1234567890");
```

## Notes

- prefer `bot` when a cross-platform method exists
- use `internal` only when you need platform-specific behavior
- use `helpers.useChat(chatKey)` when you need to act on a different chat
- returned values are passed through with safe serialization when needed
