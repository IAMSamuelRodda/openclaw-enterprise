// Bookkeeping for stops whose Gateway drain yielded to other Work (AGENT_STOP_YIELDED).

const STOP_YIELD_RECHECK_MIN_MS = 1_000;
const STOP_YIELD_RECHECK_MAX_MS = 5_000;
// The recheck reaches its 5 s cap 50 s into the stop. A Kubernetes Gateway drains for up to
// 315 s, so most of a long drain is rechecked every 5 s, and a finished drain is noticed
// within 5 s (finding 1093).
const STOP_YIELD_RECHECK_AGE_DIVISOR = 10;
/** A yielded stop's `worker.completed` line is written at most this often (finding 1094). */
export const STOP_YIELD_LOG_INTERVAL_MS = 60_000;
// A yielded stop this worker has not run again for this long is forgotten: it counts as due
// Work once more, and its next yield is logged. Longer than any wait between two passes of a
// draining stop (a recheck of at most 5 s behind another pass of at most about 340 s).
const STOP_YIELD_FORGET_MS = 600_000;

/** When work whose stop yielded runs again: 1 s, growing with its age to 5 s at 50 s. */
export function stopYieldRecheckMs(ageMs: number): number {
  return Math.min(
    STOP_YIELD_RECHECK_MAX_MS,
    Math.max(STOP_YIELD_RECHECK_MIN_MS, Math.round(ageMs / STOP_YIELD_RECHECK_AGE_DIVISOR)),
  );
}

interface YieldedStop {
  readonly loggedAt: number;
  readonly yields: number;
  readonly yieldedAt: number;
}

/**
 * The work items whose latest pass in this worker yielded its stop. Two uses (finding 1093,
 * finding 1094):
 * - A draining stop does not yield to these: they are draining stops too, whose next pass only
 *   rechecks their own drain. Several stops draining at once would otherwise yield to each
 *   other and repeat their passes back to back for the whole drain.
 * - Their `worker.completed` lines are throttled: the first yield is logged, then at most one
 *   a minute, each with the work's yield count so far.
 *
 * The record is this worker's own: after a restart, or for another worker's stops, the first
 * yield counts as due Work and is logged, as before.
 */
export class StopYields {
  private readonly stops = new Map<string, YieldedStop>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Records that `key`'s pass yielded its stop. Returns the yield count when it should be logged. */
  yielded(key: string): number | undefined {
    const now = this.now();
    this.prune(now);
    const previous = this.stops.get(key);
    const yields = (previous?.yields ?? 0) + 1;
    if (previous !== undefined && now - previous.loggedAt < STOP_YIELD_LOG_INTERVAL_MS) {
      this.stops.set(key, { loggedAt: previous.loggedAt, yields, yieldedAt: now });
      return undefined;
    }
    this.stops.set(key, { loggedAt: now, yields, yieldedAt: now });
    return yields;
  }

  /** `key`'s pass ended without yielding its stop: it is no longer a yielded stop. */
  settled(key: string): void {
    this.stops.delete(key);
  }

  /** The keys of work whose latest pass yielded its stop, which a draining stop does not yield to. */
  waiting(): string[] {
    this.prune(this.now());
    return [...this.stops.keys()];
  }

  private prune(now: number): void {
    for (const [key, stop] of this.stops) {
      if (now - stop.yieldedAt >= STOP_YIELD_FORGET_MS) {
        this.stops.delete(key);
      }
    }
  }
}
