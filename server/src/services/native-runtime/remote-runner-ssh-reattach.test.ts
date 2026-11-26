import { describe, expect, it, vi } from "vitest";
import { verifyRemoteRunnerReattachment } from "./native-session-executor.js";
import { NATIVE_REMOTE_RECOVERY_LEASE_MISMATCH } from "./remote-recovery-lease-mismatch.js";

/**
 * Characterization of the current boundary, not a statement of desired
 * behavior: the server-side same-run reattach verification only admits a
 * sandbox lease. An SSH host has no provider lease or synced workspace to
 * prove, so a restarted controller cannot adopt a live Runner there. See
 * doc/runbooks/laptop-ssh-to-native-runner.md. If SSH reattach is added, this
 * test must change with it.
 */
describe("remote Runner reattach verification on an SSH target", () => {
  const claim = {
    runId: "run",
    remote: { providerLeaseId: "sandbox", remoteCwd: "/workspace" },
  };
  const identity = { runId: "run", normalizedSessionId: "session", runnerInstanceId: "runner" };

  it("refuses an SSH target before running any command on the host", async () => {
    const execute = vi.fn();
    const target = {
      kind: "remote" as const,
      transport: "ssh" as const,
      remoteCwd: "/workspace",
      spec: {},
      runner: { execute },
    };
    const outcome = await verifyRemoteRunnerReattachment({
      claim,
      target: target as never,
      identity,
      runId: "run",
      normalizedSessionId: "session",
    }).catch((error: unknown) => error as Error);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(NATIVE_REMOTE_RECOVERY_LEASE_MISMATCH);
    expect((outcome as Error).message).toContain("runner_verification");
    expect((outcome as Error).message).toContain("target");
    expect(execute).not.toHaveBeenCalled();
  });
});
