/**
 * The API client's handling of a build with no API address.
 *
 * This is tested because the failure it replaces was actively misleading. A
 * production build with no VITE_API_URL sends requests to its own static host,
 * which rewrites everything to index.html and answers a POST with 405. The
 * signup form showed "Request failed (405)" — a message that names no cause and
 * points nowhere, for a problem that is one environment variable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Load a fresh copy of the client with import.meta.env stubbed. */
async function clientWith(env) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return import('./client.js');
}

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a production build with no VITE_API_URL', () => {
  it('REFUSES BEFORE THE NETWORK RATHER THAN POSTING TO ITSELF', async () => {
    const { api } = await clientWith({ PROD: true, VITE_API_URL: '' });

    await expect(api.login({ email: 'a@b.np', password: 'password-long-enough' })).rejects.toThrow(/VITE_API_URL/);
    // The point of failing early: the static host never gets the chance to
    // answer 405, so the user never sees a status code standing in for a cause.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('says the value is baked in at build time', async () => {
    const { api } = await clientWith({ PROD: true, VITE_API_URL: '' });

    // Without this, the obvious fix — set it in the dashboard — appears not to
    // work, because the deployed bundle is unchanged until it is rebuilt.
    await expect(api.login({ email: 'a@b.np', password: 'password-long-enough' })).rejects.toThrow(/REDEPLOY|build time/);
  });
});

describe('a correctly configured build', () => {
  it('calls the configured API origin', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ accessToken: 'a', refreshToken: 'r' }),
    });

    const { api } = await clientWith({ PROD: true, VITE_API_URL: 'https://api.example.com' });
    await api.login({ email: 'a@b.np', password: 'password-long-enough' });

    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/auth/login');
  });

  it('a trailing slash on the configured URL does not double up', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ accessToken: 'a', refreshToken: 'r' }),
    });

    const { api } = await clientWith({ PROD: true, VITE_API_URL: 'https://api.example.com/' });
    await api.login({ email: 'a@b.np', password: 'password-long-enough' });

    expect(global.fetch.mock.calls[0][0]).toBe('https://api.example.com/api/auth/login');
  });
});

describe('development', () => {
  it('a relative base is fine, because Vite proxies it', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ accessToken: 'a', refreshToken: 'r' }),
    });

    const { api } = await clientWith({ PROD: false, VITE_API_URL: '' });
    await api.login({ email: 'a@b.np', password: 'password-long-enough' });

    expect(global.fetch.mock.calls[0][0]).toBe('/api/auth/login');
  });
});
