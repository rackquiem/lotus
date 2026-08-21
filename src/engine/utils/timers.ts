import * as nodeTimers from "timers";

export type LotusTimeoutHandle = number | ReturnType<typeof nodeTimers.setTimeout>;

export function lotusSetTimeout(handler: () => void, timeout?: number): LotusTimeoutHandle {
  return typeof window === "undefined"
    ? nodeTimers.setTimeout(handler, timeout)
    : window.setTimeout(handler, timeout);
}

export function lotusClearTimeout(handle: LotusTimeoutHandle): void {
  if (typeof window === "undefined") {
    nodeTimers.clearTimeout(handle as ReturnType<typeof nodeTimers.setTimeout>);
    return;
  }

  window.clearTimeout(handle as number);
}
