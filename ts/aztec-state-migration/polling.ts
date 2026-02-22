/** Configuration for the generic {@link poll} helper. */
export interface PollOptions<T> {
  /** Async predicate called each iteration. Return a value to stop, or `undefined` to keep polling. */
  check: () => Promise<T | undefined>;
  /** Maximum number of iterations before throwing. */
  maxAttempts: number;
  /** Delay in milliseconds between iterations. */
  intervalMs: number;
  /** Optional callback invoked after each unsuccessful check (e.g. to produce blocks). */
  onPoll?: (attempt: number) => Promise<void>;
  /** Error message used when `maxAttempts` is exceeded. */
  timeoutMessage: string;
}

/**
 * Generic polling helper. Calls {@link PollOptions.check} repeatedly until it
 * returns a non-`undefined` value, or throws after {@link PollOptions.maxAttempts}.
 *
 * @param opts - Polling configuration.
 * @returns The first non-`undefined` result from `check`.
 * @throws If `maxAttempts` is exceeded.
 */
export async function poll<T>(opts: PollOptions<T>): Promise<T> {
  for (let i = 1; i <= opts.maxAttempts; i++) {
    const result = await opts.check();
    if (result !== undefined) return result;
    if (opts.onPoll) await opts.onPoll(i);
    if (i < opts.maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
    }
  }
  throw new Error(opts.timeoutMessage);
}
