# Chat Bridge Redesign Notes

## Source principles

### Pi philosophy

- Keep the core minimal.
- Do not bake workflow policy into the core when it can live in extensions or outer layers.
- Prefer one clear runtime creation path over multiple special cases.
- Session replacement should rebuild and rebind runtime-local state through one runtime facade.
- Narrow responsibilities beat feature-heavy managers.

### Rin architecture direction

- Rin's first-class concepts are `session`, `memory`, and `tasks`.
- Chat is not a top-level system axis. It is a bridge around sessions.
- Chat should be split into:
  - transport
  - session binding
  - policy
- Infrastructure and sidecars should stay narrow and replaceable.

## Why the current chat design is wrong

The current chat path mixes too many responsibilities in one live flow:

- inbound persistence
- queueing and retry
- routing policy
- command detection
- session restore
- turn execution
- acceptance tracking
- final delivery
- recovery

This violates Pi-style boundaries.

It also creates duplicate sources of truth:

- runtime event stream
- inbox queue
- chat state file
- message store acceptance fields
- controller in-memory processing state

Once the same inbound message can be observed through multiple partially authoritative states, duplicate execution and silent drops become structural risks rather than isolated bugs.

## First-principles target

A chat bridge should do only this:

1. normalize an inbound platform event into one canonical inbound envelope
2. decide whether the envelope should create a turn
3. bind the envelope to exactly one session execution attempt
4. deliver exactly one final outcome for that envelope

Everything else is support code.

## Required invariants

### Invariant 1: one inbound message -> one canonical envelope

Every inbound message must be normalized once into a durable envelope with:

- envelope id
- platform message id
- canonical chat key
- sender identity key
- normalized content
- normalized mention/direct metadata
- reply reference
- attachments metadata
- command parse result if any

No later stage should reconstruct meaning from raw platform session objects.

### Invariant 2: one envelope -> one lifecycle owner

Exactly one subsystem may own progress of an envelope.

Suggested states:

- `received`
- `accepted`
- `running`
- `delivered`
- `ignored`
- `failed`

These states should live in one durable ledger, not split across queue files, message-store flags, and controller memory.

### Invariant 3: queue is transport, not authority

A queue should only schedule work.
It must not also encode routing truth, acceptance truth, or session truth.

If the queue item disappears, the system should still know whether the envelope was ignored, running, or delivered.

### Invariant 4: session execution goes through one facade

Chat must not own custom session lifecycle rules.
It should call a shared session runner that already defines:

- restore or create session
- execute slash command or prompt
- wait for completion
- collect final output
- bind resulting session selectors

Chat should provide inputs and consume outputs only.

### Invariant 5: policy is pure

Routing policy must be a pure function from normalized envelope + identity state to decision.
It must not depend on transport queues or controller internals.

### Invariant 6: delivery is idempotent

Final delivery must be recorded against envelope id and delivery id.
Re-running recovery should resend only if no successful delivery record exists.

## Minimal architecture

### 1. `chat-envelope`

Responsible for:

- normalize inbound platform events
- serialize durable envelope
- compute canonical ids

No session logic.
No delivery logic.

### 2. `chat-policy`

Responsible for:

- should ignore / accept / command-route
- mention/direct/trust evaluation

Pure logic only.

### 3. `chat-queue`

Responsible for:

- enqueue accepted envelopes
- claim next runnable envelope
- retry scheduling

No routing reconstruction.
No session inference.

### 4. `chat-execution-ledger`

Responsible for:

- authoritative envelope state machine
- CAS-like state transitions
- idempotency checks

This is the single source of truth for whether a message is still pending, already running, or already delivered.

### 5. `chat-session-runner-adapter`

Responsible for:

- translate envelope into session-runner input
- call shared session runtime facade
- return normalized execution result

No platform code.

### 6. `chat-delivery`

Responsible for:

- send working indicators if configured
- send final output
- persist delivery receipt

No session restore logic.

## Structural simplifications to make

### Remove dual immediate+queued execution

The same inbound message must not be both:

- executed immediately in the live event handler
- and also retried later from a durable inbox

Choose one model.

Preferred model:

- event handler only normalizes + records + enqueues
- worker loop is the only executor

That is slower by a tiny amount but dramatically simpler and safer.

### Remove controller-owned acceptance truth

`controller.state.processing`, message-store `acceptedAt`, and inbox file presence should not all participate in acceptance semantics.

Acceptance should be derived from the ledger only.

### Stop storing partial routing hints in ad-hoc shapes

Mention/direct metadata should be part of the normalized envelope schema, not raw copied session fragments whose shape varies by platform.

### Stop chat-specific session bootstrap exceptions

`/new`, recovery, restore, and prompt turns should all go through the same shared session runtime contract.
Any special case should exist in the shared session runner, not in chat glue.

## Implementation direction

### Phase 1: architecture convergence

- introduce a normalized envelope schema
- introduce a durable execution ledger
- convert inbound path to enqueue-only
- make one worker loop the sole executor

### Phase 2: shared session runner

- move chat execution onto a shared session facade
- delete chat-local session lifecycle branches where possible

### Phase 3: trim chat controller

The remaining controller should only handle:

- optional progress indicators
- session event observation during an active turn
- final delivery coordination

If that still looks large, it is still doing too much.

## Design standard

The target is not “patch all currently observed bugs”.
The target is:

- one source of truth per fact
- one owner per transition
- one execution path per message
- pure policy
- shared session runtime
- idempotent delivery

Anything that does not serve those constraints is likely residue and should be removed.
