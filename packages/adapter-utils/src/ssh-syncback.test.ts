import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Run the "remote" side of every ssh call locally: the remote script is the
// last ssh argument, so `sh -c` it in place of a real host.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) =>
      file === "ssh"
        ? actual.spawn("sh", ["-c", args.at(-1)!], options)
        : actual.spawn(file, args, options)),
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) =>
      file === "ssh"
        ? actual.execFile("sh", ["-c", args.at(-1)!], options, callback)
        : actual.execFile(file, args, options, callback)),
  };
});

import { restoreWorkspaceFromSshExecution, syncDirectoryFromSsh } from "./ssh.js";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "./workspace-restore-merge.js";

const spec = {
  host: "fixture.invalid", username: "fixture", port: 22,
  remoteCwd: "/remote", remoteWorkspacePath: "/remote",
  privateKey: null, knownHosts: null, strictHostKeyChecking: false,
};

const exists = (file: string) => stat(file).then(() => true, () => false);

describe("SSH sync-back leaves agent runtime folders alone", () => {
  let root: string;
  let writer: ChildProcess | null = null;
  const savedEnv = { home: process.env.PAPERCLIP_HOME, instance: process.env.PAPERCLIP_INSTANCE_ID };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-syncback-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "test";
  });

  afterEach(async () => {
    if (writer && writer.exitCode === null && writer.signalCode === null) {
      const exited = once(writer, "exit");
      writer.kill("SIGKILL");
      await exited;
    }
    writer = null;
    if (savedEnv.home === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = savedEnv.home;
    if (savedEnv.instance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = savedEnv.instance;
    await chmod(path.join(root, "remote", ".codex", "locked"), 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  // A remote workspace mid-write: an agent is still appending under `.claude`
  // (GNU tar: "file changed as we read it", exit 1) and `.codex` holds a file
  // tar cannot even open (deterministic failure if tar ever reads it).
  async function busyRemote(): Promise<string> {
    const remote = path.join(root, "remote");
    await mkdir(path.join(remote, ".claude"), { recursive: true });
    await mkdir(path.join(remote, ".codex"), { recursive: true });
    await mkdir(path.join(remote, "docs", ".claude"), { recursive: true });
    await writeFile(path.join(remote, "README.md"), "remote readme\n");
    await writeFile(path.join(remote, "docs", ".claude", "notes.md"), "nested, not a runtime folder\n");
    await writeFile(path.join(remote, ".claude", "session.jsonl"), Buffer.alloc(4 * 1024 * 1024, 120));
    await writeFile(path.join(remote, ".codex", "remote-state"), "remote codex\n");
    await writeFile(path.join(remote, ".codex", "locked"), "unreadable\n");
    await chmod(path.join(remote, ".codex", "locked"), 0o000);
    writer = spawn("sh", ["-c", `while :; do head -c 65536 /dev/zero >> ${JSON.stringify(path.join(remote, ".claude", "session.jsonl"))}; done`], {
      stdio: "ignore",
    });
    return remote;
  }

  it("does not fail on a .claude folder being written, and copies neither .claude nor .codex back", async () => {
    const remote = await busyRemote();
    const local = path.join(root, "local");
    await mkdir(path.join(local, ".claude"), { recursive: true });
    await mkdir(path.join(local, ".codex"), { recursive: true });
    await writeFile(path.join(local, ".claude", "settings.json"), "local settings\n");
    await writeFile(path.join(local, ".codex", "config.toml"), "local codex\n");
    await writeFile(path.join(local, "stale.txt"), "removed remotely\n");

    await expect(syncDirectoryFromSsh({ spec, remoteDir: remote, localDir: local })).resolves.toBeUndefined();

    // Ordinary files, including a nested folder that merely shares the name, still come back.
    await expect(readFile(path.join(local, "README.md"), "utf8")).resolves.toBe("remote readme\n");
    await expect(readFile(path.join(local, "docs", ".claude", "notes.md"), "utf8")).resolves.toBe("nested, not a runtime folder\n");
    expect(await exists(path.join(local, "stale.txt"))).toBe(false);
    // Runtime folders are neither copied back nor wiped locally.
    expect(await exists(path.join(local, ".claude", "session.jsonl"))).toBe(false);
    expect(await exists(path.join(local, ".codex", "remote-state"))).toBe(false);
    await expect(readFile(path.join(local, ".claude", "settings.json"), "utf8")).resolves.toBe("local settings\n");
    await expect(readFile(path.join(local, ".codex", "config.toml"), "utf8")).resolves.toBe("local codex\n");
  }, 30_000);

  it("keeps local runtime folders through a baseline merge restore while ordinary edits apply", async () => {
    const local = path.join(root, "local");
    await mkdir(path.join(local, ".claude"), { recursive: true });
    await mkdir(path.join(local, ".codex"), { recursive: true });
    await writeFile(path.join(local, "README.md"), "original\n");
    await writeFile(path.join(local, ".claude", "settings.json"), "local settings\n");
    await writeFile(path.join(local, ".codex", "config.toml"), "local codex\n");
    const baseline = await captureDirectorySnapshot(local, { exclude: [".paperclip-runtime"] });

    // The remote started as a copy of local; the run edited README and the
    // agent runtime rewrote its folders (dropping settings.json).
    const remote = await busyRemote();
    await writeFile(path.join(remote, "added.txt"), "new remote file\n");

    try {
      await expect(restoreWorkspaceFromSshExecution({
        spec, localDir: local, remoteDir: remote, baselineSnapshot: baseline,
      })).resolves.toBeUndefined();
    } finally {
      await disposeDirectorySnapshot(baseline);
    }

    await expect(readFile(path.join(local, "README.md"), "utf8")).resolves.toBe("remote readme\n");
    await expect(readFile(path.join(local, "added.txt"), "utf8")).resolves.toBe("new remote file\n");
    await expect(readFile(path.join(local, "docs", ".claude", "notes.md"), "utf8")).resolves.toBe("nested, not a runtime folder\n");
    // Absent from the remote tar must not read as "deleted remotely".
    await expect(readFile(path.join(local, ".claude", "settings.json"), "utf8")).resolves.toBe("local settings\n");
    await expect(readFile(path.join(local, ".codex", "config.toml"), "utf8")).resolves.toBe("local codex\n");
    expect(await exists(path.join(local, ".claude", "session.jsonl"))).toBe(false);
    expect(await exists(path.join(local, ".codex", "remote-state"))).toBe(false);
  }, 30_000);
});
