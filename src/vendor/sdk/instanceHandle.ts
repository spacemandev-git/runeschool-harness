import type { RuneSchool } from './client.ts';
import { BotActions, type BotActionsOptions } from './actions.ts';
import { InstanceStream } from './stream.ts';
import type { ReconnectingStream } from './supervisor.ts';
import { createWorldModel } from './worldModel.ts';
import type { WorldModel, WorldModelOptions } from './percept.ts';
import type { EntityId } from '../shared/index.ts';
import type {
  ConnectOptions,
  DestroyResult,
  EntityView,
  EventsResult,
  InstanceAuthCredentials,
  InstanceDetail
} from './types.ts';

export class InstanceHandle {
  constructor(
    private readonly client: RuneSchool,
    readonly id: string,
    readonly auth?: InstanceAuthCredentials
  ) {}

  info(): Promise<InstanceDetail> {
    return this.client.request(this.path());
  }

  async entities(): Promise<readonly EntityView[]> {
    const result = await this.client.request<{ readonly entities: readonly EntityView[] }>(
      this.path('/entities')
    );
    return result.entities;
  }

  events(since?: number, limit?: number): Promise<EventsResult> {
    const query = new URLSearchParams();
    if (since !== undefined) query.set('since', String(since));
    if (limit !== undefined) query.set('limit', String(limit));
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    return this.client.request(`${this.path('/events')}${suffix}`);
  }

  step(ticks: number): Promise<InstanceDetail> {
    return this.post('/step', { ticks });
  }

  start(): Promise<InstanceDetail> {
    return this.post('/start');
  }

  stopRealtime(): Promise<InstanceDetail> {
    return this.post('/stop');
  }

  destroy(): Promise<DestroyResult> {
    return this.client.lifecycleRequest(
      this.path(),
      { method: 'DELETE' },
      this.auth?.admin
    );
  }

  connect(since?: number, opts?: ConnectOptions): Promise<InstanceStream> {
    return InstanceStream.connect(this.client.streamUrl(this.id, since), this.id, opts);
  }

  actions(stream: InstanceStream | ReconnectingStream, entity: EntityId, opts?: BotActionsOptions): BotActions {
    return new BotActions(stream, createWorldModel(this, stream, entity), entity, opts);
  }

  worldModel(stream: InstanceStream | ReconnectingStream, entity: EntityId, opts?: WorldModelOptions): WorldModel {
    return createWorldModel(this, stream, entity, opts);
  }

  /** @internal Instance-relative read used by the SDK world model. */
  request<T>(suffix: string): Promise<T> {
    return this.client.request(this.path(suffix));
  }

  /** @internal Origin-relative read used for shared definition dictionaries. */
  requestRoot<T>(path: string): Promise<T> {
    return this.client.request(path);
  }

  private path(suffix = ''): string {
    return `/instances/${encodeURIComponent(this.id)}${suffix}`;
  }

  private post<T>(suffix: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method: 'POST' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return this.client.lifecycleRequest(this.path(suffix), init, this.auth?.admin);
  }
}
