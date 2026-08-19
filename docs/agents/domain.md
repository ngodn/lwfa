# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the glossary and the shape of the domain.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If either doesn't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a single-context repo. One glossary, one ADR directory, both at the root:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-nested-compositor-over-screen-capture.md
│   └── 0002-frame-budget-driven-by-backpressure.md
├── crates/          ← lwfa-engine, lwfa-proto, lwfa-spring (Rust)
└── packages/        ← shell, proto, spring (TypeScript)
```

The Rust and TypeScript halves are two implementations of one domain, not two domains. A session, a strip, a slot, a frame sink and a bitrate budget mean the same thing on both sides of the wire, so they get one glossary entry each, not two. If a term ever genuinely diverges between engine and shell, that's a finding worth writing down rather than a reason to split the file.

There is no `CONTEXT-MAP.md` here. If one ever appears at the root, this repo has moved to multiple contexts and each `CONTEXT.md` it points at should be read on its own.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
