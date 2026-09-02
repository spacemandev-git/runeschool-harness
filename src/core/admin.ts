/**
 * The admin persona — the run's "game master". An operator-facing LLM that holds the admin
 * authority the simulation grants to whoever created the instance (custody sits inside the harness's
 * MCP session, or comes from `attach.adminToken`) and changes the world on request: spawn NPCs,
 * place locs/buildings, drop loot, grant items and levels, heal, teleport, despawn.
 *
 * It is deliberately separate from the director: the director plans the run and steers agents;
 * the admin edits the world. The director delegates with its `ask_admin` tool (a mailbox message
 * to `admin`), and the admin answers through `reportToDirector`. Agents never talk to the admin.
 *
 * Built by `harness/src/admin/` (see docs/features/harness-admin.md); wired by the runtime.
 */
import type { HarnessBus } from './bus.ts';
import type { ChatMessage, ModelRegistry } from './model.ts';
import type { PromptLibrary } from './prompts.ts';
import type { RuntimeView } from './runtime.ts';
import type { DefsReader, McpSession, ProvisionedWorld } from './transport.ts';

export interface Admin {
  /** Operator chat; resolves when the resulting turn (including tool calls) completes. */
  say(text: string): Promise<void>;
  /** Wake for pending mailbox messages (director requests). No-op while a turn is queued. */
  notify(): void;
  transcript(): readonly ChatMessage[];
  dispose(): void;
}

export interface AdminInbound {
  readonly from: string;
  readonly text: string;
  readonly at: number;
}

export interface AdminDeps {
  readonly world: ProvisionedWorld;
  readonly mcp: McpSession;
  /** `/defs/names` dictionaries for name -> config-id resolution (npcs, items, locs). */
  readonly defs: DefsReader;
  /** Live agent rows (entity ids, positions, hp) and snapshots for "near agent X" placement. */
  readonly view: RuntimeView;
  readonly models: ModelRegistry;
  readonly prompts: PromptLibrary;
  readonly bus: HarnessBus;
  /** Drain messages addressed to `admin` (director `ask_admin`, operator relays). */
  readonly drainInbound: () => readonly AdminInbound[];
  /** Deliver a report to the director mailbox (also emitted as `admin.report`). */
  readonly reportToDirector: (text: string) => void;
  /** Start a turn automatically when `notify()` finds inbound messages (true headless). */
  readonly autoWake: boolean;
}

export type AdminFactory = (deps: AdminDeps) => Admin;

/**
 * MCP tools the admin may call directly (in addition to its curated, name-resolving tools).
 * Everything else on the MCP surface stays with the director.
 */
export const ADMIN_MCP_TOOLS: readonly string[] = Object.freeze([
  'place',
  'list_placements',
  'remove_placement',
  'mutate_entity',
  'despawn_entity',
  'add_player',
  'control_instance',
  'mutate_map',
  'set_chunk_policy',
  'save_world',
  'get_instance',
  'get_chunks',
  'search_assets',
  'get_asset',
  'list_equipment'
]);
