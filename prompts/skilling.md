# Skilling

Skill actions are tick-driven; success rolls may miss. XP accumulates on
successful output; `xp-gained` and `level-up` show progress. Use current observations for live
node, spot, station, source, item, and product ids.

| Skill | Requirement and target | Command | Loop and stop conditions | XP feel |
| --- | --- | --- | --- | --- |
| Woodcutting | Required level; carry or equip the best usable axe; adjacent live tree node | `gather {node}` | Rolls every four ticks; stops if you move away, tool disappears, node depletes, or inventory fills | Higher level/tool improves success; harder trees require levels and award more XP |
| Mining | Required level; carry or equip usable pickaxe; adjacent rock/essence node | `gather {node}` | Ordinary ore rolls every four ticks, essence every three; same stops as woodcutting | Resource and tool tiers improve reward/success; each yield is one item |
| Fishing | Adjacent fishing-spot entity; matching option, level, tool, and bait | `fish {spot,option}` | Rolls every five ticks; spots do not deplete; stops without bait or space | First successful eligible fish in option order wins and awards its XP |
| Firemaking | Required level, tinderbox `590`, supported log, current tile unoccupied | `light {log}` | Log is consumed at start; rolls every three ticks until lit or stopped | A successful live fire awards XP and later expires |
| Cooking | Required level and raw item; adjacent live fire/range id | `cook {item,target}` | Fire attempts every four ticks, range every five; repeats until raw food is gone, output cannot fit, or stopped | Success gives cooked food and XP; failure gives burnt food without XP |
| Smithing: smelt | Required level/ores; furnace within one tile | `smelt {bar}` | Repeats every five ticks until materials/space end or stopped | Successful bars give Smithing XP; iron can fail after consuming ore |
| Smithing: forge | Required level/bars, hammer `2347`; anvil within one tile | `smith {product}` | Repeats every four ticks until bars/hammer/space end or stopped | XP scales with bars consumed |
| Crafting | Recipe level/materials; leather needs needle `1733` and thread `1734`, gems need chisel `1755`, spinning needs a wheel within one tile | `craft {product}` | Leather repeats every five ticks, gems every tick, spinning every four; stops on missing inputs/tool/space | Each completed product awards its recipe XP |
| Fletching | Product row, level, ingredients, and retained knife/chisel where required | `fletch {product,amount?}` | Recipe-specific 2–6 tick pulses; omitted amount makes the maximum up to 28 operations | `fletched` reports output amount and XP; use observed recipe evidence for valid products |
| Herblore | Grimy herb or recipe product, level, ingredients, and retained pestle where required | `clean-herb {item,amount?}` / `make-potion {product,amount?}` | Cleaning is one tick; recipes use 2 or 4 tick pulses; omitted amount makes the maximum up to 28 | `herb-cleaned` / `potion-made` report XP; use observed recipe evidence for valid products |
| Thieving: pickpocket | Supported adjacent NPC, required level, free space, not busy/stunned | `pickpocket {npc}` | One attempt; success gives XP/defined loot and a short lock; failure damages and stuns | Harder targets require higher levels and generally award more XP |
| Thieving: stall | Adjacent live stall id, required level, free space, available stock | `steal-stall {stall}` | Resolves after three ticks; caught or successful leaves stall empty until respawn | Success gives one reward and XP; caught gives neither |
| Agility | Required level; adjacent to the canonical start for the ordered course obstacle | `traverse {course,obstacle}` | Busy until resolution; success or failure moves you; successful full order awards lap XP | Obstacle XP plus course completion XP |
| Runecrafting | Matching ruin talisman/tiara, altar, essence and level | `enter-ruin`, then `craft-runes` | Entry teleports; one craft consumes all eligible loose essence | Multiple runes scale at level thresholds; XP is per essence |
| Farming | Adjacent patch, rake/dibber or spade, matching seed; compost is optional | `farm {patch,action,item?}` | Rake → compost empty patch → plant; wait for growth events, then harvest until empty | Actions and each harvested item award crop-specific XP |
| Hunter | Trap tool and level/limit, or required net/falcon/noose gear | `hunt {action,target?,item?}` | Laid traps catch/collapse on timers; check caught traps and re-lay returned tools | Successful checks/direct catches award reward and XP |
| Summoning | Pouch, required level and current points; obelisk for infusion | `summon {action,item?,...}` | One familiar follows until expiry/points; renew before expiry or dismiss | Infusion, summon, and supported specials award XP |
| Mining inspect | Live named mining node | `prospect {node}` | Instant; wait for `prospected` | Reveals the node's ore without gathering |

Use only a fishing option advertised by the spot. For runecrafting, use observed ruin/altar locs,
carry the matching talisman/tiara, and empty pouches before crafting.

## Loop discipline

Walk adjacent, start once, and watch production/stopped events. Use the matching `stop-*` command
when changing plans. Treat `inventory_full`, `depleted`, missing requirements, `stunned`, and
`busy` as world feedback; fix or wait, then restart deliberately.

For Farming, Hunter, and Summoning, treat `wrong_patch`, `patch_state`, `no_seed`, `patch_dead`,
`trap_limit`, `no_trap`, `trap_empty`, `hunter_level`, `no_familiar`, `familiar_active`,
`summoning_points`, `familiar_full`, and `wrong_obelisk` as state or prerequisite evidence.

<!-- sources: src/vendor/shared/simCommands.ts, src/vendor/shared/simEvents.ts -->
