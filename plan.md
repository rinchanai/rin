# Chat bridge simplification plan

Goal: rebuild the inbound chat execution path so it matches Pi/Rin design philosophy:

- KISS
- one execution path per inbound message
- fewer mutable states
- clear boundaries between transport, queueing, policy, session binding, and delivery
- no patch-style dual truth between immediate handling and queued handling

## What is wrong now

The current path still carries architectural residue:

- inbound events are both queued and handled live
- queue state and execution state overlap
- acceptance is inferred indirectly instead of owned clearly
- queue retry logic depends on partial controller state
- mention-routing metadata can be lost when rebuilding from queued payloads

## New convergence target

1. Runtime adapters emit one inbound event.
2. `ChatRuntimeApp` persists one durable inbox envelope.
3. `startChatBridge()` only:
   - records inbound message/log
   - schedules inbox draining
4. Inbox draining is the only execution entrypoint.
5. Claimed inbox items stay in `processing/` until the execution promise settles.
6. Success deletes the processing item.
7. Retryable failure requeues with backoff.
8. Startup restores stranded `processing/` items back to `pending/`.

## Boundary model

- `chat-runtime/*`: transport adapters and event normalization
- `chat/inbox.ts`: durable queue transport only
- `chat/decision.ts`: pure policy
- `chat/controller.ts`: per-chat session execution + delivery behavior
- `chat/main.ts`: orchestration only

## Concrete changes

- remove live command/prompt execution from `app.on("message")`
- remove duplicate enqueue from `chat/main.ts`
- add inbox processing-file restore on startup
- change inbox draining from acceptance-poll model to promise-owned processing model
- keep full routing hints in queued payloads
- delete now-unnecessary acceptance timeout coupling from main path

## Verification standard

- one inbound help message delivers exactly once
- one slow inbound prompt is not requeued and duplicated during session bootstrap delay
- queued group mentions still route correctly after serialization
- startup can recover stranded processing items
- no chat execution path remains outside inbox draining
