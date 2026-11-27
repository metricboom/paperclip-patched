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
  const fields = text.slice(close + 2).trim().split(/\s+/), ppid = Number(fields[1]), pgrp = Number(fields[2]), user = Number(fields[11]), system = Number(fields[12]), starttime = Number(fields[19]);
  return Number.isFinite(pgrp) && Number.isFinite(user) && Number.isFinite(system) ? { ppid, pgrp, user, system, starttime } : null;
}
async function procStats() {
  if (process.platform !== "linux") return [];
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const stats = await Promise.all(entries.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async entry => {
    const stat = procStat(await fs.readFile(`/proc/${entry.name}/stat`, "utf8").catch(() => ""));
    return stat ? { pid: Number(entry.name), ...stat } : null;
  }));
  return stats.filter(stat => stat !== null);
}
async function processGroupRows(processGroupId: number) {
  return (await procStats()).filter(sample => sample.pgrp === processGroupId);
}
async function processTreeRows(rootPid: number) {
  const samples = await procStats();
  const ppidOf = new Map(samples.map(sample => [sample.pid, sample.ppid]));
  const inTree = (pid: number) => {
    let current: number | undefined = pid;
    for (let depth = 0; depth < 64 && current !== undefined; depth += 1) {
      if (current === rootPid) return true;
      if (current === 0) return false;
      current = ppidOf.get(current);
    }
    return false;
  };
  return samples.filter(sample => inTree(sample.pid));
}

// PID identity token: the kernel starttime (clock ticks since boot) from /proc/<pid>/stat. A
// caller that just spawned the process captures it with readLocalProcessStarttime while the
// child handle is live and trusted; before attaching any control to that pid later (warm reuse),
// verifyLocalProcessIdentity compares the SAME kernel value. A recycled pid has a different
// starttime and fails the match. An entry without a captured token (older warm entries) matches
// nothing: never attach to an unverified pid. Residual boundary: between the check and the
// mutation the process can still exit and the pid recycle, so the window is narrowed by checking
// immediately before each mutation, never eliminated.
export async function readLocalProcessStarttime(pid: number): Promise<number | null> {
  if (process.platform !== "linux") return null;
  const stat = procStat(await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""));
  return stat && Number.isFinite(stat.starttime) ? stat.starttime : null;
}
export async function verifyLocalProcessIdentity(pid: number, expectedStarttime: number | null | undefined): Promise<boolean> {
  if (expectedStarttime === null || expectedStarttime === undefined) return false;
  return await readLocalProcessStarttime(pid) === expectedStarttime;
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
  // Non-cgroup sampling: per-PID high-water accumulation. A process's /proc counters only rise
  // while it lives, so keeping the highest value observed per pid preserves CPU already observed
  // for descendants that exited before a later sample (they then disappear from /proc). Applies
  // to both the process-group match and the process-tree match (no process group on the ACP
  // spawn path; see processTreeRows for the tree membership rule). The baseline captured at
  // begin is subtracted at finish, so a reused process reports only this window's work.
  // Measured sampling limitations (not guaranteed bounds): a process that starts and exits
  // entirely between two samples is never observed; a process reparented out of the tree stops
  // being matched; a pid recycled within the window keeps the earlier process's higher counter
  // and the new process's pre-recycle-relative work is missed.
  const collectRows = processGroupId ? () => processGroupRows(processGroupId) : () => processTreeRows(pid);
  const highWater = new Map<number, { user: number; system: number }>();
  const sampleOnce = async () => {
    for (const row of await collectRows()) {
      const prev = highWater.get(row.pid);
      highWater.set(row.pid, { user: Math.max(prev?.user ?? 0, row.user), system: Math.max(prev?.system ?? 0, row.system) });
    }
  };
  const totalNow = () => {
    let user = 0, system = 0;
    for (const value of highWater.values()) { user += value.user; system += value.system; }
    return { user, system };
  };
  await sampleOnce();
  const baseline = totalNow();
  const sampler = setInterval(() => { void sampleOnce(); }, 250); sampler.unref();
  return async () => {
    if (sampler) clearInterval(sampler); const wallSeconds = (Date.now() - startedAt) / 1_000;
    let result: LocalRunCpuAccounting;
    if (cgroup) {
      const end = cpuStat(await fs.readFile(`${cgroup.directory}/cpu.stat`, "utf8").catch(() => ""));
      const user = end && end.user !== null && cgroup.start.user !== null ? (end.user - cgroup.start.user) / 1_000_000 : null, system = end && end.system !== null && cgroup.start.system !== null ? (end.system - cgroup.start.system) / 1_000_000 : null, cpu = end ? (end.usage - cgroup.start.usage) / 1_000_000 : null;
      await fs.rmdir(cgroup.directory).catch(() => undefined);
      result = { schema: "paperclip.local_run_cpu.v1", scope: "local_process_tree", quality: "exact_cgroup_v2", userCpuSeconds: user, systemCpuSeconds: system, cpuSeconds: cpu, wallSeconds, control: { requestedQuotaPercent: requested.quotaPercent, requestedNice: requested.nice, method: "cgroup_v2", quotaEnforced: true, ...(appliedNice !== undefined ? { appliedNice } : {}) } };
    } else {
      await sampleOnce();
      const end = totalNow(), userCpuSeconds = Math.max(0, end.user - baseline.user) / PROC_TICKS_PER_SECOND, systemCpuSeconds = Math.max(0, end.system - baseline.system) / PROC_TICKS_PER_SECOND;
      result = { schema: "paperclip.local_run_cpu.v1", scope: "local_process_tree", quality: "approximate_proc_group", userCpuSeconds, systemCpuSeconds, cpuSeconds: userCpuSeconds + systemCpuSeconds, wallSeconds, control: { requestedQuotaPercent: requested.quotaPercent, requestedNice: requested.nice, method: appliedNice !== undefined ? "nice" : "none", quotaEnforced: false, ...(fallbackReason ? { fallbackReason } : requested.quotaPercent !== null ? { fallbackReason: "No delegated writable cgroup v2 subtree was available" } : {}), ...(appliedNice !== undefined ? { appliedNice } : {}) } };
    }
    const merged = mergeLocalRunCpuAccounting(completed.get(runId)?.accounting ?? null, result);
    rememberCompleted(runId, merged); return merged;
  };
}
