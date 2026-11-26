// Last-resort guard for socket errors that escape every stream listener.
//
// An `error` event on a socket or pipe with no listener becomes an uncaught
// exception, and Node exits the process. When that socket is just one closed
// connection (a peer that hung up mid-write), crashing the server loses every
// other in-flight run. This guard keeps the process alive for that narrow
// class of error only. Every other uncaught exception still takes the fatal
// path: report, flush, exit nonzero, and let the supervisor restart us.
//
// The guard owns `uncaughtException` handling outright; `sentry.ts` drops the
// SDK's OnUncaughtException integration so the two cannot disagree about
// whether to exit. The guard reports every uncaught exception, transport or
// not, to Sentry before it decides.
//
// Unhandled promise rejections are out of scope and keep crashing the
// process through Sentry's strict mode (see `sentry.ts`).

export type UncaughtErrorDisposition = "ignore" | "crash";

const SOCKET_ERRNO_CODES = new Set(["EPIPE", "ECONNRESET"]);
const SOCKET_SYSCALLS = new Set(["write", "read"]);
// Node raises these only from its own stream machinery, never from user code.
const STREAM_STATE_CODES = new Set(["ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE"]);

/**
 * Decide whether an uncaught exception is a closed connection we can survive.
 * Only a peer-closed socket error raised by a read or write qualifies. An
 * errno code without a socket syscall is ambiguous and crashes.
 */
export function classifyUncaughtError(error: unknown): UncaughtErrorDisposition {
  if (!(error instanceof Error)) return "crash";
  const { code, syscall } = error as NodeJS.ErrnoException;
  if (typeof code !== "string") return "crash";
  if (SOCKET_ERRNO_CODES.has(code)) {
    return typeof syscall === "string" && SOCKET_SYSCALLS.has(syscall) ? "ignore" : "crash";
  }
  return STREAM_STATE_CODES.has(code) ? "ignore" : "crash";
}

export const TRANSPORT_ERROR_GUARD_MARKER = "transport-error-guard: survived a closed connection";

export interface TransportErrorGuardDeps {
  /** Report to Sentry. Must not throw. */
  capture: (error: unknown) => void;
  /** Log a survived transport error. */
  warn: (details: { code: string | undefined; syscall: string | undefined; errorName: string }, message: string) => void;
  /** Exit the process the way an uncaught exception would. */
  fatal: (error: unknown) => void;
}

/** Handle one uncaught exception. Exported for tests. */
export function handleUncaughtException(error: unknown, deps: TransportErrorGuardDeps): UncaughtErrorDisposition {
  deps.capture(error);
  const disposition = classifyUncaughtError(error);
  if (disposition === "ignore") {
    const { code, syscall, name } = error as NodeJS.ErrnoException;
    deps.warn({ code, syscall, errorName: name }, TRANSPORT_ERROR_GUARD_MARKER);
    return disposition;
  }
  deps.fatal(error);
  return disposition;
}

let installed: ((error: unknown) => void) | null = null;

/**
 * Register the process-level guard once. Returns a function that removes it
 * (for tests). A second call is a no-op that returns the same remover.
 */
export function installTransportErrorGuard(
  deps: TransportErrorGuardDeps,
  target: Pick<NodeJS.Process, "on" | "off"> = process,
): () => void {
  if (!installed) {
    const listener = (error: unknown) => {
      handleUncaughtException(error, deps);
    };
    installed = listener;
    target.on("uncaughtException", listener);
  }
  const listener = installed;
  return () => {
    target.off("uncaughtException", listener);
    if (installed === listener) installed = null;
  };
}
