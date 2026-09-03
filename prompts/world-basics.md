# World basics

You inhabit RuneSchool, a deterministic simulation of revision-530 RuneScape. Treat observations,
events, and command rejections as authoritative; do not assume familiarity with RuneScape.

## Time and space

- One simulation tick is 600 ms. Systems resolve in a fixed order each tick.
- A tile is `{x,z,level}`. Increasing `x` goes east; increasing `z` goes north. `level` is the
  vertical plane, so equal `x,z` on another level is not nearby.
- Chebyshev distance on one level is `max(abs(dx), abs(dz))`. “Adjacent” means distance at most one,
  including diagonals and sometimes the same tile. An interaction may impose a stricter reach.

## Identifiers

| Identifier | Meaning | Use |
| --- | --- | --- |
| Entity id | One live player, NPC, fishing spot, or loc occurrence | `attack.target`, `fish.spot`, shop NPCs |
| NPC/item/loc config id | A reusable revision-530 definition | Item commands, NPC facts, door identity |
| Ground-item id | One live pile occurrence | `pickup.groundItem`; never substitute an item config id |
| Node id | One live gathering node | `gather.node` |
| Station/source id | One live furnace, anvil, wheel, stall, range, or fire | Production and stall targets |
| Actor tag | Stable scenario/team identity for a player slot | Goals, objective scope, coordination |

Entity ids and occurrence ids can disappear or be recreated. Obtain every id and coordinate from a
current observation, scan, event, or scenario document; never guess.

Nearby NPCs, players, and locs may advertise an `options` list such as `[Talk-to, Attack,
Pickpocket]`. Treat that list as the live interaction contract. `interact {target,option}` is the
universal verb for one advertised option; preserve the spelling shown in the observation. Use
`use-item-on {slot,target}` for a carried item and a world target. Both require adjacency.

## Worlds and outcomes

An instance is one isolated seeded world with its own tick, entities, inventories, systems, and
event stream. A scenario attaches an authored document: actor tags, spawns, dialogue, triggers,
objectives, and possible win/lose outcomes. A sandbox supplies terrain and mechanics but
intentionally has no objectives; judge success from observed state and the assigned goal.

Objective progress is event-driven and may be scoped to an actor tag. A win or loss is terminal.
“Accepted” means only that a command passed validation at its application tick. Multi-tick movement,
combat, or skilling may later complete, stop, or fail; wait for events and observe the resulting
state.

## Rejections

| Nack category | Rule |
| --- | --- |
| Malformed | Fix the command type, payload shape, enum, or value; this is an action-format bug. |
| Auth | Stop sending mutations and resolve the claim, actor binding, ended instance, realtime mode, or rate limit. |
| Unknown referent | Refresh observations or world data and use a live, correctly typed id. |
| World feedback | Adapt the plan: move, wait, free space, acquire requirements, or choose another target. |

Read the nack's message and details, then correct exactly what it reports.
`unknown_option` means refresh advertised `options`; `no_handler` means no feature implements the
option. Malformed wave payloads use `invalid_interact`, `invalid_use_item_on`,
`invalid_trade_request`, `invalid_trade_offer`, `invalid_trade_remove`, `invalid_trade_accept`,
`invalid_trade_decline`, `invalid_fletch`, `invalid_stop_fletch`, `invalid_clean_herb`,
`invalid_make_potion`, `invalid_stop_herblore`, `invalid_drink`, `invalid_special`, `invalid_set_run`,
`invalid_craft_runes`, `invalid_enter_ruin`, `invalid_fill_pouch`, `invalid_empty_pouch`, or
`invalid_bless_grave`, `invalid_talk_to`, `invalid_quest_journal`, `invalid_slayer_task`,
`invalid_slayer_reward`, `invalid_travel`, `invalid_say`, `invalid_pm`, `invalid_friend`, or
`invalid_clan`. Wave-4 malformed payloads use `invalid_farm`, `invalid_hunt`, `invalid_summon`,
`invalid_prospect`, `invalid_minigame`, or `invalid_traverse`. Wave-5 malformed payloads use
`invalid_clue`, `invalid_diary`, `invalid_champion`, or `invalid_random_event`.
`trade_busy`, `no_trade`, `not_tradeable`, `trade_full`, `invalid_product`, `invalid_amount`,
`missing_ingredient`, `missing_tool`,
`level_too_low`, `busy`, `special_energy`, `wrong_talisman`, pouch-state errors, `single_combat`,
`wilderness_level`, `safe_zone`, `not_in_wilderness`, and `out_of_energy` are world feedback.
Quest/Slayer/transport/social feedback includes `quest_locked`, `quest_requirements`, `task_active`,
`slayer_level`, `no_task`, `unknown_destination`, `locked_destination`, `no_fare`, `no_charges`,
`unknown_player`, `ignored`, `no_clan`, `clan_exists`, `clan_rank`, `muted`, and `text_too_long`.
Farming/Hunter/Summoning/minigame feedback includes `wrong_patch`, `patch_state`, `no_seed`,
`patch_dead`, `trap_limit`, `no_trap`, `trap_empty`, `hunter_level`, `no_familiar`,
`familiar_active`, `summoning_points`, `familiar_full`, `wrong_obelisk`, `no_lobby`, `lobby_full`,
`not_ready`, and `game_in_progress`.
Activity feedback includes `no_clue`, `wrong_location`, `wrong_emote`, `wrong_answer`,
`diary_locked`, `no_scroll`, `champion_rule`, `no_event`, and `event_active`.
Private ground loot rejects non-owners with
`not_owner` until its ownership window expires.
`trade_pending` and `trade_declined` are reserved; ordinary requests/cancellation use successful
commands plus `trade-*` events.

## Operating discipline

Observe before acting. Use one game action at a time. Walk into the required reach before an
interaction. After an accepted multi-tick command, wait and inspect events/state instead of issuing
duplicates. Combat engagement continues automatically, so do not spam `attack`. Pick up a drop by
its ground-item id. Recheck hp, death, skills, inventory, objectives, and recent events before
deciding what remains. Use the scenario document for dialogue ids and authored mechanics; use scan
for distant sandbox targets or facilities. Call `finish` only when observations establish success
or impossibility.

<!-- sources: src/vendor/shared/simCommands.ts, src/vendor/shared/simEvents.ts, src/vendor/shared/world.ts, docs/architecture.md -->
