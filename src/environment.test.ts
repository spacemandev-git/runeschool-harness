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
      runeschoolApiBackend: 'https://api.runeschool.example'
    });
  });

  test('uses local defaults for missing and blank values', () => {
    expect(loadHarnessEnvironment({ ROUTER_API_BASE: ' ', RUNESCHOOL_API_BACKEND: '' })).toEqual({
      routerApiBase: DEFAULT_ROUTER_API_BASE,
      routerModel: DEFAULT_ROUTER_MODEL,
      runeschoolApiBackend: DEFAULT_RUNESCHOOL_API_BACKEND
    });
  });
});
