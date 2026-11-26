// Small async utilities: timeouts, sleeps, retries.

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/** Run `fn` with an abort signal that fires after `ms`; rejects with TimeoutError when it does. */
export async function withTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  label = "operation",
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`${label} exceeded ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Floor `value` to a multiple of `step`, robust to binary float error. */
export function floorToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2);
  const units = Math.floor(Number((value / step).toFixed(6)));
  return Number((units * step).toFixed(decimals));
}

export function roundTo(value: number, step: number): number {
  if (!(step > 0)) return value;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number((Math.round(value / step) * step).toFixed(decimals));
}
