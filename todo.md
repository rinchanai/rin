# Chat bridge redesign todo

- [x] Re-read Pi philosophy and Rin refactor docs
- [x] Write redesign notes
- [x] Write execution plan
- [x] Simplify inbox architecture to queue-only execution
- [x] Remove immediate execution from `chat/main.ts`
- [x] Keep claimed inbox items in `processing/` until promise settlement
- [x] Restore stranded `processing/` items on startup
- [x] Remove main-path acceptance timeout / dual-truth logic
- [x] Re-run focused chat tests
- [x] Add regression coverage for processing-file recovery and queue-only execution
- [x] Review diff for architectural residue
- [x] Commit as one coherent redesign block
