import { parseObject } from "../../adapters/utils.js";

/**
 * True when the run held a slot under the host cap: the claim recorded
 * hostRun metadata (written only when a cap applies) and was not classified
 * remote. Matches the admission counting predicate, where a missing `local`
 * classification counts as local. Kept dependency-free so both admission and
 * dispatch notifications can share it without a module cycle.
 */
export function heldHostRunSlot(run: { runnerProfileJson: unknown }): boolean {
  const hostRun = parseObject(parseObject(run.runnerProfileJson).hostRun);
  return Object.keys(hostRun).length > 0 && hostRun.local !== false;
}
