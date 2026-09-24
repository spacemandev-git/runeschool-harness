/**
 * Recording contracts. A recorder captures the spectator client's chromeless `#/record/<instance>`
 * route in a headless browser and produces one video per camera ("target"). The runtime owns when
 * recording starts and stops; the recorder owns browsers, pages, capture, and transcoding.
 */
import type { AgentId } from './types.ts';

/** Named output sizes. `2k` follows the common video-tooling meaning of QHD (2560×1440). */
export const RECORDING_RESOLUTIONS = {
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2k': { width: 2560, height: 1440 },
} as const satisfies Readonly<Record<string, RecordingResolution>>;
export type RecordingResolutionName = keyof typeof RECORDING_RESOLUTIONS;

export interface RecordingResolution {
  readonly width: number;
  readonly height: number;
}

/** What one camera records. */
export type RecordingTarget =
  | { readonly kind: 'overview'; readonly orbit?: boolean; readonly span?: number }
  | { readonly kind: 'agent'; readonly agentId: AgentId };

export interface RecordingRequest {
  readonly resolution: RecordingResolution;
  readonly targets: readonly RecordingTarget[];
  /** Also open a follow camera for every agent spawned while the session is active. */
  readonly followNewAgents?: boolean;
  /** Stop every camera after this many seconds. */
  readonly maxSeconds?: number;
  /** Keep the intermediate WebM beside the MP4. */
  readonly keepWebm?: boolean;
}

/** `RunConfig.recording`: start recording automatically once the world is provisioned. */
export interface RunRecordingConfig extends RecordingRequest {
  /** Defaults to `<logDir>/recordings/<runId>`. */
  readonly outDir?: string;
}

export type RecordingState = 'starting' | 'recording' | 'finishing' | 'done' | 'failed';

export interface RecordingSummary {
  /** Stable camera id and output basename, e.g. `overview` or `agent-bob`. */
  readonly id: string;
  readonly target: RecordingTarget;
  readonly resolution: RecordingResolution;
  readonly state: RecordingState;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** Absolute path of the produced MP4 (WebM when ffmpeg is unavailable); set once finished. */
  readonly file?: string;
  readonly error?: string;
}

/** Per-run inputs the runtime supplies when it opens a recording session. */
export interface RecordingSession {
  readonly runId: string;
  readonly instanceId: string;
  /** Spectator UI origin, for example `https://runeschool.dev`. */
  readonly uiUrl: string;
  /** Instance server origin the client should talk to (`localStorage['runeschool.client.baseUrl']`). */
  readonly serverUrl: string;
  /** Directory that receives `<id>.mp4` files and `recording.json`. Created if missing. */
  readonly outDir: string;
  readonly resolution: RecordingResolution;
  readonly keepWebm?: boolean;
  /** Resolve an agent id to the entity display name the recorder route follows. */
  entityName(agentId: AgentId): Promise<string>;
}

export interface RecordingSessionHandle {
  list(): readonly RecordingSummary[];
  /** Open one camera; resolves when its page is ready, rejects (and records a failed summary) otherwise. */
  add(target: RecordingTarget): Promise<RecordingSummary>;
  /** Stop one camera or, without an id, every camera; resolves after transcoding with final summaries. */
  stop(id?: string): Promise<readonly RecordingSummary[]>;
  /** Close browsers and release resources; stops anything still recording. */
  close(): Promise<void>;
  onChange(listener: (summary: RecordingSummary) => void): () => void;
}

export interface Recorder {
  open(session: RecordingSession): Promise<RecordingSessionHandle>;
}

export function recordingTargetId(target: RecordingTarget): string {
  return target.kind === 'overview' ? 'overview' : `agent-${target.agentId}`;
}

/** Accepts a preset name (`1080p`, `1440p`, `2k`) or `<width>x<height>` with even dimensions. */
export function parseRecordingResolution(text: string): RecordingResolution {
  const key = text.trim().toLowerCase();
  if (key in RECORDING_RESOLUTIONS) return RECORDING_RESOLUTIONS[key as RecordingResolutionName];
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(key);
  if (match === null) {
    throw new Error(`resolution '${text}' must be one of ${Object.keys(RECORDING_RESOLUTIONS).join(', ')} or <width>x<height>`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width % 2 !== 0 || height % 2 !== 0 || width < 320 || height < 240 || width > 7680 || height > 4320) {
    throw new Error(`resolution '${text}' must use even dimensions between 320x240 and 7680x4320`);
  }
  return { width, height };
}

/**
 * Parses camera tokens: `overview`, `agents` (every current and future agent), `agent:<id>`.
 * Duplicates collapse; `agents` sets `followNewAgents`.
 */
export function parseRecordingTargets(tokens: readonly string[]): { readonly targets: readonly RecordingTarget[]; readonly followNewAgents: boolean } {
  const targets: RecordingTarget[] = [];
  let followNewAgents = false;
  const seen = new Set<string>();
  const push = (target: RecordingTarget): void => {
    const id = recordingTargetId(target);
    if (seen.has(id)) return;
    seen.add(id);
    targets.push(target);
  };
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === 'overview') push({ kind: 'overview', orbit: true });
    else if (token === 'agents') followNewAgents = true;
    else if (token.startsWith('agent:')) {
      const agentId = token.slice('agent:'.length).trim();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(agentId)) throw new Error(`invalid recording target '${raw}': agent id must match ^[a-z0-9][a-z0-9-]{0,31}$`);
      push({ kind: 'agent', agentId });
    } else throw new Error(`invalid recording target '${raw}': expected overview, agents, or agent:<id>`);
  }
  return { targets, followNewAgents };
}
