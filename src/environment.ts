export const DEFAULT_ROUTER_API_BASE = 'http://127.0.0.1:8000/v1';
export const DEFAULT_ROUTER_MODEL = 'openai/gpt-5.5-pro';
export const DEFAULT_RUNESCHOOL_API_BACKEND = 'http://127.0.0.1:7800';

type Environment = Readonly<Record<string, string | undefined>>;

/** Non-secret environment settings shared by a harness host and its model registry. */
export interface HarnessEnvironment {
  readonly routerApiBase: string;
  readonly routerModel: string;
  readonly runeschoolApiBackend: string;
  readonly runeschoolMcpUrl: string;
  readonly runeschoolUiUrl?: string;
}

function setting(env: Environment, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? fallback : value;
}

function optionalSetting(env: Environment, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Read the public endpoint/model settings from environment variables. `ROUTER_API_KEY` is
 * deliberately not returned: the model registry resolves it directly and never puts it into a
 * displayable runtime configuration.
 */
export function loadHarnessEnvironment(env: Environment = process.env): HarnessEnvironment {
  const runeschoolApiBackend = trimTrailingSlashes(
    setting(env, 'RUNESCHOOL_API_BACKEND', DEFAULT_RUNESCHOOL_API_BACKEND)
  );
  const runeschoolMcpUrl = trimTrailingSlashes(
    optionalSetting(env, 'RUNESCHOOL_MCP_URL', 'AISCAPE_MCP_URL') ?? `${runeschoolApiBackend}/mcp`
  );
  const runeschoolUiUrl = optionalSetting(env, 'RUNESCHOOL_UI_URL', 'AISCAPE_UI_URL');
  return {
    routerApiBase: setting(env, 'ROUTER_API_BASE', DEFAULT_ROUTER_API_BASE),
    routerModel: setting(env, 'ROUTER_MODEL', DEFAULT_ROUTER_MODEL),
    runeschoolApiBackend,
    runeschoolMcpUrl,
    ...(runeschoolUiUrl === undefined ? {} : { runeschoolUiUrl: trimTrailingSlashes(runeschoolUiUrl) })
  };
}
