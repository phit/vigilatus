import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isTransientNetworkError, TapoSession, waitForControlPort } from '../electron/tapo/tapoSession';
import type { ApiResponse } from '../electron/tapo/recordingParse';

async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

describe('isTransientNetworkError', () => {
  it('matches connection-dropped errors', () => {
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
    expect(isTransientNetworkError(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransientNetworkError(new Error('write EPIPE'))).toBe(true);
    expect(isTransientNetworkError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe(true);
    expect(isTransientNetworkError(new Error('Request timed out (HTTPS 1.2.3.4:443)'))).toBe(true);
  });

  it('does not match application-level errors', () => {
    expect(isTransientNetworkError(new Error('Invalid JSON from camera'))).toBe(false);
    expect(isTransientNetworkError(new Error('Secure login: invalid device confirm'))).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });
});

describe('waitForControlPort', () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server!.close(resolve));
      server = undefined;
    }
  });

  it('resolves immediately when the port is open', async () => {
    server = net.createServer();
    const port = await getFreePort();
    await new Promise<void>((resolve) => server!.listen(port, '127.0.0.1', resolve));

    await expect(waitForControlPort('127.0.0.1', port)).resolves.toBeUndefined();
  });

  it('keeps knocking until a sleeping camera wakes up', async () => {
    const port = await getFreePort();

    // Simulate a battery camera whose control server only comes up after the
    // first connect attempts have already been refused.
    server = net.createServer();
    setTimeout(() => server!.listen(port, '127.0.0.1'), 250);

    await expect(
      waitForControlPort('127.0.0.1', port, {
        connectTimeoutMs: 500,
        deadlineMs: 3_000,
        retryDelayMs: 100,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects with the unreachable message once the deadline passes', async () => {
    const port = await getFreePort();

    await expect(
      waitForControlPort('127.0.0.1', port, {
        connectTimeoutMs: 500,
        deadlineMs: 400,
        retryDelayMs: 100,
      }),
    ).rejects.toThrow(`Camera control port is unreachable (127.0.0.1:${port})`);
  });
});

describe('TapoSession.apiRequest transient-error retry', () => {
  interface SessionInternals {
    isSecureValue?: boolean;
    stok?: string;
    post: (url: string, body: object, extraHeaders?: Record<string, string>) => Promise<unknown>;
  }

  function makeSession(): { session: TapoSession; internals: SessionInternals } {
    const session = new TapoSession({ host: '127.0.0.1', username: 'admin', password: 'pw' });
    const internals = session as unknown as SessionInternals;
    // Pretend the insecure-firmware probe and login already happened.
    internals.isSecureValue = false;
    internals.stok = 'stok-initial';
    return { session, internals };
  }

  it('re-logs-in and retries once after a dropped connection', async () => {
    const { session, internals } = makeSession();

    const calls: Array<{ method?: string }> = [];
    internals.post = async (_url, body) => {
      calls.push(body as { method?: string });
      if (calls.length === 1) {
        throw new Error('socket hang up');
      }
      if ((body as { method?: string }).method === 'login') {
        return { result: { stok: 'stok-fresh' } } satisfies ApiResponse;
      }
      return { error_code: 0, result: { ok: true } };
    };

    const resp = await session.apiRequest({ method: 'getSomething' });

    expect(resp.error_code).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(['getSomething', 'login', 'getSomething']);
  });

  it('does not retry application-level failures', async () => {
    const { session, internals } = makeSession();

    let postCalls = 0;
    internals.post = async () => {
      postCalls += 1;
      throw new Error('Invalid JSON from camera');
    };

    await expect(session.apiRequest({ method: 'getSomething' })).rejects.toThrow('Invalid JSON from camera');
    expect(postCalls).toBe(1);
  });
});
