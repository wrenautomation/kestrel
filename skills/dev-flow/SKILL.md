---
name: dev-flow
description: The design-first dev flow for a repo with a kestrel.json. The owner reviews the design as a generated map, not the code. Use when a change adds, moves or removes a package, export, route, table, system or screen; when you write a skeleton; before you ask the owner to approve; when you run kestrel gen, packet, approve, check, stamp, health, cost or view; or when a map card is stale.
---

# Dev flow with kestrel

The repo has two layers. The **generated map** (`map/generated/`) is the shape, made from the
code. The owner approves it as a whole, and the approval is a commit. The **cards** (`map/`) hold
the why. For how to write cards in this mode, read icm-architect's `references/two-layer.md`.

Run `kestrel` from the repo root, or pass `-C <repo>`. If it is not on PATH, run `pnpm link
--global` in the kestrel checkout, or `node <kestrel>/dist/cli.js`.

## The flow

1. **Discuss.** Agree on the change with the owner.
2. **Design doc.** Write the goal, the target shape, the options and the decision log.
3. **Annotate.** The owner marks it up. Wait for the answer.
4. **Skeleton.** Write real files, types and signatures, with `todo()` bodies. It must typecheck.
5. **Review the map.** Run `kestrel gen`, then `kestrel packet -o <file>`. Send the packet and
   `kestrel view` (http://127.0.0.1:4610/) to the owner. Only the owner runs `kestrel approve`.
   Commit the approved files after that.
6. **Bodies.** Fill in the code. The shape must not move.
7. **Check.** Run `kestrel check` when a design step ends. It shows drift, stale cards and
   decisions due again. Fix each line, or go back to step 5 for a shape change.
8. **Ship.**

`kestrel check` is never part of lint, tests or the deploy gate. Those stay fast.

## Commands

| Command | Does |
|---|---|
| `gen [layers]` | Writes the current map and its pages |
| `packet [layers] -o <file>` | Writes one page: what changed since approve, cards to read again, decisions due again |
| `approve [layers]` | The owner's only. Makes current the approved map |
| `check [layers]` | Gen, then fails on drift, stale cards or a crossed trigger |
| `stamp <cards>` | Marks a card read against the approved map. Read it first |
| `health` | Cycles, clones, unused code, flat folders. Run it under the repo's check lock |
| `cost` | Spend per map node. Local only: never commit `cost.md` |
| `view` | The map as a local page. Stop the server when done |

## Rules

- Never edit `map/generated/` by hand.
- Never run `kestrel approve` yourself. Ask the owner.
- Approve the whole map once per design step, not one part at a time.
- A changed node that a card covers makes the card stale. Read the card, fix it, then stamp it.
- Write a decision `trigger` only with a number the owner gave.
