# Rin Refactor Plan

> Goal: reduce code complexity, architectural coupling, and design weight without changing Rin's core value, guided by first principles and KISS.

## 1. Core goal

Rin should be defined from first principles as:

**Rin = a local session-based assistant with long-term memory and background execution.**

Under that definition, Rin has only three true first-class concepts:

- `session`
- `memory`
- `tasks`

Everything else should serve those three concepts rather than compete with them as an equal system axis.

---

## 2. Design decisions to keep

The following directions are already correct and should be reinforced rather than replaced.

### 2.1 `src/app` and `src/core` layering

The current separation between product assembly and reusable core runtime is good:

- `src/app/` handles product assembly and executable entrypoints
- `src/core/` holds reusable, independently runnable core logic

That boundary should be made even clearer over time.

### 2.2 Markdown-backed memory as the source of truth

The current memory design uses:

- markdown + frontmatter
- an event ledger
- lexical retrieval
- a relation graph

This stays aligned with Rin's product goals: lightweight, readable, and maintainable.

### 2.3 Daemon + worker pool + session reuse

Rin's long-running assistant behavior depends on:

- a daemon
- a worker pool
- session reuse

This is a core differentiator from one-shot agents and should remain stable.

### 2.4 Keep the SearXNG search approach

Search is currently backed by a local SearXNG sidecar. Even if the implementation is somewhat heavy, it still has the right shape:

- responsibilities are narrow
- third-party alternatives are not mature enough
- rebuilding it from scratch would violate KISS

So the search solution itself stays; only its surrounding architecture should be simplified.

### 2.5 Keep scheduled tasks as a builtin capability

Scheduled tasks are a key part of Rin being a long-running assistant rather than only a chat agent. This capability should stay builtin and become stronger.

---

## 3. Target architecture

Rin should be converged into four layers.

### 3.1 Core Domain

The true core should contain only:

- session runtime
- memory store / retrieval
- scheduled tasks

### 3.2 Product Shell

The shell layer contains product-facing surfaces:

- CLI
- TUI
- installer
- updater
- doctor

### 3.3 Capability Extensions

The extension layer contains capabilities built around the core:

- memory derivation (extractor / episode / onboarding)
- web-search tool
- Chat tools
- subagent
- attention resources

### 3.4 Infrastructure / Sidecars

The infrastructure layer contains support systems:

- daemon
- worker pool
- Chat bridge runtime
- SearXNG sidecar
- lock / state / process management

The intent of this four-layer split is simple:

- keep `session / memory / tasks` as the main axis
- move everything else into shell, extension, or infrastructure layers

---

## 4. Design areas that need simplification

### 4.1 Session must become the single core object

#### Current problem

Multiple modules currently manage session lifecycle directly:

- daemon worker
- cron
- Chat
- TUI runtime
- subagent

That causes:

- scattered session creation logic
- scattered restore/switch policy
- scattered output collection
- small behavior differences across entrypoints

#### Target

Every flow that runs one agent turn should go through a unified session façade.

#### Suggested structure

Introduce a shared layer:

- `src/core/session/factory.ts`
- `src/core/session/runner.ts`
- `src/core/session/binding.ts`

That layer should own:

- creating sessions
- restoring sessions
- binding session files and names
- prompt + wait-for-idle flow
- reading final output
- extension binding

#### Expected benefit

- session becomes the real system axis
- cron / Chat / worker / TUI behave consistently
- cross-module coupling is reduced

---

### 4.2 Split memory into core and derivation

#### Current problem

The memory system currently handles not only storage and retrieval, but also:

- extractor logic
- episode synthesis
- onboarding / init
- compile logic
- event processing
- relation graph management

Markdown is not the problem. The problem is that memory is gradually becoming a super-center.

#### Target

Split memory into two layers.

#### Memory Core

Responsible for:

- markdown docs
- frontmatter normalization
- event ledger
- relation graph
- retrieval
- compile

#### Memory Derivation

Responsible for:

- extractor
- episode synthesis
- onboarding / init
- future summarization / derivation flows

#### Suggested directories

- `extensions/memory/core/*`
- `extensions/memory/derivation/*`

#### Expected benefit

- the memory core remains stable
- intelligent derivation flows can evolve independently
- history-aware processing stops accumulating inside one oversized backend file

---

### 4.3 Reduce Chat from a heavy subsystem to a chat bridge adapter

#### Current problem

The current Chat code handles too many concerns at once:

- transport adapter
- inbound persistence
- reply / quote relationships
- trust / identity policy
- session binding
- outbox delivery
- typing state
- attachment handling

That makes Chat look like a full messaging subsystem instead of a bridge.

#### Target

Promote the system concept from `Chat` to `Chat Bridge`.

Chat should be treated as one adapter/runtime, not as the top-level concept.

#### Concept split

Split the design into three conceptual layers:

- `chat-transport`
- `chat-session-binding`
- `chat-policy`

Chat should then focus on:

- transport glue
- platform integration
- a small amount of adapter-specific logic

#### Expected benefit

- Chat occupies less architectural space
- policy, session binding, and platform integration stop being tangled together
- future bridge replacement or expansion becomes much easier

---

### 4.4 Split installer / updater from one all-in-one entry into three stages

#### Current problem

The install system currently handles too many jobs together:

- install
- update
- runtime publish
- daemon service configuration
- docs install
- provider auth init
- Chat config
- target discovery
- manifest maintenance

The issue is not feature count, but excessively wide boundaries.

#### Target

Split installation concerns into three stages.

#### bootstrap

Responsible for:

- installing the runtime
- writing launchers
- preparing the runtime directory

#### configure

Responsible for:

- provider auth
- initial settings
- Chat configuration

#### operate

Responsible for:

- update
- doctor
- repair
- migrate

#### Expected benefit

- install / update / repair are no longer mixed into one action
- the system behaves more like a product and less like a large script

---

### 4.5 Keep search, narrow the boundaries

#### Conclusion

Search should not be replaced, rebuilt, or reimagined as a custom lightweight alternative.

#### Only make these adjustments

- treat search as infrastructure rather than product core logic
- bring sidecar lifecycle under the shared management model
- keep its complexity contained inside the search module instead of letting it leak globally

#### Principle

The issue with search is not that it is too heavy. The issue is that implementation weight exists even though its responsibility is narrow.

For components like this:

- keep the chosen solution
- simplify surrounding infrastructure
- avoid conceptual rewrites

---

## 5. Core code-level refactors

### 5.1 Remove jiti completely

#### Target

Unify runtime behavior so that:

- development also prefers built outputs where practical
- installed runtimes execute only `dist`
- source fallback is no longer an accepted production path

#### Required work

- include `extensions/*` in build output
- point `src/app/builtin-extensions.ts` at built output paths
- stop dynamic `.ts` loading in `extensions/memory/lib.ts`
- stop dual `src` / `dist` lookup in `extensions/chat-get-message/index.ts`
- remove jiti-related logic from `src/core/rin-lib/loader.ts`

#### Expected benefit

- one runtime boundary
- more stable installed packages
- clearer debugging paths
- fewer environment-specific problems

---

### 5.2 Eliminate source / dist mixed execution

#### Principle

The real runtime should exist in only two states:

- dev build
- installed dist runtime

There should no longer be a hybrid state where some modules run from `dist` while others fall back to dynamically loaded source files.

---

### 5.3 Extract shared platform primitives

#### Suggested directory

- `src/core/platform/fs.ts`
- `src/core/platform/process.ts`
- `src/core/platform/json-state.ts`
- `src/core/platform/lock.ts`
- `src/core/platform/user-env.ts`

#### Shared utilities to converge

- `safeString`
- `ensureDir`
- `ensurePrivateDir`
- `writeJsonAtomic`
- `isPidAlive`
- `sleep`
- `shellQuote`
- `runPrivileged`
- user switching and target-user runtime env construction

#### Expected benefit

- duplicated infrastructure disappears
- behavior becomes more consistent across modules
- future work shifts toward reusable abstractions instead of copy-paste

---

### 5.4 Extract a shared sidecar layer

#### Suggested directory

- `src/core/sidecar/registry.ts`
- `src/core/sidecar/instance.ts`
- `src/core/sidecar/lock.ts`
- `src/core/sidecar/status.ts`

#### Applies to

- `src/core/chat/service.ts`
- `src/core/rin-web-search/service.ts`

#### Shared concerns

- instance state management
- lock acquisition / release
- orphan cleanup
- start / stop / status model

#### Expected benefit

- consistent sidecar lifecycle management
- less duplicated logic inside Chat and web-search modules
- new sidecars stop inheriting the same repeated patterns

---

### 5.5 Add schemas at system boundaries

#### Boundaries that need schemas

- RPC command / response
- cron task record
- Chat message record
- sidecar state
- memory doc metadata

#### Principle

Do not introduce a heavy framework. Aim only for:

- clear boundaries
- validatable inputs
- state shapes that can evolve safely

#### Expected benefit

- reduced dirty-state risk from silent tolerance
- easier identification of breakage during refactors
- stronger foundations for doctor / migrate / repair capabilities

---

## 6. Big-file split plan

### 6.1 `src/core/rin/main.ts`

Split into:

- `src/core/rin/cli.ts`
- `src/core/rin/daemon-control.ts`
- `src/core/rin/update.ts`
- `src/core/rin/doctor.ts`
- `src/core/rin/tmux.ts`

Clean up currently unused leftover logic during the split.

### 6.2 `src/core/rin-install/main.ts`

Split into:

- `install/interactive.ts`
- `install/publish.ts`
- `install/bootstrap.ts`
- `install/configure-provider.ts`
- `install/configure-chat.ts`
- `install/service-systemd.ts`
- `install/service-launchd.ts`
- `install/update-targets.ts`
- `install/manifest.ts`

### 6.3 `extensions/memory/store.ts`

Split into:

- `memory/core/schema.ts`
- `memory/core/markdown.ts`
- `memory/core/layout.ts`
- `memory/core/events.ts`
- `memory/core/graph.ts`
- `memory/core/search.ts`
- `memory/core/compile.ts`
- `memory/core/actions.ts`

### 6.4 `src/core/chat/main.ts`

Split into:

- `rin-chat/controller.ts`
- `rin-chat/inbound.ts`
- `rin-chat/outbound.ts`
- `rin-chat/attachments.ts`
- `rin-chat/prompt-meta.ts`
- `rin-chat/policy.ts`

### 6.5 `src/core/rin-tui/runtime.ts`

Split into:

- `rin-tui/session-state.ts`
- `rin-tui/remote-agent.ts`
- `rin-tui/reconnect.ts`
- `rin-tui/extensions.ts`
- `rin-tui/stats.ts`

---

## 7. Component strategy table

| Component              | Strategy  | Notes                                                                |
| ---------------------- | --------- | -------------------------------------------------------------------- |
| session                | reinforce | make it the single core object                                       |
| memory store           | reinforce | keep markdown as the base, only split responsibilities               |
| memory derivation      | simplify  | move extractor / episode / onboarding out of core                    |
| Chat bridge            | simplify  | converge from a heavy subsystem into a chat bridge adapter           |
| installer / updater    | simplify  | split the all-in-one entry into staged flows                         |
| search / SearXNG       | bound     | keep the solution, only manage lifecycle and repeated infrastructure |
| jiti / source fallback | remove    | pure runtime-boundary debt                                           |

---

## 8. Recommended implementation order

### Phase 1: Build foundations without changing product behavior

#### Goal

Reduce risk for later refactors.

#### Tasks

1. Add characterization tests to key boundaries
2. Add schemas for RPC / cron / sidecar state
3. Extract platform primitives
4. Extract sidecar primitives

#### Result

Later file splits and structural changes become safer.

---

### Phase 2: Clean runtime boundaries

#### Goal

Remove jiti and eliminate source / dist mixed execution.

#### Tasks

1. Build extensions into artifacts
2. Run all runtime paths from `dist`
3. Remove source fallbacks
4. Delete the jiti dependency chain

#### Result

The runtime model becomes uniform.

---

### Phase 3: Split large files and establish harder boundaries

#### Goal

Reduce maintenance complexity in a visible way.

#### Tasks

1. Split `src/core/rin/main.ts`
2. Split `src/core/rin-install/main.ts`
3. Split `extensions/memory/store.ts`
4. Split `src/core/chat/main.ts`
5. Split `src/core/rin-tui/runtime.ts`

#### Result

The code structure starts to match the design structure.

---

### Phase 4: Do concept-level refactors

#### Goal

Make the system actually match its first-principles definition.

#### Tasks

1. Land the session façade
2. Land the memory core / derivation split
3. Land the chat bridge model
4. Land the three-stage installer model

#### Result

Rin evolves from a cleaned-up codebase into a clearly designed long-term product.

---

## 9. Work that can start immediately

### First batch

1. Full jiti removal roadmap
2. Build extensions into artifacts
3. Extract `platform/fs` and `platform/process`
4. Clean up and split `src/core/rin/main.ts`

### Second batch

5. Extract the sidecar base layer
6. Split `src/core/rin-install/main.ts`
7. Split `extensions/memory/store.ts`

### Third batch

8. Land the unified session façade
9. Refactor Chat into a chat bridge structure
10. Clean up memory derivation

---

## 10. Final target state

After the cleanup, Rin should meet these standards.

### Runtime

- installed runtimes execute only `dist`
- no source fallback
- no jiti
- unified sidecar lifecycle management

### Code

- no superfiles
- no duplicated shared infrastructure
- schema-backed core boundaries
- concentrated session logic

### Design

- session is the only main object
- memory store and intelligent derivation are separated
- Chat is a bridge, not a center
- installer / updater responsibilities are clear
- search remains stable and is not over-reworked

---

## 11. One-sentence summary

The point of this cleanup is not to rewrite Rin.

**It is to preserve the product direction that is already correct while systematically removing accumulated runtime-boundary confusion, duplicated infrastructure, superfiles, and overweight components.**
