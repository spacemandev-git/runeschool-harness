import type { JsonValue } from '#protocol';
import type {
  ActorCredentials,
  AddPlayerRequest,
  AgentIdentityStore,
  AgentSpec,
  HostedWorldClient,
  McpSession,
  ProvisionedWorld,
  WorldSelection,
} from '../core/index.ts';

export function agentPlayerRequest(spec: AgentSpec): AddPlayerRequest {
  return {
    tag: spec.tag ?? spec.id,
    ...(spec.displayName === undefined ? {} : { displayName: spec.displayName }),
    ...(spec.spawn?.at === undefined ? {} : { spawnAt: spec.spawn.at }),
    ...(spec.spawn?.stats === undefined ? {} : { stats: spec.spawn.stats }),
    ...(spec.spawn?.inventory === undefined ? {} : { inventory: spec.spawn.inventory }),
    ...(spec.spawn?.equipment === undefined ? {} : { equipment: spec.spawn.equipment }),
  };
}

export interface ResolveAgentCredentialsOptions {
  readonly selection: WorldSelection;
  readonly spec: AgentSpec;
  readonly world: ProvisionedWorld;
  readonly mcp: McpSession;
  readonly hostedWorld?: HostedWorldClient;
  readonly identities?: AgentIdentityStore;
  readonly warn: (message: string) => void;
}

/** Resolve one actor credential without retaining identity or session-token material. */
export async function resolveAgentCredentials(options: ResolveAgentCredentialsOptions): Promise<ActorCredentials> {
  const { selection, spec, world, mcp } = options;
  if (selection.kind === 'hosted') {
    if (options.hostedWorld === undefined || options.identities === undefined) {
      throw new Error('Hosted-world credentials require a hosted-world client and agent identity store');
    }
    if (spec.spawn !== undefined || spec.tag !== undefined) {
      options.warn(`Agent '${spec.id}' requested a tag or spawn in the shared hosted world; they are ignored because the server assigns the tag and spawn`);
    }
    const identity = await options.identities.ensure(spec.id);
    return await options.hostedWorld.join(identity, { displayName: spec.displayName ?? spec.id });
  }

  const tag = spec.tag ?? spec.id;
  const existing = selection.kind === 'scenario' && spec.useExistingSlot === true && spec.tag === undefined
    ? world.actors[0]
    : world.actors.find((actor) => actor.tag === tag);
  if (selection.kind === 'scenario' && spec.useExistingSlot === true) {
    if (existing === undefined) throw new Error(`Agent '${spec.id}' requested existing actor slot '${tag}', but it was not provisioned`);
    return existing;
  }
  if (selection.kind === 'sandbox') {
    if (existing !== undefined) return existing;
    return await mcp.addPlayer(world.instanceId, agentPlayerRequest(spec));
  }
  if ((selection.kind === 'resume' || selection.kind === 'attach') && existing !== undefined) return existing;
  return await mcp.addPlayer(world.instanceId, agentPlayerRequest(spec));
}

function websocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/stream`;
  return url.toString();
}

/** Read and validate the backend's shared hosted-world status as a provisioned runtime world. */
export async function provisionHostedWorld(client: HostedWorldClient, backendUrl: string): Promise<ProvisionedWorld> {
  const status = await client.status();
  if (status === undefined) {
    throw new Error(`No shared hosted world is available at ${backendUrl}`);
  }
  if (status.status !== 'ready') {
    throw new Error(`Shared hosted world '${status.instanceId}' is not ready (status: ${status.status})`);
  }
  const httpUrl = `${backendUrl.replace(/\/+$/, '')}/instances/${encodeURIComponent(status.instanceId)}`;
  return {
    instanceId: status.instanceId,
    httpUrl,
    wsUrl: websocketUrl(httpUrl),
    kind: 'hosted',
    actors: [],
    context: { kind: 'hosted', ...status } as JsonValue,
  };
}
