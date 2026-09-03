import type { PerceptDelta, WorldSnapshot } from '../core/index.ts';
import type { Activity } from '../core/percept.ts';
import type { TileCoord } from '#protocol';
import type { DetailedPerceptDelta } from './differ.ts';

export type NameLookup = (kind: 'item' | 'npc' | 'loc', id: number) => string | undefined;

function direction(from: TileCoord, to: TileCoord): string {
  const east = Math.sign(to.x - from.x);
  const north = Math.sign(to.z - from.z);
  if (east === 0 && north === 0) return 'here';
  return `${north > 0 ? 'N' : north < 0 ? 'S' : ''}${east > 0 ? 'E' : east < 0 ? 'W' : ''}`;
}

function distance(from: TileCoord, to: TileCoord): number {
  return from.level === to.level
    ? Math.max(Math.abs(from.x - to.x), Math.abs(from.z - to.z))
    : Number.POSITIVE_INFINITY;
}

function entityName(delta: DetailedPerceptDelta, entity: number): string {
  const name = delta._details?.nearbyNames[String(entity)];
  return name === undefined ? `entity#${entity}` : `${name.toLowerCase()}#${entity}`;
}

function itemName(item: number, supplied: string | undefined, nameOf: NameLookup): string {
  return supplied ?? nameOf('item', item) ?? `item#${item}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function targetText(target: unknown): string {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return 'unknown target';
  const value = target as Record<string, unknown>;
  if ((value.kind === 'npc' || value.kind === 'player' || value.kind === 'ground-item') && typeof value.id === 'number') {
    return `${value.kind}#${value.id}`;
  }
  if (value.kind === 'loc' && typeof value.loc === 'number') return `loc#${value.loc}`;
  return 'unknown target';
}

function offerText(value: unknown, nameOf: NameLookup): string {
  if (!Array.isArray(value) || value.length === 0) return 'nothing';
  return value.flatMap((entry): string[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const offer = entry as Record<string, unknown>;
    return typeof offer.item === 'number' && typeof offer.amount === 'number'
      ? [`${itemName(offer.item, undefined, nameOf)}×${offer.amount}`]
      : [];
  }).join(', ') || 'nothing';
}

function itemAmounts(value: unknown, nameOf: NameLookup): string {
  if (!Array.isArray(value) || value.length === 0) return 'nothing';
  return value.flatMap((entry): string[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    return typeof item.item === 'number' && typeof item.amount === 'number'
      ? [`${itemName(item.item, undefined, nameOf)}×${formatNumber(item.amount)}`]
      : [];
  }).join(', ') || 'nothing';
}

function stringList(value: unknown): string {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value.join(', ') || 'none'
    : 'none';
}

function entityList(value: unknown): string {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number')
    ? value.map((entry) => `entity#${entry}`).join(', ') || 'none'
    : 'none';
}

function voteCounts(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'no target votes';
  return value.flatMap((entry): string[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const count = entry as Record<string, unknown>;
    return typeof count.target === 'number' && typeof count.votes === 'number'
      ? [`entity#${count.target} ${count.votes}`]
      : [];
  }).join(', ') || 'no target votes';
}

function detailText(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(detailText).join(', ');
  if (typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${key} ${detailText(entry)}`)
    .join(', ');
}

function questJournalText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'no quests';
  return value.flatMap((entry): string[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const quest = entry as Record<string, unknown>;
    return typeof quest.name === 'string' && typeof quest.stage === 'number'
      ? [`${quest.name} stage ${quest.stage}${quest.complete === true ? ' complete' : ''}`]
      : [];
  }).join('; ') || 'no quests';
}

function waveEventLine(
  event: PerceptDelta['events'][number],
  nameOf: NameLookup,
  delta: DetailedPerceptDelta
): string | undefined {
  const data = event.data as unknown as Record<string, unknown>;
  switch (event.type) {
    case 'chat': {
      const channel = data.channel === 'pm' ? 'PM' : data.channel === 'clan' ? `Clan ${String(data.clan)}` : 'Public';
      return `${channel} chat — ${String(data.name)}: "${String(data.text)}"`;
    }
    case 'swing-blocked':
      return `Line of sight blocks ${entityName(delta, Number(data.attacker))} → ${entityName(delta, Number(data.target))}`;
    case 'hit': {
      const spell = typeof data.spell === 'string' ? ` ${data.spell}` : '';
      const splash = data.splash === true ? ', splash' : '';
      return `${entityName(delta, Number(data.attacker))} hits ${entityName(delta, Number(data.target))} for ${String(data.damage)} (${String(data.style)}${spell}${splash})`;
    }
    case 'bolt-proc':
      return `Bolt proc ${String(data.effect)} (${itemName(Number(data.bolt), undefined, nameOf)}): ${entityName(delta, Number(data.attacker))} → ${entityName(delta, Number(data.target))}`;
    case 'dragonfire': {
      const mitigated = Array.isArray(data.mitigated) && data.mitigated.length > 0
        ? ` (${data.mitigated.join('+')})`
        : '';
      return `${entityName(delta, Number(data.attacker))} breathes fire on ${entityName(delta, Number(data.target))} for ${String(data.damage)}${mitigated}`;
    }
    case 'spell-effect': {
      if (data.effect !== 'bind') return undefined;
      const target = Number(data.target);
      return delta._details?.nearbyNames[String(target)] === undefined
        ? `You are frozen (${String(data.ticks)} ticks)`
        : `${entityName(delta, target)} is frozen (${String(data.ticks)} ticks)`;
    }
    case 'poll-opened': return `Poll ${String(data.poll)} opened: eligible ${entityList(data.eligible)}${typeof data.closesAtTick === 'number' ? `; closes tick ${data.closesAtTick}` : ''}`;
    case 'vote-cast': return `Vote ${String(data.poll)}: entity#${String(data.entity)} ${typeof data.target === 'number' ? `voted for entity#${data.target}` : 'abstained'}`;
    case 'vote-tally': return `Poll ${String(data.poll)} tally: ${voteCounts(data.counts)}; ${String(data.abstentions)} abstained; ${String(data.eligible)} eligible`;
    case 'poll-closed': return `Poll ${String(data.poll)} closed (${String(data.reason)}): ${typeof data.winner === 'number' ? `winner entity#${data.winner}` : 'no winner'}`;
    case 'actor-eliminated': return `Actor ${String(data.actorTag)} eliminated (entity#${String(data.entity)})${typeof data.killer === 'number' ? ` by entity#${data.killer}` : ''}`;
    case 'scenario-notice': return `Notice: ${String(data.text)}`;
    case 'team-won': return `Team ${String(data.team)} won (objective ${String(data.objective)})`;
    case 'team-lost': return `Team ${String(data.team)} lost (objective ${String(data.objective)})`;
    case 'scenario-teleported': {
      const to = data.to as Record<string, unknown> | undefined;
      return `Scenario teleported entity#${String(data.entity)}${to === undefined ? '' : ` to (${String(to.x)},${String(to.z)},${String(to.level)})`}`;
    }
    case 'interacted': return `Interacted: ${String(data.option)} on ${targetText(data.target)} (${String(data.handler)})`;
    case 'item-used': return `Used ${typeof data.item === 'number' ? itemName(data.item, undefined, nameOf) : 'item'} on ${targetText(data.target)} (${String(data.handler)})`;
    case 'trade-requested': return `Trade requested: entity#${String(data.entity)} → entity#${String(data.target)}`;
    case 'trade-opened': return `Trade opened: entity#${String(data.a)} ↔ entity#${String(data.b)}`;
    case 'trade-updated': return `Trade offer: entity#${String(data.entity)} offers ${offerText(data.offer, nameOf)}`;
    case 'trade-stage': return `Trade stage: ${String(data.stage)} (entity#${String(data.a)} ↔ entity#${String(data.b)})`;
    case 'trade-completed': return `Trade completed: entity#${String(data.a)} gave ${offerText(data.aGave, nameOf)}; entity#${String(data.b)} gave ${offerText(data.bGave, nameOf)}`;
    case 'trade-declined': return `Trade ended with entity#${String(data.partner)}: ${String(data.reason)}`;
    case 'fletched': return `Fletched ${String(data.amount)} ${typeof data.product === 'number' ? itemName(data.product, undefined, nameOf) : 'items'} (+${formatNumber(Number(data.xp))} xp)`;
    case 'fletching-stopped': return `Fletching stopped: ${String(data.reason)}`;
    case 'herb-cleaned': return `Cleaned ${typeof data.herb === 'number' ? itemName(data.herb, undefined, nameOf) : 'herb'} → ${typeof data.product === 'number' ? itemName(data.product, undefined, nameOf) : 'product'} (+${formatNumber(Number(data.xp))} xp)`;
    case 'potion-made': return `Made ${typeof data.product === 'number' ? itemName(data.product, undefined, nameOf) : 'potion'} (+${formatNumber(Number(data.xp))} xp)`;
    case 'herblore-stopped': return `Herblore stopped: ${String(data.reason)}`;
    case 'respawned': {
      const at = data.at as Record<string, unknown> | undefined;
      return at === undefined ? 'Respawned' : `Respawned at (${String(at.x)},${String(at.z)},${String(at.level)})`;
    }
    case 'poisoned': return `Poisoned: severity ${String(data.severity)}${typeof data.source === 'number' ? ` from entity#${data.source}` : ''}`;
    case 'poison-damage': return `Poison hit ${String(data.damage)} damage (severity ${String(data.severity)})`;
    case 'poison-cured': return `Poison cured: ${String(data.reason)}`;
    case 'stat-boosted': return `${String(data.skill)} ${Number(data.delta) >= 0 ? '+' : ''}${formatNumber(Number(data.delta))} → ${formatNumber(Number(data.current))}/${formatNumber(Number(data.base))}`;
    case 'stat-restored': return `${String(data.skill)} restored to ${formatNumber(Number(data.current))}/${formatNumber(Number(data.base))}`;
    case 'drank': return `Drank ${typeof data.item === 'number' ? itemName(data.item, undefined, nameOf) : 'potion'}${typeof data.product === 'number' ? ` → ${itemName(data.product, undefined, nameOf)}` : ''}`;
    case 'special-energy': return `Special energy ${formatNumber(Number(data.energy))}%`;
    case 'special-toggled': return `Special attack ${data.enabled === true ? 'enabled' : 'disabled'}`;
    case 'special-attack': return `Special attack ${String(data.special)}: entity#${String(data.attacker)} → entity#${String(data.target)} (${String(data.energyCost)} energy)`;
    case 'run-energy': return `Run energy ${formatNumber(Number(data.energy))}% (weight ${formatNumber(Number(data.weight))})`;
    case 'run-toggled': return `Run mode ${data.enabled === true ? 'enabled' : 'disabled'}`;
    case 'skulled': return `Skulled until tick ${String(data.until)} — no items kept on death`;
    case 'skull-expired': return 'Skull expired';
    case 'zone-entered': return `Entered zone ${String(data.zone)}${Array.isArray(data.tags) && data.tags.length > 0 ? ` [${data.tags.join(', ')}]` : ''}`;
    case 'zone-left': return `Left zone ${String(data.zone)}`;
    case 'items-lost-on-death': return `Death items: kept ${itemAmounts(data.kept, nameOf)}; dropped ${itemAmounts(data.dropped, nameOf)}${typeof data.killer === 'number' ? ` to entity#${data.killer}` : ''}`;
    case 'grave-spawned': return `Grave entity#${String(data.entity)} spawned for entity#${String(data.owner)} until tick ${String(data.expiresAt)}`;
    case 'grave-expired': return `Grave entity#${String(data.entity)} expired for entity#${String(data.owner)}`;
    case 'runes-crafted': return `Crafted ${String(data.amount)} ${typeof data.rune === 'number' ? itemName(data.rune, undefined, nameOf) : 'runes'} (+${formatNumber(Number(data.xp))} xp)`;
    case 'ruin-entered': return `Entered ${String(data.altar)} rune altar`;
    case 'pouch-filled': return `Filled ${typeof data.pouch === 'number' ? itemName(data.pouch, undefined, nameOf) : 'pouch'} with ${String(data.essence)} essence`;
    case 'pouch-emptied': return `Emptied ${String(data.essence)} essence from ${typeof data.pouch === 'number' ? itemName(data.pouch, undefined, nameOf) : 'pouch'}`;
    case 'quest-stage': return `Quest ${String(data.quest)} advanced to stage ${String(data.stage)}: ${String(data.journal)}`;
    case 'quest-complete': return `Quest ${String(data.quest)} complete (+${String(data.questPoints)} quest points)`;
    case 'quest-journal': return `Quest journal (${String(data.questPoints)} points): ${questJournalText(data.quests)}`;
    case 'flag-set': return `Quest flag ${String(data.flag)} = ${String(data.value)}`;
    case 'slayer-assigned': return `Slayer task: ${String(data.amount)} ${String(data.task)} (master entity#${String(data.master)})`;
    case 'slayer-kill': return `Slayer kill: ${String(data.task)}, ${String(data.remaining)} remaining`;
    case 'slayer-complete': return `Slayer task complete: ${String(data.task)} (+${String(data.points)} points, streak ${String(data.streak)})`;
    case 'slayer-rewarded': return `Slayer reward ${String(data.reward)} purchased for ${String(data.cost)} points`;
    case 'travelled': {
      const to = data.to as Record<string, unknown> | undefined;
      return `Travelled by ${String(data.network)} to ${String(data.destination)}${to === undefined ? '' : ` (${String(to.x)},${String(to.z)},${String(to.level)})`}`;
    }
    case 'travel-denied': return `Travel denied by ${String(data.network)}: ${String(data.reason)}`;
    case 'friends-updated': return `Friends: ${stringList(data.friends)}; ignored: ${stringList(data.ignored)}`;
    case 'clan-updated': {
      const clan = data.clan as Record<string, unknown> | undefined;
      return clan === undefined ? 'Clan membership cleared' : `Clan: ${String(clan.name)} (owner ${String(clan.owner)})`;
    }
    case 'patch-changed': return `Patch ${String(data.patch)}: ${String(data.state)}${typeof data.crop === 'number' ? ` crop ${itemName(data.crop, undefined, nameOf)}` : ''}${typeof data.stage === 'number' ? ` stage ${data.stage}` : ''}`;
    case 'farmed': return `Farming ${String(data.patch)}: ${String(data.action)}${typeof data.item === 'number' ? ` with ${itemName(data.item, undefined, nameOf)}` : ''} (+${formatNumber(Number(data.xp))} xp)`;
    case 'harvested': return `Harvested ${String(data.amount)} ${typeof data.item === 'number' ? itemName(data.item, undefined, nameOf) : 'item'} from ${String(data.patch)} (+${formatNumber(Number(data.xp))} xp)`;
    case 'trap-laid': return `Laid ${String(data.kind)} trap entity#${String(data.trap)}`;
    case 'trap-caught': return `Trap entity#${String(data.trap)} caught ${typeof data.catch === 'number' ? itemName(data.catch, undefined, nameOf) : 'prey'}`;
    case 'trap-collapsed': return `Trap entity#${String(data.trap)} collapsed`;
    case 'hunted': return `Hunter catch: ${typeof data.item === 'number' ? itemName(data.item, undefined, nameOf) : 'item'} (+${formatNumber(Number(data.xp))} xp)`;
    case 'familiar-summoned': return `Summoned familiar entity#${String(data.familiar)} with ${typeof data.pouch === 'number' ? itemName(data.pouch, undefined, nameOf) : 'pouch'} until tick ${String(data.expiresAt)}`;
    case 'familiar-dismissed': return `Familiar entity#${String(data.familiar)} dismissed: ${String(data.reason)}`;
    case 'summoning-points': return `Summoning points ${String(data.points)}/${String(data.max)}`;
    case 'familiar-special': return `Familiar special ${String(data.effect)} using ${typeof data.scroll === 'number' ? itemName(data.scroll, undefined, nameOf) : 'scroll'}`;
    case 'bob-updated': return `Familiar storage: ${itemAmounts(data.items, nameOf)}`;
    case 'prospected': return `Prospected ${String(data.node)}: ${typeof data.ore === 'number' ? itemName(data.ore, undefined, nameOf) : 'ore'}`;
    case 'obstacle-completed': return `Agility ${String(data.course)} obstacle ${String(data.obstacle)} complete (+${formatNumber(Number(data.xp))} xp)`;
    case 'obstacle-failed': return `Agility ${String(data.course)} obstacle ${String(data.obstacle)} failed (${String(data.damage)} damage)`;
    case 'course-completed': return `Agility course ${String(data.course)} complete (+${formatNumber(Number(data.xp))} xp)`;
    case 'minigame-lobby': return `Minigame ${String(data.game)} lobby: ${String(data.state)} (${Array.isArray(data.players) ? data.players.length : 0} players)`;
    case 'minigame-started': return `Minigame ${String(data.game)} started (${String(data.session)})`;
    case 'minigame-ended': return `Minigame ${String(data.game)} ended (${String(data.session)})${typeof data.winner === 'number' ? `; winner entity#${data.winner}` : ''}`;
    case 'minigame-event': {
      const details = data.data === undefined ? '' : ` — ${detailText(data.data)}`;
      return `Minigame ${String(data.game)}: ${String(data.kind)} (${String(data.session)})${details}`;
    }
    case 'duel-stake': return `Duel stake entity#${String(data.a)} vs entity#${String(data.b)}; rules ${stringList(data.rules)}`;
    case 'clue-step': return `Clue ${String(data.tier)} step ${String(data.step)} (${String(data.kind)}): ${String(data.text)}`;
    case 'clue-advanced': return `Clue ${String(data.tier)} advanced to step ${String(data.step)}`;
    case 'clue-complete': return `Clue ${String(data.tier)} complete: ${itemAmounts(data.rewards, nameOf)}`;
    case 'diary-progress': return `Diary ${String(data.area)} ${String(data.level)}: ${String(data.done)}/${String(data.total)} complete`;
    case 'diary-complete': return `Diary ${String(data.area)} ${String(data.level)} complete`;
    case 'random-event-started': return `Random event ${String(data.event)}: ${String(data.prompt ?? 'respond or dismiss')}${Array.isArray(data.options) ? ` [${data.options.join(', ')}]` : ''}`;
    case 'random-event-ended': return `Random event ${String(data.event)} ended: ${String(data.outcome)}${data.reward === undefined ? '' : `; reward ${itemAmounts(data.reward, nameOf)}`}`;
    case 'shooting-star': {
      const at = data.at as Record<string, unknown> | undefined;
      return `Shooting star size ${String(data.size)} stage ${String(data.stage)}${at === undefined ? '' : ` at (${String(at.x)},${String(at.z)},${String(at.level)})`}`;
    }
    case 'champion-challenged': return `Champion challenge started: ${String(data.champion)}`;
    case 'champion-defeated': return `Champion defeated: ${String(data.champion)}`;
    default: return undefined;
  }
}

export function renderDeltaLines(delta: PerceptDelta, nameOf: NameLookup): string[] {
  const detailed = delta as DetailedPerceptDelta;
  const lines: string[] = [];
  const selfDeath = delta.deaths.find((death) => death.isSelf);
  if (selfDeath !== undefined) {
    lines.push(selfDeath.killer === undefined ? 'YOU DIED' : `YOU DIED — killed by ${entityName(detailed, selfDeath.killer)}`);
  }
  if (delta.hp !== undefined) {
    const change = delta.hp.after.current - delta.hp.before.current;
    const hit = [...delta.events].reverse().find((event) => {
      if (event.type !== 'hit') return false;
      const data = event.data as unknown as Record<string, unknown>;
      return typeof data.target === 'number' && typeof data.attacker === 'number'
        && typeof data.damage === 'number' && data.target !== data.attacker;
    });
    const hitData = hit?.data as unknown as Record<string, unknown> | undefined;
    const source = change < 0 && typeof hitData?.attacker === 'number'
      ? ` from ${entityName(detailed, hitData.attacker)}` : '';
    lines.push(`HP ${formatNumber(delta.hp.before.current)}→${formatNumber(delta.hp.after.current)}/${formatNumber(delta.hp.after.max)} (${change >= 0 ? '+' : ''}${formatNumber(change)}${source})`);
  }
  for (const rejection of delta.rejections) {
    lines.push(`REJECTED ${rejection.type}: ${rejection.code} — ${rejection.message}`);
  }
  if (delta.moved !== undefined) {
    const amount = distance(delta.moved.from, delta.moved.to);
    const bearing = direction(delta.moved.from, delta.moved.to);
    lines.push(`Moved to (${delta.moved.to.x},${delta.moved.to.z},${delta.moved.to.level})${amount === 0 ? '' : ` ${amount} ${bearing}`}`);
  }
  if (delta.dialogue !== undefined) {
    if (!delta.dialogue.active) lines.push('Dialogue ended');
    else {
      const speaker = delta.dialogue.speaker ?? (delta.dialogue.npc === undefined ? 'unknown' : `npc#${delta.dialogue.npc}`);
      const text = delta.dialogue.text === undefined ? '' : `: "${delta.dialogue.text}"`;
      const options = delta.dialogue.options === undefined ? ''
        : ` options: ${delta.dialogue.options.map((option, index) => `${index + 1}) ${option}`).join(' ')}`;
      lines.push(`Dialogue: ${speaker}${text}${options}`);
    }
  }
  for (const objective of delta.objectivesChanged) {
    lines.push(`Objective ${objective.complete ? 'complete' : 'updated'}: ${objective.description}`);
  }
  for (const message of delta.messages) lines.push(`Message: ${message}`);
  for (const event of delta.events) {
    const line = waveEventLine(event, nameOf, detailed);
    if (line !== undefined) lines.push(line);
  }
  for (const gained of delta.itemsGained) lines.push(`+${gained.amount} ${itemName(gained.item, gained.name, nameOf)}`);
  for (const lost of delta.itemsLost) lines.push(`-${lost.amount} ${itemName(lost.item, lost.name, nameOf)}`);
  for (const level of delta.levelUps) lines.push(`${level.skill} level ${level.level}`);
  for (const gained of delta.xpGained) lines.push(`+${formatNumber(gained.amount)} ${gained.skill} xp`);
  for (const death of delta.deaths.filter((entry) => !entry.isSelf)) {
    lines.push(`${death.name === undefined ? `entity#${death.entity}` : `${death.name.toLowerCase()}#${death.entity}`} died`);
  }
  const selfAt = detailed._details?.afterSelfAt;
  for (const entered of delta.entered) {
    const label = `${entered.name?.toLowerCase() ?? entered.kind}#${entered.id}`;
    const bearing = selfAt === undefined ? '' : ` ${entered.distance} tiles ${direction(selfAt, entered.at)}`;
    lines.push(`${label} appeared${bearing}`);
  }
  for (const left of delta.left) lines.push(`${left.name?.toLowerCase() ?? 'entity'}#${left.id} left`);
  for (const item of delta.groundItemsAppeared) {
    const bearing = selfAt === undefined ? `at (${item.at.x},${item.at.z},${item.at.level})`
      : `${item.distance}${direction(selfAt, item.at)}`;
    lines.push(`${itemName(item.item, item.name, nameOf)} on ground ${bearing} (id ${item.id})`);
  }
  if (lines.length <= 40) return lines;
  const omitted = lines.length - 39;
  return [...lines.slice(0, 39), `… and ${omitted} more`];
}

function activityText(activity: Activity): string {
  switch (activity.kind) {
    case 'idle': return 'idle';
    case 'walking': return `walking to (${activity.dest.x},${activity.dest.z},${activity.dest.level}) since ${activity.since}`;
    case 'fighting': return `fighting entity#${activity.target} since ${activity.since}`;
    case 'gathering': return `gathering ${activity.node} since ${activity.since}`;
    case 'fishing': return `fishing entity#${activity.spot} since ${activity.since}`;
    case 'producing': return `${activity.what} since ${activity.since}`;
    case 'thieving': return `thieving since ${activity.since}`;
    case 'agility': return `agility since ${activity.since}`;
    case 'dialogue': return `dialogue since ${activity.since}`;
  }
}

function relative(at: TileCoord, target: TileCoord): string {
  const amount = distance(at, target);
  return amount === Number.POSITIVE_INFINITY ? 'other level' : `${amount} ${direction(at, target)}`;
}

export function renderSnapshot(snapshot: WorldSnapshot): string {
  const lines: string[] = [];
  const self = snapshot.self;
  lines.push(`World ${snapshot.instanceId} — tick ${snapshot.tick}`);
  lines.push(`Position (${self.at.x},${self.at.z},${self.at.level}) radius ${snapshot.radius}`);
  lines.push(`HP ${formatNumber(self.hp.current)}/${formatNumber(self.hp.max)}${self.dead ? ' DEAD' : ''}`);
  if (self.status !== undefined) {
    const parts: string[] = [];
    if (self.status.poison !== undefined) parts.push(`Poisoned (severity ${formatNumber(self.status.poison.severity)}).`);
    parts.push(`Run ${formatNumber(self.status.runEnergy)}%.`);
    if (self.status.weight !== 0) parts.push(`Weight ${formatNumber(self.status.weight)}.`);
    parts.push(`Special ${formatNumber(self.status.specialEnergy)}%${self.status.specialEnabled ? ' (armed)' : ''}.`);
    const boosts = Object.entries(self.status.boosts).filter(([, delta]) => delta !== 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([skill, delta]) => `${skill} ${delta > 0 ? '+' : ''}${formatNumber(delta)}`);
    if (boosts.length > 0) parts.push(`Boosts: ${boosts.join(', ')}.`);
    if (self.status.skulledUntil !== undefined) parts.push(`Skulled until ${self.status.skulledUntil}.`);
    if (self.status.wildernessLevel > 0) parts.push(`Wilderness lvl ${self.status.wildernessLevel} — PvP risk.`);
    else if (self.status.zoneTags.length > 0) parts.push(`Zones: ${self.status.zoneTags.join(', ')}.`);
    lines.push(parts.join(' '));
  }
  if (self.prayer !== undefined) {
    lines.push(`Prayer ${formatNumber(self.prayer.points)}/${formatNumber(self.prayer.maxPoints)}${self.prayer.active.length === 0 ? '' : ` active: ${self.prayer.active.join(', ')}`}`);
  }
  const combat = self.combat.inCombat
    ? `in combat${self.combat.target === undefined ? '' : ` target entity#${self.combat.target}`}${self.combat.attackedBy.length === 0 ? '' : ` attacked by ${self.combat.attackedBy.map((id) => `entity#${id}`).join(', ')}`}`
    : 'not in combat';
  const autocast = self.combat.style?.spell === undefined ? '' : `; autocast ${self.combat.style.spell}`;
  const bound = self.combat.bound ? '; BOUND' : '';
  const drains = Object.entries(self.combat.drains ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] !== 0)
    .map(([skill, amount]) => `${skill} -${formatNumber(amount)}`);
  lines.push(`Combat: ${combat}${autocast}${bound}${drains.length === 0 ? '' : `; drains ${drains.join(', ')}`}`);
  lines.push(`Activity: ${activityText(self.activity)}`);
  if (snapshot.trade !== undefined) {
    const own = snapshot.trade.ownOffer.map((offer) => `item#${offer.item}×${offer.amount}`).join(', ') || 'nothing';
    const partner = snapshot.trade.partnerOffer.map((offer) => `item#${offer.item}×${offer.amount}`).join(', ') || 'nothing';
    lines.push(`Trade with entity#${snapshot.trade.partner}: ${snapshot.trade.stage}; you offer ${own}; they offer ${partner}`);
  }
  if (snapshot.quests !== undefined) {
    const active = snapshot.quests.journal.filter((quest) => !quest.complete)
      .map((quest) => `${quest.name} stage ${quest.stage}${quest.journal === undefined ? '' : ` — ${quest.journal}`}`);
    const completed = snapshot.quests.journal.filter((quest) => quest.complete).length;
    lines.push(`Quests: ${snapshot.quests.questPoints} points; ${active.length === 0 ? 'none active' : active.join('; ')}${completed === 0 ? '' : `; ${completed} complete`}`);
  }
  if (snapshot.slayer !== undefined) {
    lines.push(snapshot.slayer.task === undefined
      ? 'Slayer: no active task'
      : `Slayer: ${snapshot.slayer.task}, ${snapshot.slayer.remaining} remaining`);
  }
  if (snapshot.social !== undefined) {
    const friends = snapshot.social.friends.join(', ') || 'none';
    const ignored = snapshot.social.ignored.join(', ');
    lines.push(`Social: friends ${friends}${ignored === '' ? '' : `; ignored ${ignored}`}${snapshot.social.clan === undefined ? '' : `; clan ${snapshot.social.clan.name}`}`);
  }
  if (snapshot.farming !== undefined && snapshot.farming.patches.length > 0) {
    lines.push(`Farming: ${snapshot.farming.patches.map((patch) => `${patch.id} ${patch.state}${patch.crop === undefined ? '' : ` crop#${patch.crop}`}${patch.stage === undefined ? '' : ` stage ${patch.stage}`}`).join('; ')}`);
  }
  if (snapshot.hunter !== undefined && snapshot.hunter.traps.length > 0) {
    lines.push(`Hunter traps: ${snapshot.hunter.traps.map((trap) => `${trap.kind}#${trap.id} ${trap.state}`).join('; ')}`);
  }
  if (snapshot.summoningPoints !== undefined) lines.push(`Summoning points: ${formatNumber(snapshot.summoningPoints)}`);
  if (snapshot.familiar !== undefined) {
    lines.push(`Familiar entity#${snapshot.familiar.id}, pouch#${snapshot.familiar.pouch}, expires tick ${snapshot.familiar.expiresAt}`);
  }
  if (snapshot.minigame !== undefined) {
    lines.push(`Minigame: ${snapshot.minigame.game} ${snapshot.minigame.state}${snapshot.minigame.session === undefined ? '' : ` (${snapshot.minigame.session})`}${snapshot.minigame.event === undefined ? '' : `; latest ${snapshot.minigame.event.kind}${snapshot.minigame.event.data === undefined ? '' : ` — ${detailText(snapshot.minigame.event.data)}`}`}`);
  }
  if (snapshot.clue !== undefined) {
    lines.push(`Clue: ${snapshot.clue.tier} step ${snapshot.clue.step} (${snapshot.clue.kind}) — ${snapshot.clue.text}`);
  }
  if (snapshot.randomEvent !== undefined) {
    lines.push(`Random event: ${snapshot.randomEvent.event}${snapshot.randomEvent.prompt === undefined ? '' : ` — ${snapshot.randomEvent.prompt}`}${snapshot.randomEvent.options === undefined ? '' : ` [${snapshot.randomEvent.options.join(', ')}]`}`);
  }
  if (snapshot.diary !== undefined) {
    lines.push(`Diary: ${snapshot.diary.area} ${snapshot.diary.level} ${snapshot.diary.done}/${snapshot.diary.total}`);
  }
  if (snapshot.chat.length > 0) {
    lines.push('Recent chat:');
    for (const line of snapshot.chat.slice(-10)) {
      const channel = line.channel === 'pm' ? 'PM' : line.channel === 'clan' ? `clan:${line.clan ?? '?'}` : 'public';
      lines.push(`  [${channel}] ${line.name}: ${line.text}`);
    }
  }

  lines.push(`Inventory (${snapshot.inventory.length} used, ${snapshot.inventoryFree} free):`);
  for (const slot of [...snapshot.inventory].sort((a, b) => a.slot - b.slot)) {
    lines.push(`  ${slot.name ?? `item#${slot.item}`}×${slot.amount} (slot ${slot.slot})`);
  }
  const equipment = Object.entries(snapshot.equipment).sort(([left], [right]) => left.localeCompare(right));
  lines.push('Equipment:');
  for (const [slot, item] of equipment) lines.push(`  ${slot}: ${item.name ?? `item#${item.item}`}${item.amount === undefined ? '' : `×${item.amount}`}`);
  const skills = Object.entries(snapshot.skills).filter(([, view]) => view.level > 1)
    .sort(([left], [right]) => left.localeCompare(right));
  lines.push('Skills (>1):');
  for (const [skill, view] of skills) lines.push(`  ${skill} ${view.level} (${formatNumber(view.xp)} xp)`);

  lines.push('Nearby:');
  for (const entity of [...snapshot.nearby].sort((a, b) => a.distance - b.distance || a.id - b.id).slice(0, 20)) {
    const label = entity.name?.toLowerCase() ?? entity.kind;
    const hp = entity.hp === undefined ? '' : ` hp ${formatNumber(entity.hp.current)}/${formatNumber(entity.hp.max)}`;
    const options = entity.options === undefined || entity.options.length === 0 ? '' : ` [${entity.options.join(', ')}]`;
    lines.push(`  ${entity.kind} ${label}#${entity.id}${options}${hp} ${relative(self.at, entity.at)} (${entity.at.x},${entity.at.z},${entity.at.level})`);
  }
  lines.push('Ground items:');
  for (const item of [...snapshot.groundItems].sort((a, b) => a.distance - b.distance || a.id - b.id).slice(0, 10)) {
    lines.push(`  ${item.name ?? `item#${item.item}`}×${item.amount} ${relative(self.at, item.at)} (id ${item.id})`);
  }
  lines.push('Nodes:');
  for (const node of [...snapshot.nodes].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, 10)) {
    lines.push(`  ${node.name ?? node.id} ${node.skill} lv${node.requiredLevel}${node.depleted ? ' depleted' : ''} ${relative(self.at, node.at)}`);
  }
  lines.push('Stations:');
  for (const station of [...snapshot.stations].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, 10)) {
    lines.push(`  ${station.name ?? station.kind} (${station.id}) ${relative(self.at, station.at)}`);
  }
  lines.push('Heat sources:');
  for (const source of [...snapshot.heatSources].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)).slice(0, 5)) {
    lines.push(`  ${source.kind} ${source.id} ${relative(self.at, source.at)}`);
  }
  lines.push(`Objectives: ${snapshot.won ? 'WON' : snapshot.lost ? 'LOST' : 'active'}`);
  for (const objective of [...snapshot.objectives].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(`  [${objective.complete ? 'x' : ' '}] ${objective.description} (${objective.outcome})`);
    for (const progress of objective.progress) {
      lines.push(`    ${progress.path}: ${formatNumber(progress.current)}/${formatNumber(progress.target)}${progress.satisfied ? ' ✓' : ''}`);
    }
  }
  if (snapshot.dialogue.active) {
    lines.push(`Dialogue: ${snapshot.dialogue.speaker ?? 'unknown'}${snapshot.dialogue.text === undefined ? '' : ` — "${snapshot.dialogue.text}"`}`);
    if (snapshot.dialogue.options !== undefined) {
      snapshot.dialogue.options.forEach((option, index) => lines.push(`  ${index + 1}) ${option}`));
    }
  }
  return lines.slice(0, 60).join('\n');
}
