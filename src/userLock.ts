/**
 * Per-user serial lock. Two concurrent copies for the same Telegram
 * user share the same SOL public balance + the same shielded NoteStore;
 * running them in parallel races on the wSOL ATA balance and on the
 * pre-tx leafIndex prediction. We serialize per `tgId` instead of
 * holding one global lock — different users never block each other.
 *
 * `withUserSerial(tgId, fn)` queues `fn` behind any other call for the
 * same id and resolves with `fn`'s return value (or rejection).
 */

const queues = new Map<number, Promise<unknown>>();

export async function withUserSerial<T>(tgId: number, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(tgId) ?? Promise.resolve();
  // Swallow the prior chain's rejection so one user's failure doesn't
  // poison every subsequent call for that user.
  const next = prev.catch(() => undefined).then(fn);
  queues.set(tgId, next);
  try {
    return await next;
  } finally {
    if (queues.get(tgId) === next) queues.delete(tgId);
  }
}

/** Test hook — wipes all queues. Not for prod use. */
export function _resetUserLocks(): void {
  queues.clear();
}
