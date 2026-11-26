import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncDirectoryToSsh } from "@paperclipai/adapter-utils/ssh";
import { classifyRemoteConnectionError } from "../services/remote-connection-failure.js";
import {
  classifyUncaughtError,
  handleUncaughtException,
  installTransportErrorGuard,
  TRANSPORT_ERROR_GUARD_MARKER,
} from "../transport-error-guard.js";

function errnoError(message: string, code: string, syscall?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, ...(syscall ? { syscall } : {}) });
}

describe("classifyUncaughtError", () => {
  it.each([
    ["EPIPE on write", errnoError("write EPIPE", "EPIPE", "write")],
    ["ECONNRESET on read", errnoError("read ECONNRESET", "ECONNRESET", "read")],
    ["ECONNRESET on write", errnoError("write ECONNRESET", "ECONNRESET", "write")],
    ["a destroyed stream", errnoError("Cannot call write after a stream was destroyed", "ERR_STREAM_DESTROYED")],
    ["a premature close", errnoError("Premature close", "ERR_STREAM_PREMATURE_CLOSE")],
  ])("survives %s", (_label, error) => {
    expect(classifyUncaughtError(error)).toBe("ignore");
  });

  it.each([
    ["a TypeError", new TypeError("x is not a function")],
    ["a plain Error", new Error("boom")],
    ["EPIPE without a socket syscall", errnoError("EPIPE", "EPIPE")],
    ["EPIPE from a non-socket syscall", errnoError("open EPIPE", "EPIPE", "open")],
    ["EACCES", errnoError("listen EACCES", "EACCES", "listen")],
    ["a thrown string", "write EPIPE"],
    ["a plain object with a socket code", { code: "EPIPE", syscall: "write" }],
    ["null", null],
  ])("crashes on %s", (_label, error) => {
    expect(classifyUncaughtError(error)).toBe("crash");
  });
});

describe("handleUncaughtException", () => {
  it("reports a closed connection to Sentry, logs the marker and keeps running", () => {
    const deps = { capture: vi.fn(), warn: vi.fn(), fatal: vi.fn() };
    const error = errnoError("write EPIPE", "EPIPE", "write");
    expect(handleUncaughtException(error, deps)).toBe("ignore");
    expect(deps.capture).toHaveBeenCalledWith(error);
    expect(deps.warn).toHaveBeenCalledWith(
      { code: "EPIPE", syscall: "write", errorName: "Error" },
      TRANSPORT_ERROR_GUARD_MARKER,
    );
    expect(deps.fatal).not.toHaveBeenCalled();
  });

  it("reports any other error and then takes the fatal path", () => {
    const order: string[] = [];
    const deps = {
      capture: vi.fn(() => order.push("capture")),
      warn: vi.fn(),
      fatal: vi.fn(() => order.push("fatal")),
    };
    const error = new TypeError("x is not a function");
    expect(handleUncaughtException(error, deps)).toBe("crash");
    expect(deps.fatal).toHaveBeenCalledWith(error);
    expect(deps.warn).not.toHaveBeenCalled();
    expect(order).toEqual(["capture", "fatal"]);
  });
});

describe("installTransportErrorGuard", () => {
  it("registers one listener that crashes on a non-transport error", () => {
    const target = new EventEmitter();
    const deps = { capture: vi.fn(), warn: vi.fn(), fatal: vi.fn() };
    const remove = installTransportErrorGuard(deps, target as unknown as NodeJS.Process);
    installTransportErrorGuard(deps, target as unknown as NodeJS.Process);
    try {
      expect(target.listenerCount("uncaughtException")).toBe(1);
      target.emit("uncaughtException", new Error("not a socket problem"));
      expect(deps.fatal).toHaveBeenCalledTimes(1);
      target.emit("uncaughtException", errnoError("write EPIPE", "EPIPE", "write"));
      expect(deps.fatal).toHaveBeenCalledTimes(1);
      expect(deps.warn).toHaveBeenCalledTimes(1);
    } finally {
      remove();
    }
    expect(target.listenerCount("uncaughtException")).toBe(0);
  });
});

// A real process with a real HTTP server. `/break` writes into the stdin of a
// child that has already exited, with no `error` listener on that pipe: the
// same unguarded `write EPIPE` from a Socket that took the server down.
const CHILD_PROGRAM = `
import http from "node:http";
import { spawn } from "node:child_process";
const guardModule = process.env.GUARD_MODULE;
const failureModule = process.env.FAILURE_MODULE;
const { installTransportErrorGuard } = await import(guardModule);
const { classifyRemoteConnectionError } = await import(failureModule);
const survived = [];
if (process.env.INSTALL_GUARD === "1") {
  installTransportErrorGuard({
    capture: () => {},
    warn: () => {},
    fatal: (error) => {
      process.stdout.write(JSON.stringify({ fatal: String(error && error.message) }) + "\\n");
      process.exit(3);
    },
  });
  process.on("uncaughtException", (error) => {
    survived.push({ code: error.code, syscall: error.syscall, cause: classifyRemoteConnectionError(error) });
  });
}
function breakPipe(done) {
  // The child never reads stdin and exits at once, while we keep writing.
  const child = spawn("sh", ["-c", "exit 0"], { stdio: ["pipe", "ignore", "ignore"] });
  const chunk = Buffer.alloc(256 * 1024, 1);
  let writes = 0;
  const writeMore = () => {
    if (child.stdin.destroyed || writes++ > 400) return done();
    child.stdin.write(chunk);
    setTimeout(writeMore, 5);
  };
  writeMore();
}
const server = http.createServer((req, res) => {
  if (req.url === "/break") return breakPipe(() => res.end("broke"));
  if (req.url === "/boom") { setImmediate(() => { throw new TypeError("genuine bug"); }); return res.end("boom"); }
  if (req.url === "/survived") return res.end(JSON.stringify(survived));
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
});
`;

function startChild(installGuard: boolean): Promise<{ child: ChildProcess; port: number; output: () => string }> {
  const loader = createRequire(import.meta.url).resolve("tsx");
  const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "--eval", CHILD_PROGRAM], {
    env: {
      PATH: process.env.PATH ?? "",
      TSX_DISABLE_CACHE: "1",
      INSTALL_GUARD: installGuard ? "1" : "0",
      GUARD_MODULE: new URL("../transport-error-guard.ts", import.meta.url).href,
      FAILURE_MODULE: new URL("../services/remote-connection-failure.ts", import.meta.url).href,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not start: ${stderr}`)), 20_000);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/\{"port":(\d+)\}/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]), output: () => stdout + stderr });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited early with ${code}: ${stderr}`));
    });
  });
}

function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
});

describe("transport-error guard in a real server process", () => {
  it("without the guard, a closed pipe kills the server (the reported crash)", async () => {
    const { child, port, output } = await startChild(false);
    children.push(child);
    const exited = exitOf(child);
    await fetch(`http://127.0.0.1:${port}/break`).catch(() => undefined);
    expect(await exited).not.toBe(0);
    expect(output()).toContain("EPIPE");
  }, 30_000);

  it("with the guard, the server survives, answers the next request, and records a connection_reset cause", async () => {
    const { child, port } = await startChild(true);
    children.push(child);
    expect(await (await fetch(`http://127.0.0.1:${port}/break`)).text()).toBe("broke");
    expect(child.exitCode).toBeNull();
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).toBe("ok");
    const survived = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/survived`)).text());
    expect(survived[0]).toEqual({ code: "EPIPE", syscall: "write", cause: "connection_reset" });
  }, 30_000);

  it("with the guard, a genuine bug still takes the fatal path", async () => {
    const { child, port, output } = await startChild(true);
    children.push(child);
    const exited = exitOf(child);
    await fetch(`http://127.0.0.1:${port}/boom`).catch(() => undefined);
    expect(await exited).toBe(3);
    expect(output()).toContain('{"fatal":"genuine bug"}');
  }, 30_000);
});

describe("SSH sync failures keep a transport cause", () => {
  let workDir: string;
  let originalPath: string | undefined;

  afterEach(async () => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  it.each([
    ["exits cleanly without reading", "exec 0<&-\nsleep 0.2\nexit 0"],
    ["drops the connection", "exec 0<&-\nsleep 0.2\necho 'Broken pipe' >&2\nexit 255"],
  ])("classifies a broken pipe as connection_reset when ssh %s", async (_label, script) => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-guard-ssh-"));
    const binDir = path.join(workDir, "bin");
    const localDir = path.join(workDir, "local");
    await fs.mkdir(binDir);
    await fs.mkdir(localDir);
    await fs.writeFile(path.join(binDir, "ssh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    await fs.writeFile(path.join(localDir, "payload.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    const error = await syncDirectoryToSsh({
      spec: {
        host: "fixture.invalid", username: "fixture", port: 22,
        remoteCwd: "/remote", remoteWorkspacePath: "/remote",
        privateKey: null, knownHosts: null, strictHostKeyChecking: false,
      },
      localDir,
      remoteDir: "/remote/ws",
    }).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(classifyRemoteConnectionError(error)).toBe("connection_reset");
  }, 30_000);
});
