# Items and economy

## Inventory and equipment

Inventory has 28 slots. Non-stackables use one each; a stackable item uses one stack.
`inventory_full` means bank, drop, sell, or otherwise free slots before retrying.

`equip {slot}` uses the zero-based inventory slot index, not an item id. Equipment slots are
`head`, `cape`, `neck`, `weapon`, `body`, `shield`, `legs`, `hands`, `feet`, `ring`, and `ammo`.
Wield requirements can reject an item. Two-handed weapons and shields can displace each other, so
capacity is checked first. `unequip {slot}` uses the equipment-slot name and needs inventory space.

## Ground items

A ground pile has its own live ground-item id, item config id, amount, tile, and sometimes owner.
Use the live pile id for `pickup`, and stand on its exact tile. A private pile is visible/pickable
only to its owner until revealed. Ordinary owned drops are private for 100 ticks and ordinary piles
despawn after 200 ticks. Scenario piles may instead respawn after pickup.

`drop {slot}` removes the complete stack in one inventory slot and creates a pile on your tile.
`give {item,amount}` is not player trade: it mints items into your own inventory in a cache-backed
world and reports any overflow.

## Player trading

Both adjacent players send `trade-request`. `trade-offer {slot,amount}` moves items into escrow;
every change resets accepts. Both players `trade-accept`, inspect the fixed confirm offers, then
`trade-accept` a second time. Trust only `trade-completed`; `trade-declined` returns escrow.
Walking apart, disconnecting, declining, or final capacity failure cancels. For `trade_full`, use
its capacity details to free slots or reduce the offer.

## Banks

Your bank has 496 stack-all slots: even non-stackable items share one bank slot per item id. You
must be on the same level within Chebyshev distance two of a bank booth or chest.

| Command | Key | Rule |
| --- | --- | --- |
| `bank-deposit` | item config id + amount | You must own the full amount; destination must fit |
| `bank-withdraw` | item config id + amount | Bank must hold the full amount; inventory must fit normal stacking rules |

Bank commands use item ids, never inventory slot indexes. A bank belongs to one player in one
instance; it is not cross-instance storage.

### Notes

Banks store every note as its unnoted base item. Use `bank-withdraw {item,amount,noted:true}` to
carry bulk non-stackables in one note stack; items without a note form return `not_noteable`.
Shops and the Grand Exchange accept held notes, and `ge-collect {npc,slot,noted:true}` can return
non-coin proceeds as notes.

## Shops and coins

Stand on the same level within Chebyshev distance two of the shop NPC. Call `shop-view` first. Its
result identifies the shop currency and current stock, including live unit buy/sell prices. Then
use the same live NPC entity id with `shop-buy` or `shop-sell`; the transaction is atomic.

Coins are item `995`, but a shop may define another currency; always trust the view's `currency`. Buying spends
currency and needs stock plus inventory space. Selling removes owned tradeable items and pays the
shop currency. General stores accept tradeable non-stock items until player-stock capacity fills;
specialty shops reject items they do not stock. You cannot sell a shop its own currency. Prices can
change with stock, so refresh the view before a large decision.

## Grand Exchange

Prefer the Grand Exchange for tradeable items when a shop lacks stock, will not buy the item, or
its live price is less useful; use a shop when its displayed stock and price make an immediate
transaction preferable. The five clerk config IDs are `6528`–`6532` in the Varrock exchange near
`x=3164,z=3489`. Stand on the same level within two tiles of a live clerk for clerk commands.

Use `ge-view {npc}` to inspect your six slots and `ge-price {item}` for the instance-local guide
price. Place `ge-offer {npc,kind,item,quantity,price}` with `kind` equal to `buy` or `sell`. A buy at
or above guide price, or a sell at or below it, is eligible for the bot market after at least 5
ticks; another player's compatible offer is matched first and may fill earlier. Bot fills use your
offer price. Guide prices begin at item value, change only after player trades, and are not changed
by bot fills.

Placement escrows all `quantity * price` coins for a buy or all offered items for a sell. Filled
items, sale coins, and any applicable buyer refund remain in the slot's collect box until
`ge-collect {npc,slot}` moves what fits into inventory. Use `ge-abort {npc,slot}` only on an open
offer; its unfilled escrow also moves to the collect box. Collection may be partial. A slot stays
occupied while its offer is open or its collect box is nonempty, so collect completed or aborted
slots before reusing the six-slot allowance.

Utility magic is instant. Use `cast-self`: Home Teleport is level 1, free, and has a 3000-tick
(30-minute) cooldown; rune lists are Varrock 25 (1 fire/3 air/1 law), Lumbridge 31 (1 earth/3
air/1 law), Falador 37 (1 water/3 air/1 law), Camelot 45 (5 air/1 law), Ardougne 51 (2 water/2
law), Watchtower 58 (2 earth/2 law), Trollheim 61 (2 fire/2 law), and Ape Atoll 64 (2 fire/2
water/2 law/1 banana). `cast-on-item` Low/High Alchemy yields 40%/60% of item value with a
five-tick delay; superheat turns ore into a bar; enchant turns gem jewellery into its enchanted
form. Bones-to-Bananas/Peaches converts carried bones. `cast-on-ground` Telekinetic Grab picks up a
ground item within ten Chebyshev tiles.

<!-- sources: src/vendor/shared/simCommands.ts, src/vendor/shared/simEvents.ts -->
