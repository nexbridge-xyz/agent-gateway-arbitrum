import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The made-up data sets are a tool for building the console. A production build must not offer them.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('made-up data', () => {
  it('can be chosen in a development build, by the switch or in the address', async () => {
    window.history.replaceState(null, '', '/?data=worst');
    vi.resetModules();
    const data = await import('@/lib/data');
    expect(data.MADE_UP_DATA).toBe(true);
    expect(renderHook(() => data.useDataMode()).result.current).toBe('worst');
  });

  it('cannot be chosen in a production build, whatever the address or the storage says', async () => {
    vi.stubEnv('DEV', false);
    window.history.replaceState(null, '', '/?data=worst');
    window.localStorage.setItem('agent-gateway-console:data', 'empty');
    vi.resetModules();
    const data = await import('@/lib/data');
    expect(data.MADE_UP_DATA).toBe(false);
    expect(renderHook(() => data.useDataMode()).result.current).toBe('live');

    data.setDataMode('worst');
    expect(renderHook(() => data.useDataMode()).result.current).toBe('live');
  });
});
