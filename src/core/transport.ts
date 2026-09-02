/**
 * Transport contracts: MCP session (provisioning + credentials) and per-actor game links.
 */
import type { CommandResult, JsonValue, ServerEvent, TileCoord } from '#protocol';
import type { ActionSink } from './actions.ts';

export interface ActorCredentials {
  readonly instanceId: string;
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly tag: string;
  readonly entity: number;
  readonly token: string;
}

export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
}

export type WorldSelection =
  | { readonly kind: 'scenario'; readonly name: string; readonly seed: number; readonly pvp?: boolean }
  | { readonly kind: 'sandbox'; readonly query: string; readonly seed: number; readonly name?: string; readonly pvp?: boolean }
  | { readonly kind: 'resume'; readonly worldId: string }
  /** Attach to an already-running instance using credentials held elsewhere (e.g. from a config file). */
  | { readonly kind: 'attach'; readonly instanceId: string; readonly httpUrl: string; readonly wsUrl: string; readonly actors: readonly ActorCredentials[]; /** Instance admin token; lets the admin persona act on a world this MCP session did not create. */ readonly adminToken?: string };

export interface ProvisionedWorld {
  readonly instanceId: string;
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly kind: 'scenario' | 'sandbox' | 'resumed' | 'attached';
  /** Actor slots created at provisioning time (tag -> credentials). */
  readonly actors: readonly ActorCredentials[];
  /** Scenario document or region metadata for prompts. */
  readonly context: JsonValue;
  /**
   * Tile used for `addPlayer` when the request omits `spawnAt`: the first actor slot's `spawnAt`
   * for scenarios, the region catalogue spawn for sandboxes. Undefined for resume/attach.
   */
  readonly defaultSpawn?: TileCoord;
  /**
   * Explicit admin token, only for attached worlds. Worlds this MCP session created keep admin
   * custody inside the MCP session, so admin tools need no token; attached worlds must supply one.
   */
  readonly adminToken?: string;
}

export interface AddPlayerRequest {
  readonly tag: string;
  readonly displayName?: string;
  readonly spawnAt?: TileCoord;
  readonly stats?: Readonly<Record<string, number>>;
  readonly inventory?: readonly { readonly item: number; readonly amount?: number }[];
  readonly equipment?: readonly { readonly item: number }[];
}

/** One stateful MCP connection per run. Holds admin/actor credentials in memory only. */
export interface McpSession {
  readonly url: string;
  connect(): Promise<void>;
  tools(): readonly McpToolInfo[];
  /** Raw tool call; returns parsed JSON text content or throws on `isError`. */
  call(name: string, args?: Readonly<Record<string, unknown>>): Promise<JsonValue>;
  /**
   * Create or attach to a world. `players` seeds `create_sandbox_world.players` (a sandbox needs at
   * least one); scenarios use the document's own actor slots and ignore `players`; resume/attach
   * ignore it. Additional actors are minted later with {@link addPlayer}.
   */
  provision(selection: WorldSelection, players: readonly AddPlayerRequest[]): Promise<ProvisionedWorld>;
  addPlayer(instanceId: string, request: AddPlayerRequest): Promise<ActorCredentials>;
  close(): Promise<void>;
}

export type LinkState = 'connecting' | 'open' | 'closed' | 'failed';

/** One claimed actor WebSocket plus REST reads for that instance. */
export interface ActorLink extends ActionSink {
  readonly credentials: ActorCredentials;
  readonly state: LinkState;
  connect(): Promise<void>;
  /** Push subscription for events after `seq`; returns unsubscribe. Events include `event-batch` unpacked. */
  onEvent(listener: (event: ServerEvent) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  /** Buffered events since `seq` (bounded ring). */
  eventsSince(seq: number): readonly ServerEvent[];
  readonly lastSeq: number;
  readonly lastTick: number;
  /** Raw command with explicit entity; used by tests and the operator console. */
  sendRaw(type: string, data: Readonly<Record<string, unknown>>): Promise<CommandResult>;
  /** GET `${httpUrl}${path}`, parsed JSON. `path` starts with `/` or is '' for the instance root. */
  get(path: string): Promise<JsonValue>;
  close(): Promise<void>;
}

/** Instance-independent reads shared by every agent (memoised). */
export interface DefsReader {
  /** `/defs/names` dictionaries. */
  names(): Promise<{ readonly items: Readonly<Record<string, string>>; readonly npcs: Readonly<Record<string, string>>; readonly locs?: Readonly<Record<string, string>> }>;
  region(regionId: number): Promise<JsonValue>;
}
