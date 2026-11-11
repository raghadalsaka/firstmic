const WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

/** In-memory sliding one-minute limiter, keyed by e.g. IP. One instance per endpoint family. */
export function createRateLimiter(maxPerMinute: number): (key: string) => boolean {
  const attempts = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    recent.push(now);
    attempts.set(key, recent);
    if (attempts.size > MAX_TRACKED_KEYS) {
      attempts.clear();
    }
    return recent.length > maxPerMinute;
  };
}
