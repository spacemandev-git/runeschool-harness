import type { JsonValue } from '#protocol';
import type { MindDeps } from '../core/agent.ts';
import type { PromptName } from '../core/prompts.ts';
import { compactReflexText } from './tools.ts';

export interface SystemPromptState {
  readonly goal?: string;
  readonly team?: string;
}

const GUIDE_SECTIONS: readonly { readonly name: PromptName; readonly title: string }[] = [
  { name: 'commands', title: 'Commands' },
  { name: 'combat', title: 'Combat' },
  { name: 'navigation', title: 'Navigation' }
];

function record(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>> : undefined;
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function describeObjective(value: JsonValue): string | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  return text(item.description) ?? text(item.id) ?? text(item.name);
}

function scenarioSummary(root: Readonly<Record<string, JsonValue>>): string | undefined {
  const scenario = record(root.scenario) ?? root;
  const meta = record(scenario.meta);
  const name = text(meta?.name) ?? text(scenario.name) ?? text(root.name);
  const description = text(meta?.description) ?? text(scenario.description) ?? text(root.description);
  const objectivesValue = scenario.objectives ?? root.objectives;
  const objectives = Array.isArray(objectivesValue)
    ? objectivesValue.map(describeObjective).filter((value): value is string => value !== undefined)
    : [];
  const actorsValue = scenario.actors ?? root.actors;
  const actors = Array.isArray(actorsValue) ? actorsValue.map((actor) => {
    const entry = record(actor);
    return entry === undefined ? undefined : text(entry.displayName) ?? text(entry.name) ?? text(entry.tag) ?? text(entry.id);
  }).filter((value): value is string => value !== undefined) : [];
  if (name === undefined && description === undefined && objectives.length === 0 && actors.length === 0) return undefined;
  return [
    name === undefined ? undefined : `Scenario: ${name}`,
    description,
    objectives.length === 0 ? undefined : `Objectives: ${objectives.join('; ')}`,
    actors.length === 0 ? undefined : `Actors: ${actors.join(', ')}`
  ].filter((value): value is string => value !== undefined).join('\n');
}

function sandboxSummary(root: Readonly<Record<string, JsonValue>>): string | undefined {
  const region = record(root.region) ?? record(root.regionMetadata) ?? root;
  const regionName = text(region.name) ?? text(root.regionName);
  const idValue = region.regionId ?? region.id;
  const regionId = typeof idValue === 'number' || typeof idValue === 'string'
    ? String(idValue)
    : typeof root.regionId === 'number' || typeof root.regionId === 'string' ? String(root.regionId) : undefined;
  const spawn = record(root.spawn) ?? record(root.spawnAt) ?? record(region.spawn) ?? record(region.spawnAt);
  if (regionName === undefined && regionId === undefined && spawn === undefined) return undefined;
  const at = spawn === undefined ? undefined
    : `(${String(spawn.x ?? '?')},${String(spawn.z ?? '?')},${String(spawn.level ?? '?')})`;
  return `Sandbox region: ${regionName ?? 'unknown'}${regionId === undefined ? '' : ` (id ${regionId})`}${at === undefined ? '' : ` · spawn ${at}`}`;
}

function hostedSummary(root: Readonly<Record<string, JsonValue>>): string {
  const name = text(root.name) ?? 'unnamed';
  const instanceId = text(root.instanceId) ?? 'unknown instance';
  const pvp = root.pvp === true ? 'on' : 'off';
  const participants = typeof root.participantCount === 'number'
    ? `, ${root.participantCount} participants online`
    : '';
  return `Shared hosted world "${name}" (${instanceId}), PvP ${pvp}${participants}. You joined with a wallet identity; the server chose your spawn. Your starter kit (1,000 coins and full bronze melee gear: full helm, platebody, platelegs, kiteshield, sword, dagger, axe) is in your BANK, not equipped: go to a bank booth, bank-withdraw the pieces, then equip them.`;
}

export function summarizeWorldContext(value: JsonValue): string {
  const root = record(value);
  const kind = root === undefined ? undefined : text(root.kind);
  const preferred = root === undefined ? undefined
    : kind === 'sandbox' ? sandboxSummary(root)
      : kind === 'scenario' ? scenarioSummary(root)
        : kind === 'hosted' ? hostedSummary(root)
        : scenarioSummary(root) ?? sandboxSummary(root);
  const summary = preferred ?? JSON.stringify(value);
  return summary.length <= 600 ? summary : `${summary.slice(0, 599)}…`;
}

export function buildSystemPrompt(deps: MindDeps, state: SystemPromptState): string {
  const team = state.team ?? deps.spec.team;
  const frame = deps.prompts.render('agent-system', {
    identity: `${deps.spec.displayName ?? deps.agentId} (agent id ${deps.agentId}, actor entity ${deps.view.entity})`,
    world: summarizeWorldContext(deps.worldContext),
    goal: state.goal?.trim() || 'No goal assigned.',
    persona: deps.spec.persona?.trim() || 'No additional persona instructions.',
    voice: deps.spec.voice?.trim() || 'Speak naturally, in character.',
    team: team === undefined ? 'No team; report to the director.' : `${team}; report to coordinator:${team}.`,
    reflexes: compactReflexText(deps.reflexes.state()),
    memories: 'See the per-wake digest for relevant recalled memories.',
    tools: [
      'Use one action at a time.',
      'Prefer behaviours for anything multi-step.',
      'Use wait after multi-tick commands.',
      'Use sleep when nothing needs deliberation.',
      'Use finish only when the goal is met or impossible.',
      'Keep replies to at most 3 sentences.'
    ].join(' ')
  });
  const grounding = GUIDE_SECTIONS.map(({ name, title }) => `## ${title}\n\n${deps.prompts.get(name)}`).join('\n\n');
  return `${frame}\n\n## World basics\n\n${deps.prompts.get('world-basics')}\n\n${grounding}`;
}
