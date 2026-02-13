export interface PollOptions<T> {
  check: () => Promise<T | undefined>;
  maxAttempts: number;
  intervalMs: number;
  onPoll?: (attempt: number) => Promise<void>;
  timeoutMessage: string;
}

/**
 * Generic polling helper. Calls `check` repeatedly until it returns a
 * non-undefined value, or throws after maxAttempts.
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
