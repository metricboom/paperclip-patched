import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  restoreWorkspaceFromSshExecution,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  shellQuote,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  type SshEnvLabFixtureState,
} from "./ssh.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

// Loopback sshd fixture only: no live host is contacted.
const TIMEOUT_MS = 60_000;
const HEAVY_PATHS = [
  "node_modules/pkg/index.js",
  "packages/app/node_modules/dep/index.js",
  "dist/bundle.js",
  "packages/app/build/out.js",
  ".next/cache.bin",
];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) =>
      error ? reject(new Error((stderr || stdout || error.message).trim())) : resolve(stdout.trim()));
  });
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

async function setup() {
  const support = await getSshEnvLabSupport();
  if (!support.supported) return null;
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-heavy-"));
  let state: SshEnvLabFixtureState | null = null;
  cleanups.push(async () => {
    if (state) await stopSshEnvLabFixture(state);
    await rm(rootDir, { recursive: true, force: true });
  });
  try {
    state = await startSshEnvLabFixture({ statePath: path.join(rootDir, "state.json") });
  } catch {
    return null;
  }
  const config = await buildSshEnvLabFixtureConfig(state);
  const spec = { ...config, remoteCwd: state.workspaceDir } as const;
  return { rootDir, state, spec };
}

async function seedWorkspace(localDir: string, withGit: boolean) {
  await mkdir(localDir, { recursive: true });
  await writeFile(path.join(localDir, "keep.txt"), "keep\n");
  await writeFile(path.join(localDir, "gone.txt"), "gone\n");
  await mkdir(path.join(localDir, "src"), { recursive: true });
  await writeFile(path.join(localDir, "src", "a.ts"), "a\n");
  await writeFile(path.join(localDir, ".gitignore"), HEAVY_PATHS.map((p) => p.split("/").slice(0, -1).join("/")).join("\n") + "\n");
  if (withGit) {
    await git(localDir, ["init"]);
    await git(localDir, ["checkout", "-b", "main"]);
    await git(localDir, ["config", "user.name", "t"]);
    await git(localDir, ["config", "user.email", "t@example.test"]);
    await git(localDir, ["add", "."]);
    await git(localDir, ["commit", "-m", "init"]);
  }
  for (const rel of HEAVY_PATHS) {
    await mkdir(path.dirname(path.join(localDir, rel)), { recursive: true });
    await writeFile(path.join(localDir, rel), `local ${rel}\n`);
  }
}

async function expectLocalHeavyUntouched(localDir: string) {
  for (const rel of HEAVY_PATHS) {
    expect(await readFile(path.join(localDir, rel), "utf8")).toBe(`local ${rel}\n`);
  }
}

describe.each([{ label: "git-backed", withGit: true }, { label: "plain", withGit: false }])(
  "SSH workspace sync skips heavy folders ($label)",
  ({ withGit }) => {
    it("does not send them, does not bring them back, keeps the local ones, and still syncs source both ways", async (context) => {
      const env = await setup();
      if (!env) { context.skip(); return; }
      const localDir = path.join(env.rootDir, "local");
      await seedWorkspace(localDir, withGit);

      const prepared = await prepareRemoteManagedRuntime({
        spec: env.spec, runId: "heavy", adapterKey: "test-adapter", workspaceLocalDir: localDir,
      });
      cleanups.push(() => prepared.restoreWorkspace());
      const remoteDir = prepared.workspaceRemoteDir;

      // (a) Heavy folders are not sent.
      for (const rel of HEAVY_PATHS) {
        const probe = await runSshCommand(env.spec, `test -e ${shellQuote(path.posix.join(remoteDir, rel))} && echo present || echo absent`);
        expect(probe.stdout.trim(), rel).toBe("absent");
      }
      const sent = await runSshCommand(env.spec, `cat ${shellQuote(path.posix.join(remoteDir, "src/a.ts"))}`);
      expect(sent.stdout).toBe("a\n");

      // The remote job writes heavy folders and source changes.
      const script = [
        `cd ${shellQuote(remoteDir)}`,
        "mkdir -p node_modules/remote-only packages/app/node_modules/x dist",
        "echo remote > node_modules/remote-only/file.js",
        "echo remote > packages/app/node_modules/x/file.js",
        "echo remote > dist/remote.js",
        "echo new > new.txt",
        "echo edited > src/a.ts",
        "rm gone.txt",
      ].join(" && ");
      await runSshCommand(env.spec, script);

      await prepared.restoreWorkspace();
      cleanups.length = 0;
      cleanups.push(async () => { await stopSshEnvLabFixture(env.state); await rm(env.rootDir, { recursive: true, force: true }); });

      // (b) Remote heavy output is not copied back.
      expect(await exists(path.join(localDir, "node_modules/remote-only"))).toBe(false);
      expect(await exists(path.join(localDir, "packages/app/node_modules/x"))).toBe(false);
      expect(await exists(path.join(localDir, "dist/remote.js"))).toBe(false);
      // (c) The local node_modules (and other excluded folders) survive untouched.
      await expectLocalHeavyUntouched(localDir);
      // (d) Source files still sync both ways: new file, edit, deletion.
      expect(await readFile(path.join(localDir, "new.txt"), "utf8")).toBe("new\n");
      expect(await readFile(path.join(localDir, "src/a.ts"), "utf8")).toBe("edited\n");
      expect(await exists(path.join(localDir, "gone.txt"))).toBe(false);
      expect(await readFile(path.join(localDir, "keep.txt"), "utf8")).toBe("keep\n");
    }, TIMEOUT_MS);

    it("sends heavy folders in workspaceFileMode all, as before", async (context) => {
      const env = await setup();
      if (!env) { context.skip(); return; }
      const localDir = path.join(env.rootDir, "local");
      await seedWorkspace(localDir, false);
      await prepareWorkspaceForSshExecution({ spec: env.spec, localDir, remoteDir: env.state.workspaceDir, workspaceFileMode: "all" });
      const probe = await runSshCommand(env.spec, `cat ${shellQuote(path.posix.join(env.state.workspaceDir, "node_modules/pkg/index.js"))}`);
      expect(probe.stdout).toBe("local node_modules/pkg/index.js\n");
    }, TIMEOUT_MS);
  },
);

describe("SSH restore without a baseline", () => {
  it("keeps local heavy folders that were never sent", async (context) => {
    const env = await setup();
    if (!env) { context.skip(); return; }
    const localDir = path.join(env.rootDir, "local");
    await seedWorkspace(localDir, false);
    await prepareWorkspaceForSshExecution({ spec: env.spec, localDir, remoteDir: env.state.workspaceDir });
    await runSshCommand(env.spec, `cd ${shellQuote(env.state.workspaceDir)} && echo new > new.txt && mkdir -p node_modules && echo r > node_modules/r.js`);
    await restoreWorkspaceFromSshExecution({ spec: env.spec, localDir, remoteDir: env.state.workspaceDir });
    await expectLocalHeavyUntouched(localDir);
    expect(await exists(path.join(localDir, "node_modules/r.js"))).toBe(false);
    expect(await readFile(path.join(localDir, "new.txt"), "utf8")).toBe("new\n");
  }, TIMEOUT_MS);
});
