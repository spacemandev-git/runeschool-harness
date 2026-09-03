import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ROUTER_API_BASE,
  DEFAULT_ROUTER_MODEL,
  DEFAULT_RUNESCHOOL_API_BACKEND,
  loadHarnessEnvironment
} from './environment.ts';

describe('harness environment', () => {
  test('reads generic router and RuneSchool backend settings', () => {
    expect(loadHarnessEnvironment({
      ROUTER_API_BASE: 'https://router.example/v1',
      ROUTER_MODEL: 'vendor/model',
      ROUTER_API_KEY: 'must-not-be-returned',
      RUNESCHOOL_API_BACKEND: 'https://api.runeschool.example'
    })).toEqual({
      routerApiBase: 'https://router.example/v1',
      routerModel: 'vendor/model',
      runeschoolApiBackend: 'https://api.runeschool.example',
      runeschoolMcpUrl: 'https://api.runeschool.example/mcp'
    });
  });

  test('uses local defaults for missing and blank values', () => {
    expect(loadHarnessEnvironment({ ROUTER_API_BASE: ' ', RUNESCHOOL_API_BACKEND: '' })).toEqual({
      routerApiBase: DEFAULT_ROUTER_API_BASE,
      routerModel: DEFAULT_ROUTER_MODEL,
      runeschoolApiBackend: DEFAULT_RUNESCHOOL_API_BACKEND,
      runeschoolMcpUrl: `${DEFAULT_RUNESCHOOL_API_BACKEND}/mcp`
    });
  });

  test('prefers RuneSchool endpoint overrides and trims trailing slashes', () => {
    expect(loadHarnessEnvironment({
      RUNESCHOOL_API_BACKEND: ' https://api.runeschool.example/// ',
      RUNESCHOOL_MCP_URL: ' https://mcp.runeschool.example/mcp/// ',
      RUNESCHOOL_UI_URL: ' https://play.runeschool.example/// ',
      AISCAPE_MCP_URL: 'https://legacy.example/mcp',
      AISCAPE_UI_URL: 'https://legacy.example'
    })).toMatchObject({
      runeschoolApiBackend: 'https://api.runeschool.example',
      runeschoolMcpUrl: 'https://mcp.runeschool.example/mcp',
      runeschoolUiUrl: 'https://play.runeschool.example'
    });
  });

  test('accepts legacy AISCAPE endpoint aliases', () => {
    expect(loadHarnessEnvironment({
      AISCAPE_MCP_URL: 'https://legacy.example/mcp/',
      AISCAPE_UI_URL: 'https://legacy.example/'
    })).toMatchObject({
      runeschoolMcpUrl: 'https://legacy.example/mcp',
      runeschoolUiUrl: 'https://legacy.example'
    });
  });
});
