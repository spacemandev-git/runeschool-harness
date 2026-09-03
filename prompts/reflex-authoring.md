# Reflex authoring

Reflexes evaluate every 600 ms pulse so cheap, deterministic reactions happen while you sleep.
Use rules for small reactions and a named behaviour for a stateful loop. Keep conditions cheap and
conservative: add cooldowns, use `once` for one-shot notices, and avoid actions that fight your
current behaviour.

## Rule shape

```json
{"id":"lowercase-hyphen-id","description":"optional","priority":50,"when":{"op":"true"},"do":[{"kind":"note","text":"fired"}],"cooldownTicks":1,"once":false,"enabled":true}
```

Ids match lowercase letters/digits/hyphens and are at most 48 characters. Higher priority fires
first; ties sort by id. `cooldownTicks` defaults to one pulse. `once` disables after the first fire.

### References

`self.hp.current`, `self.hp.max`, `self.hp.fraction`, `self.prayer.points`,
`self.prayer.fraction`, `self.inCombat`, `self.attackedBy.count`, `self.dead`, `self.activity`,
`self.at.x`, `self.at.z`, `self.at.level`, `inventory.free`, `inventory.used`,
`nearby.npcs.count`, `nearby.players.count`, `groundItems.count`, `dialogue.active`,
`dialogue.hasOptions`, `objectives.won`, `objectives.lost`, `tick`.

### Expressions

| op | fields | meaning |
| --- | --- | --- |
| `and`, `or` | `args: Expr[]` | Boolean composition |
| `not` | `arg: Expr` | Negation |
| `lt`, `le`, `gt`, `ge`, `eq`, `ne` | `ref`, `value:number|string|boolean` | Compare a reference |
| `has-item` | `item:number|string`, `min?` | Inventory contains config/name and amount |
| `has-food` | none | Any supported food is available |
| `skill-at-least` | `skill`, `level` | Base skill meets level |
| `nearby` | `kind:"npc"|"player"|"ground_item"|"node"|"station"`, `name?`, `radius?`, `min?` | Nearby match count meets minimum |
| `event` | `type`, `withinTicks?` | Recent visible event exists |
| `behaviour-running` | `id?` | Any or named behaviour is active |
| `true`, `false` | none | Constant |

### Actions

| kind | fields |
| --- | --- |
| `command` | `type`, `data` (your entity is injected) |
| `eat` | `prefer?:"highest-heal"|"lowest-heal"` |
| `attack-nearest` | `name?`, `radius?`, `targetKind?:"npc"|"player"|"any"` (`npc` default) |
| `retaliate` | none |
| `cast` | `spell`, `target?`, `name?`, `radius?`; `targetKind?:"npc"|"player"|"any"` for `target:"nearest"` (`npc` default) |
| `disengage` | none |
| `pickup-nearest` | `name?`, `radius?` |
| `flee` | `to?:{x,z,level}`, `distance?` |
| `pray` | `prayer` |
| `bury-all` | none |
| `start-behaviour` | `behaviour`, `params`, `replace?` |
| `stop-behaviour` | `id?` |
| `wake-mind` | `note` |
| `note` | `text` |

## Complete examples

Eat below half hp:

```json
{"id":"eat-below-half","priority":100,"when":{"op":"and","args":[{"op":"lt","ref":"self.hp.fraction","value":0.5},{"op":"has-food"}]},"do":[{"kind":"eat","prefer":"highest-heal"}],"cooldownTicks":3}
```

Retaliate only when idle and attacked:

```json
{"id":"retaliate-when-idle","priority":80,"when":{"op":"and","args":[{"op":"eq","ref":"self.activity","value":"idle"},{"op":"gt","ref":"self.attackedBy.count","value":0},{"op":"not","arg":{"op":"behaviour-running"}}]},"do":[{"kind":"retaliate"}],"cooldownTicks":2}
```

Wake when inventory becomes full:

```json
{"id":"wake-inventory-full","priority":40,"when":{"op":"eq","ref":"inventory.free","value":0},"do":[{"kind":"wake-mind","note":"Inventory is full; choose bank, drop, or stop."}],"cooldownTicks":10,"once":true}
```

## Behaviour catalogue

| id | params | use |
| --- | --- | --- |
| `walk-to` | one of `dest`, `entity`, `node`, `station`, `groundItem`; `stopWithin?`, `run?`, `timeoutTicks?` | Reach a tile or live referent and re-path as needed |
| `interact` | `target`, `option`; `run?`, `timeoutTicks?` | Walk adjacent, issue the universal interaction, and wait for `interacted` |
| `use-item-on` | `slot`, `target`; `run?`, `timeoutTicks?` | Walk adjacent, use the occupied slot, and wait for `item-used` |
| `fight` | `target?` or `name?`; `targetKind?:"npc"|"player"|"any"` (`npc` default), `radius?`, `kills?`, `untilHpBelow?`, `maxTicks?` | Sustain one NPC or player combat plan without attack spam |
| `special-attack` | `target`; `timeoutTicks?` | Walk adjacent, arm the equipped weapon special, attack, and await its event |
| `drink-when` | `potion`; one of `hpBelow?`, `prayerBelow?`, `whenPoisoned:true`; `timeoutTicks?` | Wait for a status threshold and drink the named inventory dose |
| `flee-wilderness` | `radius?`, wilderness-level bounds?, `southTiles?`, `run?`, `timeoutTicks?` | Watch for a nearby player, enable run, and route south until outside wilderness |
| `runecraft-loop` | `talisman`, positioned `ruin` and `altar`; `run?`, `timeoutTicks?` | Enter one ruin, approach its altar, craft once, and await output |
| `quest-step` | `npc`; `choices?`, `maxNodes?`, `timeoutTicks?` | Start the NPC's eligible dialogue and auto-advance, using supplied choice indexes or zero |
| `slayer-loop` | `master`; `radius?`, `run?`, `timeoutTicks?` | Request an assignment, seek matching nearby NPC configs, and fight until completion |
| `travel-to` | `network`; `from?`, `destination?`, `code?`, `item?`, `run?`, `timeoutTicks?` | Walk to an optional departure loc, travel, and await arrival |
| `chat` | `text`; `channel?`, `to?`, `replyToMentions?`, `timeoutTicks?` | Send templated say/PM text or wait until chat mentions the agent and reply |
| `farm-run` | `patches:[{id,at,loc,seed,compost?}]`; `run?`, `timeoutTicks?` | Prepare configured patches, wait for grown events, and harvest until empty |
| `trap-loop` | trap `item`, maintained `count`; `timeoutTicks?` | Lay N traps, check catches, dismantle collapses, and re-lay returned tools |
| `familiar-keeper` | `pouch`; `renewBeforeTicks?`, `dismiss?`, `timeoutTicks?` | Summon and renew before expiry, or dismiss the active familiar |
| `course-loop` | `course`, ordered `obstacles`, `laps`; `timeoutTicks?` | Traverse the canonical moving obstacle sequence for N laps |
| `minigame-join` | `game`; `options?`, `timeoutTicks?` | Join and ready, wait through the session, then report its result |
| `minigame-loop` | `game`; `options?`, `rounds?`, `timeoutTicks?` | Rejoin repeatedly; attack unshielded Pest Control portals or search Barrows sarcophagi |
| `clue-solver` | `item?`; text/`tier:step` maps `locations?`, `emotes?`, `answers?`, `npcs?`; `run?`, `timeoutTicks?` | Read clues, route and dig/emote, or answer after a configured cryptic NPC talk |
| `random-event-responder` | `preferredSkill?`, `answers?`, `fleeTiles?`, `timeoutTicks?` | Match prompt options; dismiss hostile events and flee |
| `diary-tracker` | `area?`, `refreshTicks?`, `timeoutTicks?` | Query diaries and expose the next incomplete easy task as a goal note |
| `gather-loop` | `node?` or `skill?`; `until:"inventory-full"|{count}`, `then:"stop"|"drop-all"|"bank"`, `bankAt?`, `itemName?` | Chop/mine repeatedly and choose end handling |
| `fish-loop` | `spot?`, `option`, `until`, `then`, `bankAt?` | Fish with an explicit spot option and end handling |
| `fletch-loop` | `product`, `amount`; `timeoutTicks?` | Run a bounded fletching recipe and fail on a non-completed stop |
| `herblore-loop` | `{action:"clean",item,amount?}` or `{action:"make",product,amount}`; `timeoutTicks?` | Clean a selected stack or make a bounded recipe |
| `loot` | `names?`, `radius?`, `max?` | Collect selected nearby piles using ground-item ids |
| `bank-run` | `bankAt`, `deposit:"all"|{names}|{items}|"none"`, `withdraw?` | Travel to a bank and perform a declared inventory plan |
| `trade` | `target`, `offer:[{item,amount}]`; `run?`, `timeoutTicks?` | Request, escrow, accept offer, re-confirm, and wait for completion |
| `talk` | `dialogue`, `choices?`, `maxNodes?` | Advance an authored dialogue; predeclare choice indexes when known |
| `sequence` | `steps:[{behaviour,params}]` | Compose bounded behaviours in order |
| `wait` | `ticks` | Yield safely for world progress |

Only one behaviour runs at a time. Starting with `replace:true` stops the current behaviour;
otherwise the new behaviour queues. Replace only when the new task should cancel existing work.

<!-- sources: src/core/reflex.ts, src/reflex/dsl.ts, src/reflex/ruleActions.ts, src/reflex/behaviours/index.ts -->
