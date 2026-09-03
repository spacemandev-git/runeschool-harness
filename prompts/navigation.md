# Navigation

## Read the map

Use `{x,z,level}` tiles. East increases `x`; west decreases it. North increases `z`; south
decreases it. Observation compass labels combine these directions: `N`, `NE`, `E`, `SE`, `S`,
`SW`, `W`, `NW`. Another `level` is another plane even when `x,z` match.

Chebyshev distance is the larger of the absolute x/z differences. Most adjacent interactions allow
distance one on the same level, including diagonals, but pickup requires the exact pile tile and
some services allow greater reach. Trust the command-specific rule. Observed `options` are live
affordances: prefer the universal `interact {target,option}` command for an advertised NPC,
player, ground-item, or loc option, and do not invent an absent option. `unknown_option` calls for
a refreshed observation; `no_handler` is terminal unless the world changes.

## Move deliberately

| Action | Behavior |
| --- | --- |
| `walk {dest}` | Collision-aware route, one tile per tick |
| `run {dest}` | Same routing, up to two tiles per tick; drains run energy faster with positive weight |
| `move {at}` | Immediate direct placement without pathfinding; use only when that actor tool is appropriate |

An accepted walk/run replaces the current route and advances on later ticks. `unreachable` means no
valid route or invalid destination; choose another reachable tile, approach from another side, or
inspect collision-changing obstacles. `too_far` means the movement may be fine but the requested
interaction is outside its reach: walk closer before retrying.

After starting movement, compare positions across observations. Use a five-tick “am I still
walking?” check: if several ticks pass without any movement, treat the route as stuck even if the
original command was accepted. Re-path from the current tile or choose a different target; do not
keep resending the same route.

`set-run {enabled:true}` makes later `walk` routes request running. Run energy is 0–100, regenerates
while not running according to base Agility, and turns run mode off at zero. An explicit `run` with
zero energy nacks `out_of_energy`; otherwise a route can downgrade to walking when energy runs out.
Negative equipped weight can offset carried weight, but inventory weight never contributes below zero.

In wilderness, increasing `z` moves deeper north and raises the wilderness level every eight rows.
Moving south lowers PvP exposure. Watch zone tags and nearby players; safe zones deny combat.

## Transport networks

`travel` selects one of `fairy-ring`, `ship`, `charter`, `glider`, `spirit-tree`, `canoe`,
`jewellery`, or `tablet`. Walk adjacent to a supplied `from:{at,loc}` before sending it. Fairy
rings use `code`; other networks use an exact `destination`; jewellery/tablets also use the carried
or equipped item ID. Requirements can include fares, charges, equipment, skill/quest flags, and
valid source/destination pairs. Wait for `travelled`; an accepted command starts a multi-tick trip.
Treat `travel-denied` and `unknown_destination`, `locked_destination`, `no_fare`, or `no_charges`
as route/prerequisite evidence.

## Doors and levels

Routes do not auto-open doors. If a closed mapped door blocks you, stand adjacent and use
`open-door` with the observed original `at` and loc config id. The command toggles the door, so do
not blindly repeat it. Double doors toggle together; an opened map-placed-closed door automatically
restores after 500 simulation ticks unless toggled first.

Walking never changes `level`. To use stairs or a ladder, stand within one tile of its footprint and
send `climb` with the observed anchor. Supply `up` or `down` when both directions exist; a one-way
climb can infer it. Success teleports immediately to a standable tile by the paired loc and stops
queued movement.

## Find distant targets

Nearby observations are radius-limited. Use `scan` for a case-insensitive instance-wide search of
entities, nodes, stations, and ground items; results include distance from you. Use it for a distant
NPC, bank, furnace, fishing spot, node, or named item. Region-backed scans are available across the
loaded instance, but a result still needs a current reach check after you travel. Refresh before
acting because live entity and ground-item ids can change.

<!-- sources: src/vendor/shared/simCommands.ts, src/vendor/shared/zones.ts, src/core/percept.ts, src/reflex/behaviours/walkTo.ts -->
