# Actor commands

Payloads below omit your injected `entity`. Timing: **instant** resolves at application; **multi-tick**
starts later work; **mode** persists. An ack is not completion. After claiming, limit yourself to
64 parsed commands per real second.

## Movement

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `walk` |`{dest:{x,z,level}}`|multi-tick|Collision-aware path; one tile per tick|`no_world`, `unreachable`, `unknown_entity`|
| `run` |`{dest:{x,z,level}}`|multi-tick|Up to two tiles/tick; drains energy by distance and positive carried weight|`no_world`, `unreachable`, `out_of_energy`|
| `set-run` |`{enabled}`|mode|Sets whether later `walk` routes request running; zero energy downgrades to walking|`unknown_entity`, `invalid_set_run`|
| `move` |—|—|Not available to you: it is a no-pathing teleport reserved for authoring. Use `walk` or `run`.|`denied_command`|
| `climb` |`{at:{x,z,level},direction?:"up"|"down"}`|instant|Supply climb-loc anchor; same level, within one tile; direction required if ambiguous|`unknown_loc`, `not_adjacent`, `ambiguous_climb`, `no_destination`|
| `open-door` |`{at:{x,z,level},loc}`|instant|Original door placement/config; within one tile of current leaf|`unknown_door`, `not_adjacent`, `no_world`|
| `traverse` |`{course,obstacle}`|multi-tick|Known course/index and level; adjacent to that obstacle's canonical start; success/failure moves you|`unknown_course`, `unknown_obstacle`, `level_too_low`, `not_adjacent`, `busy`|

## Combat, prayer, and food

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `attack` |`{target}`|multi-tick|Live combatant; wilderness PvP also checks both players, level range, safe and single-way zones|`unknown_entity`, `pvp_disabled`, `not_in_wilderness`, `wilderness_level`, `safe_zone`, `single_combat`|
| `disengage` |`{}`|instant|Clears your outgoing engagement|`unknown_entity`|
| `cast` |`{target,spell}`|multi-tick|Any entity spell; level/runes/weapon rules; one-shot needs no staff; persists configuration|`unknown_spell`, `wrong_spell_target`, `requires_weapon`, `level_too_low`, `no_runes`, combat nacks|
| `switch-spellbook` |`{book:"modern"|"ancient"}`|instant|Free; Ancient Rush/Blitz only|`invalid_switch_spellbook`; later casts may nack `wrong_spellbook`|
| `cast-self` |`{spell}`|instant|Self spell: teleport, bones conversion, Charge, or Home Teleport|`unknown_spell`, `wrong_spell_target`, `teleport_cooldown`, `not_convertible`, `level_too_low`, `no_runes`|
| `cast-on-item` |`{spell,slot}`|instant|Item spell on an occupied inventory slot: alchemy, superheat, or enchant|`unknown_spell`, `wrong_spell_target`, `empty_slot`, `not_alchemisable`, `not_enchantable`, `not_superheatable`, `level_too_low`, `no_runes`|
| `cast-on-ground` |`{spell,groundItem}`|instant|Ground-item spell; Telekinetic Grab reaches ten tiles|`unknown_spell`, `wrong_spell_target`, `not_found`, `not_owner`, `too_far`, `inventory_full`, `level_too_low`, `no_runes`|
| `set-style` |`{style,attackStyle,spell?}`|mode|Legal pair; magic spell must target an entity; autocast requires an equipped staff and an autocastable spell|`invalid_attack_style`, `invalid_spell`, `spell_requires_magic`, `requires_weapon`, `unknown_spell`|
| `set-retaliate` |`{enabled}`|mode|Live player|`unknown_entity`, `invalid_set_retaliate`|
| `pray` |`{prayer}`|mode|Known prayer, required levels and points; toggles it|`unknown_prayer`, `level_too_low`, `no_points`|
| `bury` |`{item}`|instant|Own one recognized bone item|`missing_item`, `not_bones`, `unknown_config_id`|
| `eat` |`{item}`|instant|Own supported food; cooldown clear|`missing_item`, `not_edible`, `eat_cooldown`|
| `drink` |`{item}`|instant|Own one supported potion dose; replaces it with the next dose/vial; three-tick delay|`missing_item`, `invalid_drink`, `busy`|
| `special` |`{enabled}`|mode|Arm the equipped weapon's special for the next eligible melee/ranged swing|`special_energy`, `no_special`|

## Zones, death, and runecrafting

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `craft-runes` |`{altar:{at:{x,z,level},loc}}`|multi-tick|One-shot altar craft resolving after one tick|`no_altar`, `too_far`, `missing_item`, `level_too_low`|
| `enter-ruin` |`{ruin:{at:{x,z,level},loc}}`|instant|Enter an adjacent ruin with its matching talisman or equipped tiara|`no_altar`, `too_far`, `wrong_talisman`|
| `fill-pouch` |`{pouch}`|instant|Move carried essence into the pouch|`missing_item`, `pouch_full`, `pouch_degraded`|
| `empty-pouch` |`{pouch}`|instant|Move pouch essence into inventory|`missing_item`, `pouch_empty`, `inventory_full`|
| `bless-grave` |`{grave}`|instant|Another player's adjacent, unblessed grave gains 60 ticks|`unknown_entity`, `too_far`, `not_owner`|

## Gathering and production

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `gather` |`{node}`|multi-tick|Live adjacent node; skill level and usable axe/pickaxe|`unknown_node`, `not_adjacent`, `missing_tool`, `depleted`, `inventory_full`, `busy`|
| `stop-gather` |`{}`|instant|Idempotently cancels gathering|`unknown_entity`|
| `fish` |`{spot,option}`|multi-tick|Adjacent fishing-spot entity; option, level, tool, bait|`invalid_option`, `too_far`, `missing_tool`, `missing_bait`, `level_too_low`, `busy`|
| `stop-fish` |`{}`|instant|Idempotently cancels fishing|`unknown_entity`|
| `light` |`{log}`|multi-tick|Log and tinderbox; current tile free|`unknown_log`, `missing_tinderbox`, `missing_log`, `tile_occupied`, `level_too_low`, `busy`|
| `cook` |`{item,target:{kind:"fire"|"range",id}}`|multi-tick|Raw food; live heat source within one tile|`unknown_cookable`, `no_heat_source`, `too_far`, `missing_raw`, `level_too_low`, `busy`|
| `stop-cook` |`{}`|instant|Idempotently cancels cooking|`unknown_entity`|
| `smelt` |`{bar}`|multi-tick|Recipe materials; furnace within one tile|`unknown_recipe`, `too_far`, `missing_materials`, `level_too_low`, `busy`|
| `smith` |`{product}`|multi-tick|Bars and hammer; anvil within one tile|`unknown_recipe`, `too_far`, `missing_materials`, `missing_hammer`, `level_too_low`, `busy`|
| `stop-smith` |`{}`|instant|Cancels smelting or forging|`unknown_entity`|
| `craft` |`{product}`|multi-tick|Recipe materials/tool; spinning needs wheel within one tile|`unknown_recipe`, `too_far`, `missing_materials`, `missing_tool`, `level_too_low`, `busy`|
| `stop-craft` |`{}`|instant|Idempotently cancels crafting|`unknown_entity`|
| `fletch` |`{product,amount?}`|multi-tick|Makes the selected fletching product, optionally up to an amount|`invalid_product`, `invalid_amount`, `missing_ingredient`, `missing_tool`, `level_too_low`, `busy`|
| `stop-fletch` |`{}`|instant|Idempotently cancels fletching|`unknown_entity`|
| `clean-herb` |`{item,amount?}`|multi-tick|Cleans the selected herb, optionally up to an amount|`invalid_product`, `invalid_amount`, `missing_ingredient`, `level_too_low`, `busy`|
| `make-potion` |`{product,amount?}`|multi-tick|Makes the selected potion, optionally up to an amount|`invalid_product`, `invalid_amount`, `missing_ingredient`, `missing_tool`, `level_too_low`, `busy`|
| `stop-herblore` |`{}`|instant|Idempotently cancels herblore|`unknown_entity`|
| `pickpocket` |`{npc}`|multi-tick|Adjacent supported NPC; level, space, not stunned/busy|`unknown_target`, `too_far`, `level_too_low`, `stunned`, `inventory_full`, `busy`|
| `steal-stall` |`{stall}`|multi-tick|Adjacent live stall station; level, stock, space|`unknown_stall`, `too_far`, `stall_empty`, `level_too_low`, `stunned`, `inventory_full`, `busy`|

## Farming and Hunter

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `farm` |`{patch:{at:{x,z,level},loc},action:"rake"|"plant"|"compost"|"water"|"harvest"|"check-health"|"clear"|"pay"|"inspect",item?}`|multi-tick|Work the identified farming patch; plant may name a seed item|`wrong_patch`, `patch_state`, `no_seed`, `patch_dead`|
| `hunt` |`{action:"lay-trap"|"check-trap"|"dismantle"|"net"|"catch"|"track",target?,item?}`|multi-tick|Manage traps or hunt using an optional interaction target/item|`trap_limit`, `no_trap`, `trap_empty`, `hunter_level`|
| `prospect` |`{node}`|instant|Identify the ore yielded by a named mining node|`unknown_node`|

## Summoning, minigames, and activities

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `summon` |`{action:"summon"|"dismiss"|"renew"|"call"|"special"|"store"|"withdraw"|"infuse",item?,slot?,amount?,scroll?}`|multi-tick|Manage one familiar; infusing pouches resolves at an obelisk|`no_familiar`, `familiar_active`, `summoning_points`, `familiar_full`, `wrong_obelisk`|
| `minigame` |`{action:"join"|"leave"|"ready"|"stake"|"accept"|"decline"|"forfeit",game,options?}`|instant|Includes Duel, Fight Caves, Barrows, Pest Control, Mage Training Arena, Pyramid Plunder, and Sorceress's Garden; await lifecycle/events|`no_lobby`, `lobby_full`, `not_ready`, `game_in_progress`, `stake_mismatch`|
| `clue` |`{action:"read"|"dig"|"emote"|"answer"|"open-casket",item?,answer?,emote?}`|instant|Advance an active clue|`no_clue`, `wrong_location`, `wrong_emote`, `wrong_answer`|
| `diary` |`{area?}`|instant|Emit diary progress|`diary_locked`|
| `champion` |`{action:"challenge"|"accept",scroll?}`|instant|Manage champion challenge|`no_scroll`, `wrong_location`, `champion_rule`|
| `random-event` |`{action:"respond"|"dismiss",answer?,choice?}`|instant|Handle active event|`no_event`, `event_active`, `wrong_answer`|
| `vote` |`{poll,target}` (`target` may be null)|instant|Cast or clear a ballot in an open poll|`no_poll`, `not_eligible`, `poll_closed`, `invalid_target`|

Scenario prose arrives as global `scenario-message` or recipient-only `scenario-notice` deltas.

## Items and economy

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `equip` |`{slot}`|instant|Zero-based occupied inventory slot; requirements/capacity pass|`empty_slot`, `not_equippable`, `level_too_low`, `not_enough_space`|
| `unequip` |`{slot:"head"|"cape"|"neck"|"weapon"|"body"|"shield"|"legs"|"hands"|"feet"|"ring"|"ammo"}`|instant|Named equipment slot occupied; inventory has space|`not_equipped`, `inventory_full`|
| `drop` |`{slot}`|instant|Drops the complete stack in an occupied inventory slot|`empty_slot`, `invalid_inventory_slot`|
| `give` |`{item,amount}`|instant|Positive amount; cache-backed world; mints what fits and reports overflow, never transfers|`unknown_config_id`, `unknown_entity`, `no_world`|
| `pickup` |`{groundItem}`|instant|Visible live pile; stand on its exact tile; inventory space|`not_found`, `not_adjacent`, `not_owner`, `inventory_full`|
| `interact` |`{target,option}`|multi-tick|Adjacent advertised option on NPC/player/ground-item/loc; universal interaction verb|`unknown_entity`, `unknown_loc`, `not_found`, `too_far`, `unknown_option`, `no_handler`|
| `use-item-on` |`{slot,target}`|multi-tick|Occupied slot; adjacent handled target|`empty_slot`, `unknown_entity`, `unknown_loc`, `not_found`, `too_far`, `no_handler`|
| `shop-view` |`{npc}`|instant|Live shop NPC on same level within two tiles|`no_shop`, `too_far`, `unknown_entity`|
| `shop-buy` |`{npc,item,amount}`|instant|View first; stock, funds, and inventory space|`no_shop`, `too_far`, `insufficient_stock`, `insufficient_funds`, `inventory_full`|
| `shop-sell` |`{npc,item,amount}`|instant|View first; own tradeable item; shop capacity|`no_shop`, `too_far`, `missing_item`, `not_tradeable`, `not_stocked`, `shop_full`, `cannot_sell_currency`|
| `ge-view` |`{npc}`|instant|Live GE clerk on same level within two tiles; views all six slots|`no_exchange`, `too_far`|
| `ge-price` |`{item}`|instant|Exchange available; returns the instance-local guide price|`no_exchange`|
| `ge-offer` |`{npc,kind,item,quantity,price}`|instant|GE clerk within two tiles; `kind` is `buy` or `sell`; positive quantity/price, escrow, and free slot required|`no_exchange`, `too_far`, `exchange_full`, `price_too_high`, `not_tradeable`, `insufficient_funds`, `missing_item`|
| `ge-abort` |`{npc,slot}`|instant|GE clerk within two tiles; slot contains your open offer|`no_exchange`, `too_far`, `no_offer`, `offer_not_open`|
| `ge-collect` |`{npc,slot,noted?:boolean}`|instant|GE clerk within two tiles; collect box nonempty; `noted:true` requests non-coin notes|`no_exchange`, `too_far`, `no_offer`, `nothing_to_collect`, `inventory_full`, `not_noteable`|
| `bank-deposit` |`{item,amount}`|instant|Bank within two tiles; own full requested amount|`no_bank_nearby`, `missing_item`, `bank_full`|
| `bank-withdraw` |`{item,amount,noted?:boolean}`|instant|Bank within two tiles; stored base amount and delivered-form space|`no_bank_nearby`, `insufficient_bank`, `inventory_full`, `not_noteable`|
| `trade-request` |`{target}`|instant|Adjacent player; reciprocal live requests open one session|`unknown_entity`, `invalid_target`, `too_far`, `trade_busy`|
| `trade-offer` |`{slot,amount}`|instant|Escrows up to the available slot amount; any offer change resets accepts|`no_trade`, `empty_slot`, `not_tradeable`, `trade_full`|
| `trade-remove` |`{item,amount}`|instant|Returns up to that item amount from your escrow|`no_trade`, `empty_slot`|
| `trade-accept` |`{}`|instant|Accept offer, review fixed offers, then accept again at confirm|`no_trade`, `trade_full`|
| `trade-decline` |`{}`|instant|Declines the active trade|`no_trade`|

## Dialogue

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `talk` |`{dialogue}`|instant|Dialogue id exists in this scenario|`no_scenario`, `unknown_dialogue`|
| `talk-to` |`{npc}`|instant|Live NPC has a bound dialogue tree|`no_scenario`, `no_dialogue`, `quest_locked`, `quest_requirements`|
| `dialogue-advance` |`{choice?}`|instant|Active dialogue; omit at ordinary node, use zero-based option index at choice|`no_dialogue`, `choice_required`, `invalid_choice`|
| `quest-journal` |`{}`|instant|Returns quest stages and total quest points|`no_scenario`|

## Slayer

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `slayer-task` |`{master}`|instant|Request a task from a live Slayer master|`no_task`, `task_active`, `slayer_level`|
| `slayer-reward` |`{master,reward}`|instant|Buy a named reward from a live master|`insufficient_points`, `slayer_level`|

## Transport

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `travel` |`{network,from?:{at:{x,z,level},loc},code?,destination?,item?}`|multi-tick|Use a fairy ring, ship, charter, glider, spirit tree, canoe, jewellery, or tablet route|`unknown_destination`, `locked_destination`, `no_fare`, `no_charges`|

## Social

|type|payload (without entity)|timing|preconditions & reach|common nacks|
|---|---|---|---|---|
| `say` |`{text}`|instant|Send public chat under the actor display name|`muted`, `text_too_long`|
| `pm` |`{to,text}`|instant|Send private chat to a display name or actor tag|`unknown_player`, `ignored`, `muted`, `text_too_long`|
| `friend` |`{name,action:"add"|"remove"|"ignore"|"unignore"}`|instant|Update the actor's friends or ignore lists|`unknown_player`|
| `clan` |`{action:"create"|"join"|"leave"|"kick"|"rank"|"chat",name?,member?,rank?,text?}`|instant|Manage clan membership or send clan chat|`no_clan`, `clan_exists`, `clan_rank`, `muted`, `text_too_long`|

Public `say` reaches players within 15 tiles. `pm` is visible only to you and the resolved recipient;
clan chat is visible only to current clan members. Incoming lines appear in the observation's recent
chat section. Use `say` or `pm` to answer in-world speech instead of the harness mailbox.

## Typical sequences

- Combat loot: `walk` into reach → `attack` once → wait for `died` → walk onto the pile →
  `pickup` by ground-item id → `bury` bones from inventory.
- Player trade: reciprocal request → offers → both accept → re-check fixed offers → both confirm.
- Fletching/Herblore: select a documented recipe output → issue one bounded `fletch` or
  `make-potion` (or `clean-herb`) → wait for production and terminal stopped events; do not restart
  unchanged after `missing_ingredient` or `missing_tool`.
- Special: equip a registered weapon → `special {enabled:true}` → `attack` once → wait for
  `special-attack`; energy drains on the swing and the toggle clears.
- Runecrafting: carry matching talisman/tiara → enter the observed ruin → walk to its altar →
  `craft-runes`; `empty-pouch` first for pouch-held essence.
- Farming: stand adjacent → rake weeds → compost the empty patch if desired → plant the matching
  seed → wait for `patch-changed:grown` → harvest until the patch becomes empty.
- Hunter: `lay-trap` up to your level limit → wait for `trap-caught` → `check-trap` by its NPC-kind
  entity id → re-lay the returned tool. Summon one familiar from a pouch and renew before expiry.
- Minigame: join the exact game/options → ready in its lobby → react to started/game/end events.
- Poll: wait for `poll-opened` → `vote` once or revise it → treat only `poll-closed` as final.

<!-- sources: src/vendor/shared/simCommands.ts, src/vendor/shared/simEvents.ts -->
