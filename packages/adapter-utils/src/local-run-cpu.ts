import { promises as fs } from "node:fs";
import os from "node:os";

export interface LocalRunCpuControl { nice: number | null; quotaPercent: number | null; }
export interface LocalRunCpuAccounting {
  schema: "paperclip.local_run_cpu.v1"; scope: "local_process_tree";
  quality: "exact_cgroup_v2" | "approximate_proc_group";
  userCpuSeconds: number | null; systemCpuSeconds: number | null; cpuSeconds: number | null; wallSeconds: number;
  control: { requestedQuotaPercent: number | null; requestedNice: number | null; method: "cgroup_v2" | "nice" | "none"; quotaEnforced: boolean; fallbackReason?: string; appliedNice?: number; };
}
const controls = new Map<string, LocalRunCpuControl>();
// Runs dispatched through the heartbeat runtime register here: configureLocalRunCpuControl is
// called for every dispatch, with a null control for remote targets, and clearLocalRunCpuControl
// unwinds the registration when the dispatch ends. Only runs inside that window have their
// accounting retained for takeLocalRunCpuAccounting. Synthetic callers such as model discovery
// never register, so their per-process entries are returned to the direct caller but never
// retained at all.
//
// Cleanup is ownership-based, never expiry of live data: an entry is sweepable only once its
// dispatch has unwound (clear ran) without the consumer taking it, plus a short grace for the
// result handling that sits between clear and take. An entry whose dispatch is still open is
// never swept, however old it is, so a long multi-child run cannot lose an early child's CPU.
const registered = new Set<string>();
type CompletedEntry = { accounting: LocalRunCpuAccounting; dispatchClosedAt: number | null };
const completed = new Map<string, CompletedEntry>();
const DISPATCH_CLOSED_GRACE_MS = 5 * 60_000;
function sweepCompleted(now: number) {
  for (const [id, entry] of completed) {
    if (entry.dispatchClosedAt !== null && now - entry.dispatchClosedAt > DISPATCH_CLOSED_GRACE_MS) completed.delete(id);
  }
}
function rememberCompleted(runId: string, accounting: LocalRunCpuAccounting) {
  if (!registered.has(runId)) return;
  completed.set(runId, { accounting, dispatchClosedAt: completed.get(runId)?.dispatchClosedAt ?? null });
  sweepCompleted(Date.now());
}
const PROC_TICKS_PER_SECOND = 100;
function numberInRange(value: unknown, min: number, max: number) { return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max ? value : null; }
export function readLocalRunCpuControl(runtimeConfig: unknown): LocalRunCpuControl | null {
  const root = runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig) ? runtimeConfig as Record<string, unknown> : {};
  const heartbeat = root.heartbeat && typeof root.heartbeat === "object" && !Array.isArray(root.heartbeat) ? root.heartbeat as Record<string, unknown> : {};
  const nice = numberInRange(heartbeat.cpuNice, -20, 19), quotaPercent = numberInRange(heartbeat.cpuQuotaPercent, 1, 1_000);
  return nice === null && quotaPercent === null ? null : { nice, quotaPercent };
}
export function configureLocalRunCpuControl(runId: string, control: LocalRunCpuControl | null) { registered.add(runId); if (control) controls.set(runId, control); else controls.delete(runId); }
export function clearLocalRunCpuControl(runId: string) {
  registered.delete(runId);
  controls.delete(runId);
  const entry = completed.get(runId);
  if (entry) entry.dispatchClosedAt = Date.now();
}
export function takeLocalRunCpuAccounting(runId: string) { const entry = completed.get(runId) ?? null; completed.delete(runId); return entry?.accounting ?? null; }
const addNullable = (a: number | null, b: number | null) => a === null && b === null ? null : (a ?? 0) + (b ?? 0);
const methodRank = { none: 0, nice: 1, cgroup_v2: 2 } as const;
/**
 * One run can spawn several child processes (retries, helper commands). Each child reports its own
 * accounting; the run's record is the sum. CPU seconds add up, with an unknown (null) side counting as
 * zero unless both sides are unknown. wallSeconds is the longest single child, because children may
 * overlap and adding their wall time would overstate it. quality is exact only if every child was exact.
 * Control: strongest method wins (cgroup_v2 over nice over none), quotaEnforced only if every child
 * enforced it, and distinct fallback reasons are joined.
 */
export function mergeLocalRunCpuAccounting(previous: LocalRunCpuAccounting | null, next: LocalRunCpuAccounting): LocalRunCpuAccounting {
  if (!previous) return next;
  const reasons = [...new Set([previous.control.fallbackReason, next.control.fallbackReason]
    .flatMap(reason => reason ? reason.split("; ") : []))];
  const appliedNice = previous.control.appliedNice ?? next.control.appliedNice;
  return {
    schema: next.schema, scope: next.scope,
    quality: previous.quality === "exact_cgroup_v2" && next.quality === "exact_cgroup_v2" ? "exact_cgroup_v2" : "approximate_proc_group",
    userCpuSeconds: addNullable(previous.userCpuSeconds, next.userCpuSeconds),
    systemCpuSeconds: addNullable(previous.systemCpuSeconds, next.systemCpuSeconds),
    cpuSeconds: addNullable(previous.cpuSeconds, next.cpuSeconds),
    wallSeconds: Math.max(previous.wallSeconds, next.wallSeconds),
    control: {
      requestedQuotaPercent: previous.control.requestedQuotaPercent ?? next.control.requestedQuotaPercent,
      requestedNice: previous.control.requestedNice ?? next.control.requestedNice,
      method: methodRank[next.control.method] > methodRank[previous.control.method] ? next.control.method : previous.control.method,
      quotaEnforced: previous.control.quotaEnforced && next.control.quotaEnforced,
      ...(reasons.length ? { fallbackReason: reasons.join("; ") } : {}),
      ...(appliedNice !== undefined ? { appliedNice } : {}),
    },
  };
}
function cpuStat(text: string) {
  const values = Object.fromEntries(text.split("\n").flatMap(line => { const [key, value] = line.trim().split(/\s+/, 2); return key && value && /^\d+$/.test(value) ? [[key, Number(value)]] : []; }));
  return typeof values.usage_usec === "number" ? { usage: values.usage_usec, user: values.user_usec ?? null, system: values.system_usec ?? null } : null;
}
function procStat(text: string) {
  const close = text.lastIndexOf(") "); if (close < 0) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/), pgrp = Number(fields[2]), user = Number(fields[11]), system = Number(fields[12]);
  return Number.isFinite(pgrp) && Number.isFinite(user) && Number.isFinite(system) ? { pgrp, user, system } : null;
}
async function processGroupCpu(processGroupId: number) {
  if (process.platform !== "linux") return { user: 0, system: 0 };
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const samples = await Promise.all(entries.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async entry => procStat(await fs.readFile(`/proc/${entry.name}/stat`, "utf8").catch(() => ""))));
  return samples.reduce((total, sample) => sample && sample.pgrp === processGroupId ? { user: total.user + sample.user, system: total.system + sample.system } : total, { user: 0, system: 0 });
}
async function tryCreateCgroup(runId: string, pid: number, quotaPercent: number) {
  if (process.platform !== "linux") throw new Error("cgroup v2 is only available on Linux");
  const directory = `${process.env.PAPERCLIP_CGROUP_ROOT || "/sys/fs/cgroup"}/paperclip-runs/${runId}`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(`${directory}/cpu.max`, `${Math.max(1, Math.floor(quotaPercent * 1_000))} 100000`);
  await fs.writeFile(`${directory}/cgroup.procs`, String(pid));
  const start = cpuStat(await fs.readFile(`${directory}/cpu.stat`, "utf8")); if (!start) throw new Error("cgroup cpu.stat did not report usage_usec");
  return { directory, start };
}
export async function beginLocalRunCpuAccounting(runId: string, pid: number, processGroupId: number | null) {
  const requested = controls.get(runId) ?? { nice: null, quotaPercent: null }, startedAt = Date.now();
  let cgroup: Awaited<ReturnType<typeof tryCreateCgroup>> | null = null, fallbackReason: string | undefined, appliedNice: number | undefined;
  if (requested.quotaPercent !== null) try { cgroup = await tryCreateCgroup(runId, pid, requested.quotaPercent); } catch (error) { fallbackReason = error instanceof Error ? error.message : String(error); }
  const desiredNice = requested.nice ?? (requested.quotaPercent !== null && !cgroup ? 10 : null);
  if (desiredNice !== null) try { os.setPriority(pid, desiredNice); appliedNice = desiredNice; } catch (error) { fallbackReason = [fallbackReason, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; "); }
  let sampled = processGroupId ? await processGroupCpu(processGroupId) : { user: 0, system: 0 };
  const sampler = processGroupId ? setInterval(() => { void processGroupCpu(processGroupId).then(next => { sampled = next; }); }, 250) : null; sampler?.unref();
  return async () => {
    if (sampler) clearInterval(sampler); const wallSeconds = (Date.now() - startedAt) / 1_000;
    let result: LocalRunCpuAccounting;
    if (cgroup) {
      const end = cpuStat(await fs.readFile(`${cgroup.directory}/cpu.stat`, "utf8").catch(() => ""));
      const user = end && end.user !== null && cgroup.start.user !== null ? (end.user - cgroup.start.user) / 1_000_000 : null, system = end && end.system !== null && cgroup.start.system !== null ? (end.system - cgroup.start.system) / 1_000_000 : null, cpu = end ? (end.usage - cgroup.start.usage) / 1_000_000 : null;
      await fs.rmdir(cgroup.directory).catch(() => undefined);
      result = { schema: "paperclip.local_run_cpu.v1", scope: "local_process_tree", quality: "exact_cgroup_v2", userCpuSeconds: user, systemCpuSeconds: system, cpuSeconds: cpu, wallSeconds, control: { requestedQuotaPercent: requested.quotaPercent, requestedNice: requested.nice, method: "cgroup_v2", quotaEnforced: true, ...(appliedNice !== undefined ? { appliedNice } : {}) } };
    } else {
      const end = processGroupId ? await processGroupCpu(processGroupId) : sampled, userCpuSeconds = Math.max(sampled.user, end.user) / PROC_TICKS_PER_SECOND, systemCpuSeconds = Math.max(sampled.system, end.system) / PROC_TICKS_PER_SECOND;
      result = { schema: "paperclip.local_run_cpu.v1", scope: "local_process_tree", quality: "approximate_proc_group", userCpuSeconds, systemCpuSeconds, cpuSeconds: userCpuSeconds + systemCpuSeconds, wallSeconds, control: { requestedQuotaPercent: requested.quotaPercent, requestedNice: requested.nice, method: appliedNice !== undefined ? "nice" : "none", quotaEnforced: false, ...(fallbackReason ? { fallbackReason } : requested.quotaPercent !== null ? { fallbackReason: "No delegated writable cgroup v2 subtree was available" } : {}), ...(appliedNice !== undefined ? { appliedNice } : {}) } };
    }
    const merged = mergeLocalRunCpuAccounting(completed.get(runId)?.accounting ?? null, result);
    rememberCompleted(runId, merged); return merged;
  };
}
