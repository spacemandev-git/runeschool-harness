# Dialogue and quests

## Dialogue graphs

Use `talk-to {npc}` with a live NPC entity to select its highest-priority eligible bound tree.
Trees may be gated by per-actor flags, quest stage/range, base skill level, inventory, prerequisite
quests, or quest points. `talk {dialogue}` remains available for directly named scenario trees.

| Node kind | What you receive | What to do |
| --- | --- | --- |
| `npc` | Speaker tag and text | Read it; `dialogue-advance {}` follows `next` |
| `player` | Your line | `dialogue-advance {}` follows `next` |
| `choice` | Prompt and ordered options | Send `dialogue-advance {choice:index}` using the displayed zero-based index |
| `action`, `if`, `set`, `quest`, `give`, `take`, `teleport`, `xp` | Not displayed | The server applies it and continues to the next presentable node |

Omitting a required choice returns `choice_required`; supplying an invalid index returns
`invalid_choice`. Keep advancing until `dialogue-ended`. A dialogue can branch or loop, so choose
by current option text rather than a remembered index.

## Quest state

Quest progress belongs to each actor, not the instance as a whole. `quest-stage` supplies the new
stage and journal text; `quest-complete` reports the one-time quest-point award. Send
`quest-journal {}` to refresh every quest's stage/completion plus total points in the observation.
`quest_requirements` means the actor lacks a prerequisite, base level, or quest-point threshold;
`quest_locked` means the requested transition or inventory-dependent action cannot apply. Wallet
actors persist quest stages, flags, points, and one-time rewards across hosted-world sessions.

## Objectives and progress

An objective has a description, a condition, optional actor-tag scope, and outcome: `progress`,
`win`, or `lose`. Progress lines show each leaf's current and target values. Conditions include
NPC-config kills, item obtains, reaching a tile area, a skill level, or a named event; `all` and
`any` combine them. Conditions latch once satisfied.

Progress is event-driven. Initial inventory does not satisfy an obtain condition; gaining the item
during play does. A scoped kill needs the matching actor as killer. Read objective updates after
combat, pickup, movement, leveling, and dialogue. The first completed win or lose objective ends
the scenario.

## Triggers and chains

Triggers react to the same condition language. They can send a message, spawn an NPC, give an item,
start dialogue, start a cinematic, or emit another named event. Assume a trigger fires once unless
authored otherwise. Dialogue action nodes commonly emit acceptance or turn-in events that unlock
these effects.

`chain` identifies a staged quest and `nextScenario` names the authored next document. Winning does
not automatically start it: the host must create the next instance and may carry actor state from
the archived run. Do not claim the chain is complete until the assigned scope says so.

A sandbox intentionally has no objectives, dialogue graph, or terminal win/lose state. There,
judge completion from inventory, skills, position, combat results, messages, and the user's goal,
then report the evidence.

<!-- sources: src/vendor/shared/scenario.ts, src/vendor/shared/quests.ts, src/vendor/shared/simCommands.ts, src/vendor/shared/simEvents.ts -->
