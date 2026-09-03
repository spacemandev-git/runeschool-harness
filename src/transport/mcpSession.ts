import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EXAMPLE_SCENARIO_NAMES } from '../vendor/scenario/examples.ts';
import type { JsonValue, TileCoord } from '#protocol';
import type {
  ActorCredentials,
  AddPlayerRequest,
  HarnessBus,
  McpSession,
  McpToolInfo,
  ProvisionedWorld,
  WorldSelection
} from '../core/index.ts';

const EXAMPLE_SCENARIOS: ReadonlySet<string> = new Set(EXAMPLE_SCENARIO_NAMES);

type ToolCaller = (
  name: string,
  args?: Readonly<Record<string, unknown>>
) => Promise<JsonValue>;

export class McpToolError extends Error {
  constructor(readonly tool: string, readonly text: string) {
    super(`MCP tool '${tool}' failed: ${text}`);
    this.name = 'McpToolError';
  }
}

export class NoUsableRegion extends Error {
  constructor(readonly query: string) {
    super(`NoUsableRegion(${JSON.stringify(query)}): no result had a numeric regionId and spawn`);
    this.name = 'NoUsableRegion';
  }
}

export class SandboxNeedsPlayers extends Error {
  constructor() {
    super('SandboxNeedsPlayers: sandbox provisioning requires at least one player');
    this.name = 'SandboxNeedsPlayers';
  }
}

export class SpawnRequired extends Error {
  constructor(readonly instanceId: string) {
    super(`SpawnRequired(${JSON.stringify(instanceId)}): addPlayer needs spawnAt and no default spawn is recorded`);
    this.name = 'SpawnRequired';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTile(value: unknown): value is TileCoord {
  return isRecord(value)
    && typeof value.x === 'number'
    && typeof value.z === 'number'
    && typeof value.level === 'number';
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`MCP result missing object field '${path}'`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`MCP result missing string field '${path}'`);
  }
  return value;
}

function requiredNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`MCP result missing numeric field '${path}'`);
  }
  return value;
}

export interface ParsedJoin {
  readonly instanceId: string;
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly actors: readonly ActorCredentials[];
}

function parseJoinInfo(value: unknown, path = 'joinInfo'): ParsedJoin {
  const join = requiredRecord(value, path);
  const instanceId = requiredString(join.instanceId, `${path}.instanceId`);
  const httpUrl = requiredString(join.httpUrl, `${path}.httpUrl`);
  const wsUrl = requiredString(join.wsUrl, `${path}.wsUrl`);
  if (!Array.isArray(join.actors)) throw new Error(`MCP result missing array field '${path}.actors'`);
  const actors = join.actors.map((candidate, index): ActorCredentials => {
    const actor = requiredRecord(candidate, `${path}.actors[${index}]`);
    return {
      instanceId,
      httpUrl,
      wsUrl,
      tag: requiredString(actor.tag, `${path}.actors[${index}].tag`),
      entity: requiredNumber(actor.entity, `${path}.actors[${index}].entity`),
      token: requiredString(actor.token, `${path}.actors[${index}].token`)
    };
  });
  return { instanceId, httpUrl, wsUrl, actors };
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '0.0.0.0'
]);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTNAMES.has(normalized);
}

function rebaseJoinUrl(value: string, mcp: URL, websocket: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (!isLoopbackHostname(parsed.hostname)) return value;
  parsed.protocol = websocket
    ? (mcp.protocol === 'https:' ? 'wss:' : 'ws:')
    : mcp.protocol;
  parsed.hostname = mcp.hostname;
  parsed.port = mcp.port;
  return parsed.toString();
}

export function rebaseJoinUrls(join: ParsedJoin, mcpUrl: string): {
  readonly join: ParsedJoin;
  readonly rebased: boolean;
} {
  const mcp = new URL(mcpUrl);
  if (isLoopbackHostname(mcp.hostname)) return { join, rebased: false };

  const httpUrl = rebaseJoinUrl(join.httpUrl, mcp, false);
  const wsUrl = rebaseJoinUrl(join.wsUrl, mcp, true);
  let actorsRebased = false;
  const actors = join.actors.map((actor): ActorCredentials => {
    const actorHttpUrl = rebaseJoinUrl(actor.httpUrl, mcp, false);
    const actorWsUrl = rebaseJoinUrl(actor.wsUrl, mcp, true);
    if (actorHttpUrl === actor.httpUrl && actorWsUrl === actor.wsUrl) return actor;
    actorsRebased = true;
    return { ...actor, httpUrl: actorHttpUrl, wsUrl: actorWsUrl };
  });
  const rebased = httpUrl !== join.httpUrl || wsUrl !== join.wsUrl || actorsRebased;
  return rebased
    ? { join: { ...join, httpUrl, wsUrl, actors }, rebased: true }
    : { join, rebased: false };
}

function resultText(result: unknown): string {
  const first = isRecord(result) && Array.isArray(result.content) ? result.content[0] : undefined;
  if (!isRecord(first) || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('MCP tool did not return text content as its first content item');
  }
  return first.text;
}

function asJsonValue(value: unknown, label: string): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    throw new TypeError(`${label} is not JSON-serialisable`);
  }
}

const SECRET_FIELD = /token|api[-_]?key|authorization|secret|mcp[-_]?session[-_]?id/i;

function redactSecrets(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SECRET_FIELD.test(key) ? '[REDACTED]' : redactSecrets(entry)
  ]));
}

function safePreview(text: string): string {
  try {
    return JSON.stringify(redactSecrets(JSON.parse(text) as JsonValue)).slice(0, 200);
  } catch {
    return text.replace(
      /((?:token|api[-_]?key|authorization|secret)\s*[:=]\s*)([^,;\s]+)/gi,
      '$1[REDACTED]'
    ).slice(0, 200);
  }
}

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    for (const key of parsed.searchParams.keys()) {
      if (SECRET_FIELD.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return parsed.toString();
  } catch {
    return safePreview(value);
  }
}

function pvpArgs(pvp: boolean | undefined): Record<string, unknown> {
  return pvp === undefined ? {} : { pvp };
}

function firstScenarioSpawn(doc: unknown): TileCoord | undefined {
  if (!isRecord(doc) || !Array.isArray(doc.actors)) return undefined;
  const first = doc.actors[0];
  return isRecord(first) && isTile(first.spawnAt) ? first.spawnAt : undefined;
}

function withoutJoinInfo(value: Record<string, unknown>): JsonValue {
  const { joinInfo: _joinInfo, ...context } = value;
  return asJsonValue(context, 'resume context');
}

interface SessionFactoryOptions {
  readonly call?: ToolCaller;
  readonly client?: Client;
  readonly transport?: StreamableHTTPClientTransport;
}

/** The optional third argument is an internal test seam; production callers use `(url, bus)`. */
export function createMcpSession(
  url: string,
  bus: HarnessBus,
  factory: SessionFactoryOptions = {}
): McpSession {
  const client = factory.client ?? new Client({ name: 'runeschool-harness', version: '0.1.0' });
  const transport = factory.transport ?? new StreamableHTTPClientTransport(new URL(url));
  const defaults = new Map<string, TileCoord>();
  let toolCache: readonly McpToolInfo[] = [];
  let connected = false;

  const rawCall: ToolCaller = factory.call ?? (async (name, args = {}) => {
    const startedAt = Date.now();
    let text = '';
    let ok = false;
    try {
      const result = await client.callTool({ name, arguments: args });
      text = resultText(result);
      if (isRecord(result) && result.isError === true) throw new McpToolError(name, text);
      ok = true;
      try {
        return JSON.parse(text) as JsonValue;
      } catch {
        return text;
      }
    } finally {
      bus.emit('mcp.tool', {
        name,
        arguments: redactSecrets(asJsonValue(args, 'MCP arguments')),
        ok,
        durationMs: Date.now() - startedAt,
        resultPreview: safePreview(text)
      });
    }
  });

  async function emitProvisioned(world: ProvisionedWorld, watchUrl?: string): Promise<ProvisionedWorld> {
    // `world.provisioned` is emitted by the runtime orchestrator (it knows the spectator watchUrl).

    if (world.defaultSpawn !== undefined) defaults.set(world.instanceId, world.defaultSpawn);
    return world;
  }

  return {
    url,
    async connect(): Promise<void> {
      if (connected) return;
      if (factory.call === undefined) {
        await client.connect(transport);
        const listed = await client.listTools();
        toolCache = listed.tools.map((tool): McpToolInfo => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          inputSchema: asJsonValue(tool.inputSchema, `input schema for ${tool.name}`)
        }));
      }
      connected = true;
      bus.emit('mcp.connected', { url: safeUrl(url), tools: toolCache.map((tool) => tool.name) });
    },
    tools(): readonly McpToolInfo[] {
      return toolCache;
    },
    call: rawCall,
    async provision(selection: WorldSelection, players: readonly AddPlayerRequest[]): Promise<ProvisionedWorld> {
      if (selection.kind === 'attach') {
        return await emitProvisioned({
          instanceId: selection.instanceId,
          httpUrl: selection.httpUrl,
          wsUrl: selection.wsUrl,
          kind: 'attached',
          actors: selection.actors,
          context: {},
          ...(selection.adminToken === undefined ? {} : { adminToken: selection.adminToken }),
          ...(selection.defaultSpawn === undefined ? {} : { defaultSpawn: selection.defaultSpawn })
        });
      }

      let result: JsonValue;
      let kind: ProvisionedWorld['kind'];
      let context: JsonValue;
      let defaultSpawn: TileCoord | undefined;
      if (selection.kind === 'scenario') {
        kind = 'scenario';
        if (EXAMPLE_SCENARIOS.has(selection.name)) {
          const doc = await rawCall('get_example_scenario', { name: selection.name });
          result = await rawCall('start_scenario', {
            doc,
            seed: selection.seed,
            realtime: true,
            ...pvpArgs(selection.pvp)
          });
          context = doc;
          defaultSpawn = firstScenarioSpawn(doc);
        } else {
          result = await rawCall('start_scenario', {
            scenario_id: selection.name,
            seed: selection.seed,
            realtime: true,
            ...pvpArgs(selection.pvp)
          });
          const started = requiredRecord(result, 'result');
          context = asJsonValue(started.scenario ?? null, 'started scenario context');
        }
      } else if (selection.kind === 'sandbox') {
        if (players.length === 0) throw new SandboxNeedsPlayers();
        kind = 'sandbox';
        const catalogue = requiredRecord(await rawCall('list_regions', {
          query: selection.query,
          limit: 10
        }), 'list_regions result');
        const regions = Array.isArray(catalogue.regions) ? catalogue.regions : [];
        const region = regions.find((entry) => isRecord(entry)
          && typeof entry.regionId === 'number' && isTile(entry.spawn));
        if (!isRecord(region) || typeof region.regionId !== 'number' || !isTile(region.spawn)) {
          throw new NoUsableRegion(selection.query);
        }
        defaultSpawn = region.spawn;
        result = await rawCall('create_sandbox_world', {
          name: (selection.name ?? `Harness: ${selection.query}`).slice(0, 80),
          regions: [region.regionId],
          players: players.map((player) => ({
            tag: player.tag,
            ...(player.displayName === undefined ? {} : { displayName: player.displayName }),
            spawnAt: player.spawnAt ?? region.spawn,
            ...(player.stats === undefined ? {} : { stats: player.stats }),
            ...(player.inventory === undefined ? {} : { inventory: player.inventory }),
            ...(player.equipment === undefined ? {} : { equipment: player.equipment })
          })),
          seed: selection.seed,
          realtime: true,
          ...pvpArgs(selection.pvp)
        });
        context = asJsonValue({ query: selection.query, region }, 'sandbox context');
      } else {
        kind = 'resumed';
        result = await rawCall('resume_world', { id: selection.worldId, realtime: true });
        context = withoutJoinInfo(requiredRecord(result, 'resume_world result'));
      }

      const resultRecord = requiredRecord(result, 'result');
      const rebasedJoin = rebaseJoinUrls(parseJoinInfo(resultRecord.joinInfo), url);
      if (rebasedJoin.rebased) {
        bus.emit('log', {
          level: 'warn',
          scope: 'mcp',
          message: `MCP advertised loopback join URLs; rebased onto ${new URL(url).origin}`
        });
      }
      const join = rebasedJoin.join;
      const world: ProvisionedWorld = {
        ...join,
        kind,
        context,
        ...(defaultSpawn === undefined ? {} : { defaultSpawn })
      };
      const watchUrl = typeof resultRecord.watchUrl === 'string'
        ? resultRecord.watchUrl
        : isRecord(resultRecord.instance) && typeof resultRecord.instance.watchUrl === 'string'
          ? resultRecord.instance.watchUrl
          : undefined;
      return await emitProvisioned(world, watchUrl);
    },
    async addPlayer(instanceId: string, request: AddPlayerRequest): Promise<ActorCredentials> {
      const spawnAt = request.spawnAt ?? defaults.get(instanceId);
      if (spawnAt === undefined) throw new SpawnRequired(instanceId);
      const result = requiredRecord(await rawCall('add_player', {
        instance_id: instanceId,
        tag: request.tag,
        ...(request.displayName === undefined ? {} : { display_name: request.displayName }),
        spawn_at: spawnAt,
        ...(request.stats === undefined ? {} : { stats: request.stats }),
        ...(request.inventory === undefined ? {} : { inventory: request.inventory }),
        ...(request.equipment === undefined ? {} : { equipment: request.equipment })
      }), 'add_player result');
      const player = requiredRecord(result.player, 'player');
      // Same loopback rebase as provisioning; the warning was already emitted for this world.
      const join = rebaseJoinUrls(parseJoinInfo(result.joinInfo), url).join;
      const tag = requiredString(player.tag, 'player.tag');
      const entity = requiredNumber(player.entity, 'player.entity');
      const token = requiredString(player.token, 'player.token');
      const joined = join.actors.find((actor) => actor.tag === tag && actor.entity === entity);
      return joined ?? {
        instanceId: join.instanceId,
        httpUrl: join.httpUrl,
        wsUrl: join.wsUrl,
        tag,
        entity,
        token
      };
    },
    async close(): Promise<void> {
      try {
        await client.close();
      } catch (error) {
        bus.emit('log', {
          level: 'warn',
          scope: 'mcp',
          message: 'MCP client close failed',
          data: { error: safePreview(error instanceof Error ? error.message : String(error)) }
        });
      }
    }
  };
}
