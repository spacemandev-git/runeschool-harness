import type { JsonValue, TileCoord } from '#protocol';
import { ADMIN_MCP_TOOLS, type AdminDeps } from '../core/admin.ts';
import type { ToolDefinition } from '../core/model.ts';
import { chebyshev, resolveAgent, resolveName, spiralTiles, type NameKind, type NameMatch } from './resolve.ts';

export interface AdminTool {
  readonly definition: ToolDefinition;
  run(args: Readonly<Record<string, unknown>>): Promise<JsonValue>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function integer(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalInteger(value: unknown, path: string, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return value === undefined ? fallback : integer(value, path, minimum, maximum);
}

function tile(value: unknown, path: string): TileCoord {
  const raw = record(value, path);
  return {
    x: integer(raw.x, `${path}.x`, 0, 16_383),
    z: integer(raw.z, `${path}.z`, 0, 16_383),
    level: integer(raw.level, `${path}.level`, 0, 3)
  };
}

function schema(properties: Record<string, JsonValue>, required: readonly string[] = []): JsonValue {
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false };
}

const TILE_SCHEMA: JsonValue = {
  type: 'object',
  properties: {
    x: { type: 'integer', minimum: 0, maximum: 16_383 },
    z: { type: 'integer', minimum: 0, maximum: 16_383 },
    level: { type: 'integer', minimum: 0, maximum: 3 }
  },
  required: ['x', 'z', 'level'],
  additionalProperties: false
};
const CONFIG_ID: JsonValue = { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }] };
const AGENT: JsonValue = { type: 'string', description: 'Harness agent id or actor tag.' };

function definition(name: string, description: string, properties: Record<string, JsonValue>, required: readonly string[] = []): ToolDefinition {
  return { name, description, parameters: schema(properties, required) };
}

function sanitize(value: unknown, secret: string | undefined): JsonValue {
  const encoded = JSON.stringify(value, (key, child: unknown) => {
    if (key === 'admin_token') return undefined;
    if (typeof child === 'string' && secret !== undefined && secret.length > 0) return child.replaceAll(secret, '[redacted]');
    if (typeof child === 'bigint') return String(child);
    if (typeof child === 'number' && !Number.isFinite(child)) return String(child);
    if (typeof child === 'function' || typeof child === 'symbol' || child === undefined) return null;
    return child;
  });
  return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
}

function truncate(value: JsonValue): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded.length <= 6_000) return value;
  return `${encoded.slice(0, 5_980)}\n[truncated]`;
}

function declaredProperties(inputSchema: JsonValue): ReadonlySet<string> {
  if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) return new Set();
  const properties = (inputSchema as Readonly<Record<string, JsonValue>>).properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return new Set();
  return new Set(Object.keys(properties));
}

function placementResult(value: JsonValue, at: TileCoord): { readonly placementId: string; readonly entity: number; readonly at: TileCoord } {
  const root = record(value, 'place result');
  const candidate = Array.isArray(root.placements) ? root.placements[0] : root;
  const placed = record(candidate, 'place result.placements[0]');
  const placementId = typeof placed.id === 'string' ? placed.id
    : typeof placed.placementId === 'string' ? placed.placementId : undefined;
  if (placementId === undefined || typeof placed.entity !== 'number') throw new Error('place returned no NPC placement id/entity');
  return { placementId, entity: placed.entity, at };
}

function retryablePlacement(error: unknown): boolean {
  const message = errorMessage(error).toLocaleLowerCase();
  return message.includes('unwalkable') || message.includes('out-of-bounds');
}

interface ResolvedConfig extends NameMatch {
  readonly id: number;
  readonly name: string;
  /** Other config ids that share this exact display name (rev-530 has many "Goblin"s); the lowest id wins. */
  readonly alternatives?: readonly number[];
}
type ConfigResolution = { readonly value: ResolvedConfig } | { readonly error: JsonValue };

export function toolDefinitions(tools: readonly AdminTool[]): readonly ToolDefinition[] {
  return tools.map((tool) => tool.definition);
}

/** Curated admin operations plus the whitelisted, prefixed MCP passthroughs. */
export function createAdminTools(deps: AdminDeps): readonly AdminTool[] {
  let pendingNames: ReturnType<AdminDeps['defs']['names']> | undefined;
  const loadNames = (): ReturnType<AdminDeps['defs']['names']> => pendingNames ??= deps.defs.names();

  async function callMcp(name: string, args: Readonly<Record<string, unknown>>, declared?: ReadonlySet<string>): Promise<JsonValue> {
    const next: Record<string, unknown> = { ...args };
    if ((declared === undefined || declared.has('instance_id')) && next.instance_id === undefined) {
      next.instance_id = deps.world.instanceId;
    }
    if (deps.world.adminToken !== undefined
      && (declared === undefined || declared.has('admin_token'))
      && next.admin_token === undefined) {
      next.admin_token = deps.world.adminToken;
    }
    return truncate(sanitize(await deps.mcp.call(name, next), deps.world.adminToken));
  }

  function total(toolDefinition: ToolDefinition, run: (args: Readonly<Record<string, unknown>>) => Promise<unknown> | unknown): AdminTool {
    return {
      definition: toolDefinition,
      async run(args): Promise<JsonValue> {
        try {
          return truncate(sanitize(await run(args), deps.world.adminToken));
        } catch (error) {
          return truncate(sanitize({ error: errorMessage(error) }, deps.world.adminToken));
        }
      }
    };
  }

  function unknownAgent(): JsonValue {
    return { error: 'unknown agent', known: deps.view.agents().map((agent) => agent.id) };
  }

  function selectedAgent(ref: unknown) {
    return resolveAgent(deps.view, text(ref, 'agent'));
  }

  async function resolveConfig(kind: NameKind, raw: unknown): Promise<ConfigResolution> {
    const names = await loadNames();
    if (typeof raw === 'number') {
      const id = integer(raw, kind, 0);
      const match = resolveName(names, kind, String(id), 1)[0];
      return { value: match ?? { id, name: `#${id}` } };
    }
    const query = text(raw, kind);
    const candidates = resolveName(names, kind, query, 25);
    const exact = candidates.filter((candidate) => candidate.name.toLocaleLowerCase() === query.toLocaleLowerCase());
    if (exact.length > 1) {
      // Identical display names are variants of one thing; the canonical (lowest) id is the safe default.
      const [first, ...rest] = exact;
      return { value: { ...first!, alternatives: rest.map((candidate) => candidate.id) } };
    }
    const selected = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (selected !== undefined) return { value: selected };
    return {
      error: {
        error: candidates.length === 0 ? `unknown ${kind}` : `ambiguous ${kind}`,
        candidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name }))
      }
    };
  }

  function anchor(args: Readonly<Record<string, unknown>>, nearRing: boolean): { value: TileCoord } | { error: JsonValue } {
    if (args.at !== undefined) return { value: tile(args.at, 'at') };
    if (args.near_agent === undefined) return { error: { error: 'provide at or near_agent' } };
    const agent = resolveAgent(deps.view, text(args.near_agent, 'near_agent'));
    if (agent === undefined) return { error: unknownAgent() };
    if (agent.at === undefined) return { error: { error: 'agent has no position' } };
    return { value: nearRing ? spiralTiles(agent.at, 1, false)[0]! : agent.at };
  }

  const tools: AdminTool[] = [];
  const add = (tool: AdminTool): void => { tools.push(tool); };

  for (const kind of ['npc', 'item', 'loc'] as const) {
    add(total(definition(`find_${kind}`, `Resolve a ${kind} name or numeric config id.`, {
      query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 }
    }, ['query']), async (args) => resolveName(
      await loadNames(),
      kind,
      text(args.query, 'query'),
      optionalInteger(args.limit, 'limit', 10, 1, 25)
    )));
  }

  add(total(definition('list_agents', 'List live harness agents, actor entities, positions, health, and goals.', {}), () => deps.view.agents().map((agent) => ({
    id: agent.id, tag: agent.tag, entity: agent.entity, state: agent.state,
    at: agent.at ?? null, hp: agent.hp ?? null, goal: agent.goal ?? null
  }))));

  add(total(definition('look_around', 'Read nearby entities and ground items from an agent snapshot.', {
    agent: AGENT, radius: { type: 'integer', minimum: 0 }
  }, ['agent']), (args) => {
    const agent = selectedAgent(args.agent);
    if (agent === undefined) return unknownAgent();
    const snapshot = deps.view.agentSnapshot(agent.id);
    if (snapshot === undefined) return { error: 'agent has no snapshot yet' };
    const radius = optionalInteger(args.radius, 'radius', snapshot.radius, 0);
    return {
      nearby: snapshot.nearby.filter((entry) => entry.distance <= radius).map((entry) => ({
        id: entry.id, kind: entry.kind,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        ...(entry.npc === undefined ? {} : { npc: entry.npc }),
        ...(entry.loc === undefined ? {} : { loc: entry.loc }),
        at: entry.at, distance: entry.distance,
        ...(entry.hp === undefined ? {} : { hp: entry.hp })
      })),
      groundItems: snapshot.groundItems.filter((entry) => entry.distance <= radius)
    };
  }));

  add(total(definition('agent_inventory', 'Read an agent inventory, equipment, and skills.', { agent: AGENT }, ['agent']), (args) => {
    const agent = selectedAgent(args.agent);
    if (agent === undefined) return unknownAgent();
    const snapshot = deps.view.agentSnapshot(agent.id);
    if (snapshot === undefined) return { error: 'agent has no snapshot yet' };
    return { inventory: snapshot.inventory, equipment: snapshot.equipment, skills: snapshot.skills };
  }));

  add(total(definition('spawn_npcs', 'Spawn NPCs on deterministic distinct tiles around an anchor.', {
    npc: CONFIG_ID, count: { type: 'integer', minimum: 1, maximum: 20, default: 1 }, at: TILE_SCHEMA,
    near_agent: AGENT, radius: { type: 'integer', minimum: 0, maximum: 10, default: 2 },
    aggro_radius: { type: 'integer', minimum: 0, maximum: 32, default: 0 },
    wander_radius: { type: 'integer', minimum: 0, default: 0 }, respawn_ticks: { type: 'integer', minimum: 0 },
    label: { type: 'string' }
  }, ['npc']), async (args) => {
    const resolved = await resolveConfig('npc', args.npc);
    if ('error' in resolved) return resolved.error;
    const count = optionalInteger(args.count, 'count', 1, 1, 20);
    const radius = optionalInteger(args.radius, 'radius', 2, 0, 10);
    let origin: TileCoord;
    let includeCentre = true;
    if (args.at !== undefined) origin = tile(args.at, 'at');
    else if (args.near_agent !== undefined) {
      const agent = resolveAgent(deps.view, text(args.near_agent, 'near_agent'));
      if (agent === undefined) return unknownAgent();
      if (agent.at === undefined) return { error: 'agent has no position' };
      origin = agent.at;
      includeCentre = false;
    } else return { error: 'provide at or near_agent' };
    const placed: { placementId: string; entity: number; at: TileCoord }[] = [];
    const skipped: { at: TileCoord; error: string }[] = [];
    for (const candidate of spiralTiles(origin, radius, includeCentre)) {
      if (placed.length >= count) break;
      const placement: Record<string, unknown> = {
        kind: 'npc', npc: resolved.value.id, at: candidate,
        wanderRadius: optionalInteger(args.wander_radius, 'wander_radius', 0, 0),
        behavior: { retaliate: true, aggroRadius: optionalInteger(args.aggro_radius, 'aggro_radius', 0, 0, 32) }
      };
      if (args.respawn_ticks !== undefined) placement.respawnTicks = integer(args.respawn_ticks, 'respawn_ticks', 0);
      if (args.label !== undefined) placement.label = text(args.label, 'label');
      try {
        const result = await callMcp('place', { placements: placement });
        placed.push(placementResult(result, candidate));
      } catch (error) {
        if (!retryablePlacement(error)) throw error;
        skipped.push({ at: candidate, error: errorMessage(error) });
      }
    }
    return { npc: resolved.value, placed, skipped };
  }));

  add(total(definition('place_loc', 'Place one loc at a tile or on the first ring tile near an agent.', {
    loc: CONFIG_ID, at: TILE_SCHEMA, near_agent: AGENT, rotation: { type: 'integer', minimum: 0, maximum: 3 },
    shape: { type: 'integer', minimum: 0, maximum: 22 }, blocking: { type: 'boolean' }, label: { type: 'string' }
  }, ['loc']), async (args) => {
    const resolved = await resolveConfig('loc', args.loc);
    if ('error' in resolved) return resolved.error;
    const anchored = anchor(args, true);
    if ('error' in anchored) return anchored.error;
    const placement: Record<string, unknown> = { kind: 'loc', loc: resolved.value.id, at: anchored.value };
    if (args.rotation !== undefined) placement.rotation = integer(args.rotation, 'rotation', 0, 3);
    if (args.shape !== undefined) placement.shape = integer(args.shape, 'shape', 0, 22);
    if (args.blocking !== undefined) {
      if (typeof args.blocking !== 'boolean') throw new Error('blocking must be a boolean');
      placement.blocking = args.blocking;
    }
    if (args.label !== undefined) placement.label = text(args.label, 'label');
    return callMcp('place', { placements: placement });
  }));

  add(total(definition('drop_items', 'Drop an item stack at a tile or at an agent feet, retrying ring one if needed.', {
    item: CONFIG_ID, amount: { type: 'integer', minimum: 1, default: 1 }, at: TILE_SCHEMA, near_agent: AGENT
  }, ['item']), async (args) => {
    const resolved = await resolveConfig('item', args.item);
    if ('error' in resolved) return resolved.error;
    const amount = optionalInteger(args.amount, 'amount', 1, 1);
    let candidates: readonly TileCoord[];
    if (args.at !== undefined) candidates = [tile(args.at, 'at')];
    else if (args.near_agent !== undefined) {
      const agent = resolveAgent(deps.view, text(args.near_agent, 'near_agent'));
      if (agent === undefined) return unknownAgent();
      if (agent.at === undefined) return { error: 'agent has no position' };
      candidates = spiralTiles(agent.at, 1, true);
    } else return { error: 'provide at or near_agent' };
    for (const [index, at] of candidates.entries()) {
      try {
        return await callMcp('place', { placements: { kind: 'ground_item', item: resolved.value.id, amount, at } });
      } catch (error) {
        if (!errorMessage(error).toLocaleLowerCase().includes('unwalkable') || index === candidates.length - 1) throw error;
      }
    }
    throw new Error('no tile available');
  }));

  async function mutate(args: Readonly<Record<string, unknown>>, mutation: Readonly<Record<string, unknown>>): Promise<JsonValue> {
    const agent = selectedAgent(args.agent);
    if (agent === undefined) return unknownAgent();
    return callMcp('mutate_entity', { entity: agent.entity, mutations: [mutation] });
  }

  add(total(definition('give_items', 'Give inventory items to a run agent.', {
    agent: AGENT, item: CONFIG_ID, amount: { type: 'integer', minimum: 1, default: 1 }
  }, ['agent', 'item']), async (args) => {
    const resolved = await resolveConfig('item', args.item);
    if ('error' in resolved) return resolved.error;
    return mutate(args, { kind: 'give_item', item: resolved.value.id, amount: optionalInteger(args.amount, 'amount', 1, 1) });
  }));

  add(total(definition('take_items', 'Take inventory items from an explicitly named run agent.', {
    agent: AGENT, item: CONFIG_ID, amount: { type: 'integer', minimum: 1 }
  }, ['agent', 'item', 'amount']), async (args) => {
    const resolved = await resolveConfig('item', args.item);
    if ('error' in resolved) return resolved.error;
    return mutate(args, { kind: 'take_item', item: resolved.value.id, amount: integer(args.amount, 'amount', 1) });
  }));

  add(total(definition('set_skill', 'Set one run agent skill level.', {
    agent: AGENT, skill: { type: 'string' }, level: { type: 'integer', minimum: 1, maximum: 99 }
  }, ['agent', 'skill', 'level']), (args) => mutate(args, {
    kind: 'set_skill', skill: text(args.skill, 'skill').toLocaleLowerCase(), level: integer(args.level, 'level', 1, 99)
  })));

  add(total(definition('heal', 'Heal a run agent, fully when amount is omitted.', {
    agent: AGENT, amount: { type: 'integer', minimum: 1 }
  }, ['agent']), (args) => mutate(args, {
    kind: 'heal', ...(args.amount === undefined ? {} : { amount: integer(args.amount, 'amount', 1) })
  })));

  add(total(definition('damage', 'Damage an explicitly named run agent.', {
    agent: AGENT, amount: { type: 'integer', minimum: 1 }
  }, ['agent', 'amount']), (args) => mutate(args, { kind: 'damage', amount: integer(args.amount, 'amount', 1) })));

  add(total(definition('teleport', 'Teleport a run agent to a tile or the first ring tile near another agent.', {
    agent: AGENT, at: TILE_SCHEMA, near_agent: AGENT
  }, ['agent']), (args) => {
    const anchored = anchor(args, true);
    if ('error' in anchored) return anchored.error;
    return mutate(args, { kind: 'teleport', at: anchored.value });
  }));

  add(total(definition('despawn', 'Despawn a non-agent live entity.', {
    entity: { type: 'integer', minimum: 1 }
  }, ['entity']), (args) => {
    const entity = integer(args.entity, 'entity', 1);
    const owner = deps.view.agents().find((agent) => agent.entity === entity);
    if (owner !== undefined) return { error: `entity belongs to run agent ${owner.id}` };
    return callMcp('despawn_entity', { entity });
  }));

  add(total(definition('list_placements', 'List runtime placements in this instance.', {}), () => callMcp('list_placements', {})));
  add(total(definition('remove_placement', 'Remove one runtime placement by placement id.', {
    placement_id: { type: 'string' }
  }, ['placement_id']), (args) => callMcp('remove_placement', { placement_id: text(args.placement_id, 'placement_id') })));

  add(total(definition('report_to_director', 'Report the completed admin change back to the run director.', {
    text: { type: 'string' }
  }, ['text']), (args) => {
    const raw = text(args.text, 'text');
    const report = deps.world.adminToken === undefined ? raw : raw.replaceAll(deps.world.adminToken, '[redacted]');
    deps.reportToDirector(report);
    deps.bus.emit('admin.report', { text: report });
    return { ok: true };
  }));

  const allowed = new Set(ADMIN_MCP_TOOLS);
  for (const mcpTool of deps.mcp.tools()) {
    if (!allowed.has(mcpTool.name)) continue;
    const declared = declaredProperties(mcpTool.inputSchema);
    add(total({
      name: `mcp_${mcpTool.name}`,
      description: `MCP: ${mcpTool.description ?? mcpTool.name}`,
      parameters: mcpTool.inputSchema
    }, (args) => callMcp(mcpTool.name, args, declared)));
  }

  return tools;
}
