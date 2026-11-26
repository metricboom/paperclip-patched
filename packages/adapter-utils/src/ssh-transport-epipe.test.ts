import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { syncDirectoryFromSsh, syncDirectoryToSsh } from "./ssh.js";

// A real `ssh` child that exits while the parent is still piping into its
// stdin raises `write EPIPE` on the stdin Socket. Without an `error`
// listener on that pipe, Node turns it into an uncaught exception and the
// whole server process exits. These tests use a fake `ssh` on PATH so the
// broken pipe is genuine, not mocked.

const spec = {
  host: "fixture.invalid", username: "fixture", port: 22,
  remoteCwd: "/remote", remoteWorkspacePath: "/remote",
  privateKey: null, knownHosts: null, strictHostKeyChecking: false,
};

let workDir: string;
let binDir: string;
let originalPath: string | undefined;

async function writeFakeSsh(body: string): Promise<void> {
  const script = path.join(binDir, "ssh");
  await fs.writeFile(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-epipe-"));
  binDir = path.join(workDir, "bin");
  await fs.mkdir(binDir);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await fs.rm(workDir, { recursive: true, force: true });
});

it("fails the sync, not the process, when ssh closes its stdin mid-transfer", async () => {
  const localDir = path.join(workDir, "local");
  await fs.mkdir(localDir);
  // Far larger than a pipe buffer, so tar is still writing when ssh exits.
  await fs.writeFile(path.join(localDir, "payload.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
  // The peer goes away at once: no stdin is read, exit status like a dropped connection.
  await writeFakeSsh("echo 'Connection reset by peer' >&2\nexit 255");

  const error = await syncDirectoryToSsh({ spec, localDir, remoteDir: "/remote/ws" })
    .then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Connection reset by peer");

  // The same process still serves the next operation.
  await writeFakeSsh("cat >/dev/null");
  await expect(syncDirectoryToSsh({ spec, localDir, remoteDir: "/remote/ws" })).resolves.toBeUndefined();
});

it("carries the broken pipe as the transport cause when ssh exits cleanly without reading", async () => {
  const localDir = path.join(workDir, "local");
  await fs.mkdir(localDir);
  await fs.writeFile(path.join(localDir, "payload.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
  await writeFakeSsh("exec 0<&-\nsleep 0.2\nexit 0");

  const error = await syncDirectoryToSsh({ spec, localDir, remoteDir: "/remote/ws" })
    .then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as NodeJS.ErrnoException).code).toBe("EPIPE");
});

it("fails the restore, not the process, when local tar stops reading", async () => {
  const localDir = path.join(workDir, "local");
  await fs.mkdir(localDir);
  // ssh streams a large non-tar body; local `tar -x` rejects it and exits,
  // closing its stdin while ssh output is still flowing into it.
  await writeFakeSsh("head -c 8388608 /dev/zero | tr '\\0' 'x'");

  const error = await syncDirectoryFromSsh({ spec, remoteDir: "/remote/ws", localDir })
    .then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
});
