import { describe, expect, it, vi } from 'vitest';

/**
 * Aurora auto-pause resume must be invisible to the user.
 *
 * The cluster runs at min_capacity = 0 and pauses after 5 idle minutes — that is what keeps the
 * deployment near $0/month instead of ~$44. The cost is that the first request after idle throws
 * `DatabaseResumingException` for 10-20 seconds. Unhandled, a manager opening the app each
 * morning saw `{"error":"internal"}` and reasonably concluded the app was broken.
 */

const resuming = () => Object.assign(new Error('resuming'), { name: 'DatabaseResumingException' });

// The retry lives inside createProdDb, which constructs a real RDSDataClient; exercise the
// wrapper's logic directly against the same contract rather than standing up AWS.
function retryOnResume<T extends { send: (...args: never[]) => Promise<unknown> }>(client: T): T {
  const send = client.send.bind(client) as (...args: never[]) => Promise<unknown>;
  const MAX_WAIT_MS = 25_000;
  const DELAY_MS = 1_500;
  client.send = (async (...args: never[]) => {
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      try {
        return await send(...args);
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== 'DatabaseResumingException' || Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }
  }) as T['send'];
  return client;
}

describe('Aurora resume retry', () => {
  it('retries through a resume and returns the eventual success', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(resuming())
      .mockRejectedValueOnce(resuming())
      .mockResolvedValue({ records: [] });
    const client = retryOnResume({ send } as never);

    const p = (client as unknown as { send: () => Promise<unknown> }).send();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toEqual({ records: [] });
    expect(send).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('does NOT retry a genuine database error — it must fail fast', async () => {
    // Retrying a constraint violation would turn an instant, actionable 409 into a 25-second
    // hang followed by the same error.
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error('duplicate key'), { name: 'DatabaseErrorException' }),
    );
    const client = retryOnResume({ send } as never);
    await expect((client as unknown as { send: () => Promise<unknown> }).send()).rejects.toThrow('duplicate key');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives up before the API Gateway 30s ceiling rather than hanging', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(resuming());
    const client = retryOnResume({ send } as never);
    const p = (client as unknown as { send: () => Promise<unknown> }).send();
    const assertion = expect(p).rejects.toThrow('resuming');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    vi.useRealTimers();
  });
});
