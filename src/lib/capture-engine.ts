/**
 * Which revision of the capture engine took a capture.
 *
 * A monitor compares each check with a baseline it took earlier. When the way
 * pages are captured changes — what the browser says it is, how long it waits,
 * what it blocks — the next check differs from its baseline because of the
 * engine, not the page, and every monitor the change reaches would alert at
 * once. So each capture records the engine that took it, and a baseline from
 * an older one is replaced quietly instead of compared (shouldRefreshBaseline).
 *
 * The marker lives on each entry of the capture's `files` JSON, written by
 * runCapture: every capture has files, whether or not it read page facts, and
 * the column needs no migration. Captures from before the marker read as 1.
 *
 * To change the engine: raise CAPTURE_ENGINE and describe the change in
 * ENGINE_CHANGES, naming the captures it reaches. Nothing else needs touching.
 */
export const CAPTURE_ENGINE = 2;

/** The engine every capture taken before the marker existed counts as. */
const UNMARKED = 1;

interface EngineChange {
  /** The engine version that introduced the change. */
  version: number;
  what: string;
  /** Whether a capture taken before it would look different now. */
  reaches: (capture: { device: string }) => boolean;
}

export const ENGINE_CHANGES: EngineChange[] = [
  {
    version: 2,
    what: 'Mobile and tablet captures send a real Safari user agent, with touch.',
    reaches: (capture) => capture.device === 'mobile' || capture.device === 'tablet',
  },
];

/** The engine a stored capture was taken with. */
export function captureEngine(capture: { files: string }): number {
  try {
    const files = JSON.parse(capture.files);
    const engine = Array.isArray(files) ? files[0]?.engine : undefined;
    return Number.isInteger(engine) && engine > 0 ? engine : UNMARKED;
  } catch {
    return UNMARKED;
  }
}

/**
 * Whether a monitor should save its new capture as the baseline instead of
 * comparing against this one: the baseline was taken by an older engine, and a
 * change made since then reaches it. A desktop baseline from engine 1 still
 * compares, because engine 2 changed nothing a desktop capture shows.
 *
 * The one place that decides it, so a baseline kept for another reason (a
 * pinned one, say) can be weighed against it in the same spot.
 */
export function shouldRefreshBaseline(baseline: { files: string; device: string }): boolean {
  const engine = captureEngine(baseline);
  return ENGINE_CHANGES.some((change) => change.version > engine && change.reaches(baseline));
}

/** The run history line for a check that replaced its baseline this way. */
export const BASELINE_REFRESHED = 'Baseline refreshed after a capture engine update';
