# Combat

## Configure and engage

- `melee`: `accurate`/`aggressive`/`controlled`/`defensive`; same-level Chebyshev reach one.
- `range`: `range-accurate`/`rapid` reach seven, `longrange` nine; compatible ammo normally required.
- `magic`: `cast`/`defensive-cast`; reach ten; valid spell, Magic level, and runes required.

Use `set-style`, then `attack` once for automatic swings; `cast` selects magic and engages.
Launched misses still spend ammo/runes. `disengage` stops; `set-retaliate` changes default-on
retaliation.

Ranged/magic need projectile line of sight. On `swing-blocked`, reposition for a clear angle;
blocked launches spend no ammo, runes, or cooldown. Recoverable player ammo lands owner-private on
the target tile: move onto it and `pickup` your arrows/bolts when safe. Enchanted bolts can proc
damage, Prayer drain, poison, HP sacrifice, accuracy, or healing; `bolt-proc` names the effect.

## Magic

Autocast needs a staff; one-shot `cast` does not. Staves/combination runes supply elements. Curses
drain stats; binds block movement, not attacks. Some spells require a named staff, Slayer level, or
undead target. Defensive casting adds Defence XP.

`switch-spellbook {book:"ancient"}` enables single-target Rush/Blitz spells. Ice freezes on accurate
impact: hold a target at range or create space to escape. Frozen targets still attack/cast, and
bind immunity delays re-freezing.

## Hitpoints and food

`eat {item}` heals to max and starts a three-tick cooldown without delaying attacks. Eat early;
lobster heals 12 and swordfish 14.

## Prayer

`pray` toggles boosts or one protection prayer; matching protection zeros NPC hit damage. Active
prayers drain together. `bury` gives XP, not points; `smite` has no effect.

## Status, potions, and specials

Poison periodically damages and declines; antipoison cures and grants immunity. `drink {item}` can
boost/restore/heal and has a three-tick delay.

Dragonfire is `dragonfire`/`damaged`, not `hit`. At melee range, shield + antifire gives immunity;
either alone sharply reduces breath. Protect from Magic stacks but is weaker; Protect from Melee
does nothing.

Special energy starts at 100 and regenerates 10/50 ticks. With an eligible melee/ranged weapon,
send `special {enabled:true}` before `attack`; the swing spends its cost and clears the toggle.
`special_energy` means wait; ineligible gear performs an ordinary swing.

## Wilderness risk

Wilderness PvP requires both players inside and a level difference within the lower wilderness
level. `safe` denies; `multi` permits many opponents. An unprovoked attack skulls for 2,000 ticks:
death keeps zero items instead of three. Flee south before risking valuables.

## Death and observations

A `hit` names attacker, target, style, damage, and health; projectiles arrive later and magic may
`splash`. Zero still triggers retaliation. Stop targeting on `died` and inspect loot.

On death, value-ranked gear keeps three unskulled or none skulled. PvP losses become killer-owned;
others enter a 200-tick grave blessable once for 60. Respawn takes six ticks and restores HP/prayer.
Inspect `items-lost-on-death`.

## Slayer

`slayer-task {master}` uses a live master and reports accepted NPC IDs/count. Only attributed kills
count. Slayer/protection gates apply without a task. On `task_active`, `slayer_level`, or `no_task`,
replan. Check points before `slayer-reward {master,reward}`.

<!-- sources: src/vendor/shared/simCommands.ts, src/vendor/shared/simEvents.ts, src/vendor/shared/zones.ts, src/vendor/magic/spellbook.ts, src/reflex/behaviours/fight.ts -->
