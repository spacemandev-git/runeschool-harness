import { InstanceHandle } from './instanceHandle.ts';
import type {
  RuneSchoolOptions,
  CreateInstanceOptions,
  CreateInstanceResponse,
  InstanceSummary
} from './types.ts';

interface ErrorEnvelope {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  readonly errors?: unknown;
}

export class RuneSchoolError extends Error {
  override readonly name = 'RuneSchoolError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export class RuneSchool {
  private readonly baseUrl: string;
  adminToken?: string;

  constructor(baseUrl: string, options: RuneSchoolOptions = {}) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError('baseUrl must use http: or https:');
    }
    parsed.hash = '';
    parsed.search = '';
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.adminToken = options.adminToken;
  }

  async createInstance(opts: CreateInstanceOptions): Promise<InstanceHandle> {
    const detail = await this.request<CreateInstanceResponse>('/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts)
    });
    return new InstanceHandle(this, detail.id, detail.auth);
  }

  listInstances(): Promise<readonly InstanceSummary[]> {
    return this.request('/instances');
  }

  instance(id: string): InstanceHandle {
    return new InstanceHandle(this, id);
  }

  /** @internal Used by InstanceHandle. */
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const body = await this.readBody(response);
    if (!response.ok) {
      const envelope = body as ErrorEnvelope | undefined;
      const code = typeof envelope?.error?.code === 'string'
        ? envelope.error.code
        : 'http_error';
      const message = typeof envelope?.error?.message === 'string'
        ? envelope.error.message
        : `Request failed with HTTP ${response.status}`;
      throw new RuneSchoolError(response.status, code, message, envelope?.errors);
    }
    return body as T;
  }

  /** @internal Used by InstanceHandle for admin-only lifecycle routes. */
  lifecycleRequest<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
    const adminToken = token ?? this.adminToken;
    if (adminToken === undefined) return this.request(path, init);
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${adminToken}`);
    return this.request(path, { ...init, headers });
  }

  /** @internal Used by InstanceHandle. */
  streamUrl(id: string, since?: number): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/instances/${encodeURIComponent(id)}/stream`;
    if (since !== undefined) url.searchParams.set('since', String(since));
    return url.toString();
  }

  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (response.ok) {
        throw new RuneSchoolError(response.status, 'invalid_response', 'Server returned invalid JSON');
      }
      return undefined;
    }
  }
}
