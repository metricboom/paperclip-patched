import { parseObject } from "../../adapters/utils.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { resolveProviderApiPlacement } from "../native-runtime/provider-api-placement.js";
import { readNativeWorkspaceSyncReference } from "../native-runtime/native-workspace-sync.js";
import { heartbeatExternalProvider } from "./external-provider.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The saved lease id the executor (environment-selection.ts) will honor for this run, or null
 * when it would resolve a current target instead. A saved lease is reused only for a persisted
 * native execution input on a run the controller does not own; the id then comes from the saved
 * paperclipEnvironment, falling back to the native workspace sync reference. Executor and
 * claim-time admission share this so a lease that cannot drive execution never decides where a
 * run executes or is counted.
 */
export function savedAdmittedLeaseId(input: {
  run: { runtimeMode: string | null; runnerProfileJson: unknown; contextSnapshot?: unknown; driverKind?: string | null };
  agent: { adapterType: string; adapterConfig: unknown };
}): string | null {
  const profile = parseObject(input.run.runnerProfileJson);
  const persistedNativeExecutionInput =
    input.run.runtimeMode === "native" && profile.nativeExecutionInput !== undefined
      ? parseNativeExecutionInput(profile.nativeExecutionInput)
      : null;
  if (!persistedNativeExecutionInput) return null;
  const controllerOnly = heartbeatExternalProvider({ run: input.run, agent: input.agent }) !== null
    || resolveProviderApiPlacement({ run: input.run, agent: input.agent }) !== null;
  if (controllerOnly) return null;
  const savedEnvironment = parseObject(parseObject(input.run.contextSnapshot).paperclipEnvironment);
  return readNonEmptyString(savedEnvironment.leaseId)
    ?? readNativeWorkspaceSyncReference(profile.nativeWorkspaceSync)?.leaseId
    ?? null;
}
