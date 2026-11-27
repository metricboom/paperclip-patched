import { promises as fs } from "node:fs";
import os from "node:os";

export interface LocalRunCpuControl { nice: number | null; quotaPercent: number | null; }
export interface LocalRunCpuAccounting {
  schema: "paperclip.local_run_cpu.v1"; scope: "local_process_tree";
  quality: "exact_cgroup_v2" | "approximate_proc_group";
  userCpuSeconds: number | null; systemCpuSeconds: number | null; cpuSeconds: number | null; wallSeconds: number;
  control: { requestedQuotaPercent: number | null; requestedNice: number | null; method: "cgroup_v2" | "nice" | "none"; quotaEnforced: boolean; fallbackReason?: string; appliedNice?: number; };
  // Count of processes that entered the sampled set mid-window with a kernel starttime older than
  // the window (e.g. reparented into the tree). Their pre-first-observation CPU is unknown and is
  // excluded from the totals; it is flagged here instead of being reported as measured run CPU.
  unmeasuredPriorCpuProcesses?: number;
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
  const unmeasuredPriorCpuProcesses = (previous.unmeasuredPriorCpuProcesses ?? 0) + (next.unmeasuredPriorCpuProcesses ?? 0);
  return {
    schema: next.schema, scope: next.scope,
    ...(unmeasuredPriorCpuProcesses ? { unmeasuredPriorCpuProcesses } : {}),
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
// The sampling window start in kernel ticks, from /proc/uptime: the same boot-relative clock
// basis as /proc/<pid>/stat starttime. /proc/stat btime cannot be used: it is truncated to whole
// seconds, which can place a computed boundary almost a second ahead of the kernel tick timeline
// and misclassify brand-new processes as pre-existing.
async function kernelUptimeTicks() {
  if (process.platform !== "linux") return null;
  const uptime = Number((await fs.readFile("/proc/uptime", "utf8").catch(() => "")).trim().split(/\s+/)[0]);
  return Number.isFinite(uptime) ? uptime * PROC_TICKS_PER_SECOND : null;
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

export type HighWaterEntry = { baselineUser: number; baselineSystem: number; maxUser: number; maxSystem: number };
// Fold one sampling round into the high-water map; returns the number of newly seen identities
// flagged as pre-window entrants. Identity is pid + kernel starttime, so a recycled pid starts a
// fresh entry. baselinedNew is true only for the begin sample: identities observed then may have
// pre-window CPU (a reused warm process), which is subtracted at finish. An identity first seen
// in a later sample is not proven born inside the window (a pre-existing process can enter the
// sampled set, e.g. by reparenting), so its kernel starttime is compared with the window start:
// born at/after the (rounded-up) window start -> counts from zero; older, boundary-adjacent, or
// undecidable -> its first-observed value becomes the baseline so pre-window CPU is not charged
// to this run, and the entrant is flagged for unmeasuredPriorCpuProcesses because that prior CPU
// is unknown, not measured. No downward slack: a process that started even one tick before the
// window takes the flagged conservative path rather than being classified as definitively new.
export function foldProcRowsIntoHighWater(highWater: Map<string, HighWaterEntry>, rows: Array<{ pid: number; user: number; system: number; starttime: number }>, baselinedNew: boolean, windowStartTicks: number | null) {
  let preWindowEntrants = 0;
  for (const row of rows) {
    const key = `${row.pid}:${row.starttime}`;
    const prev = highWater.get(key);
    if (prev) {
      prev.maxUser = Math.max(prev.maxUser, row.user);
      prev.maxSystem = Math.max(prev.maxSystem, row.system);
    } else {
      const bornInWindow = windowStartTicks !== null && Number.isFinite(row.starttime) && row.starttime >= windowStartTicks;
      const baselined = baselinedNew || !bornInWindow;
      if (!baselinedNew && !bornInWindow) preWindowEntrants += 1;
      highWater.set(key, {
        baselineUser: baselined ? row.user : 0,
        baselineSystem: baselined ? row.system : 0,
        maxUser: row.user,
        maxSystem: row.system,
      });
    }
  }
  return preWindowEntrants;
}
export function highWaterDeltaTotals(highWater: Map<string, HighWaterEntry>) {
  let user = 0, system = 0;
  for (const entry of highWater.values()) {
    user += Math.max(0, entry.maxUser - entry.baselineUser);
    system += Math.max(0, entry.maxSystem - entry.baselineSystem);
  }
  return { user, system };
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
function stopProcessGroup(pgid: number) { try { process.kill(-pgid, "SIGSTOP"); return true; } catch { return false; } }
function resumeProcessGroup(pgid: number) { try { process.kill(-pgid, "SIGCONT"); } catch { /* group already gone */ } }
async function collectProcessGroupPids(pgid: number) { return (await procStats()).filter(sample => sample.pgrp === pgid).map(sample => sample.pid); }
// Attach-before-fork containment. The command starts before this helper runs, so a child that
// forks during startup would escape a move of only the root pid: that descendant stays in the
// original cgroup, outside the quota and the cpu.stat accounting. The spawned group is detached
// and private to this run, so stop the whole group first (no group member can fork while
// stopped; a fork that already completed appears in /proc and is swept), move every group member
// and every descendant still in the ppid tree into the cgroup, then resume. The pause lasts as
// long as the /proc scans and writes take - bounded by the 8-pass cap on passes, not by any
// guaranteed millisecond budget. The freshly spawned root can also exit before or during this
// work: its numeric pid is only ever written to cgroup.procs (an ESRCH there is benign) and the
// group stop/resume tolerate the group being gone. This preserves the
// spawn contract exactly: no launcher, no shell, no change to command-not-found or
// detached/group behavior. Residual limits (disclosed, not claimed closed): a descendant that
// left the process group before the stop keeps running during the sweep and can fork further,
// and a fully daemonized descendant (reparented to init) escapes the tree; closing those needs
// a gated launcher, which changes spawn-error semantics. cpu.stat covers CPU consumed after
// containment; the milliseconds between spawn and containment are outside the cgroup (measured
// limitation). Appends let a test on a plain filesystem observe every moved pid.
// Only ESRCH proves the pid exited between the scan and the write (benign: a dead process holds
// no CPU and inherits nothing). Permission, controller or busy errors are containment failures.
export function isBenignProcWriteError(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === "ESRCH";
}
export async function containProcessGroupInCgroup(directory: string, pid: number, pgid: number | null) {
  const writeProc = async (member: number) => {
    try {
      await fs.writeFile(`${directory}/cgroup.procs`, `${member}\n`, { flag: "a" });
    } catch (error) {
      if (!isBenignProcWriteError(error)) throw error;
    }
  };
  if (pgid === null || pgid <= 0) {
    await writeProc(pid);
    return;
  }
  const stopped = stopProcessGroup(pgid);
  try {
    const moved = new Set<number>();
    for (let pass = 0; pass < 8; pass += 1) {
      let added = false;
      for (const member of await collectProcessGroupPids(pgid)) {
        if (moved.has(member)) continue;
        moved.add(member); added = true;
        await writeProc(member);
      }
      if (!added) break;
    }
    // Descendants that already left the process group (setsid/setpgid before the stop) are not
    // covered by the group scan, so sweep the ppid-ancestry tree too. Residual limitation: the
    // stop cannot freeze a group-escaped descendant, which can keep forking during the sweep,
    // and full daemonization (reparented to init) escapes the tree entirely.
    for (const row of await processTreeRows(pid)) {
      if (moved.has(row.pid)) continue;
      moved.add(row.pid);
      await writeProc(row.pid);
    }
    // The root itself is in the group it leads; this covers the rare case where the group stop
    // failed because the root already exited but other members remain.
    if (!moved.has(pid)) await writeProc(pid);
  } finally {
    if (stopped) resumeProcessGroup(pgid);
  }
}
// A populated kernel cgroup cannot be removed (EBUSY): move its member processes out first. The
// immediate parent enables the cpu controller for its children, so it cannot host processes
// itself; the move-back target is the delegated subtree root's cgroup.procs. Best effort: the
// whole cleanup path tolerates failure because a leftover empty cgroup directory is retried on
// the next finish and carries no running processes after the run's tree has exited.
// Returns how many member moves failed (excluding ESRCH: a process that already exited needs no
// move). Callers must surface a nonzero count: without it, a failed rollback would leave live
// processes confined by this run's cpu.max while the run reports a nice-only fallback.
async function releaseCgroupProcesses(directory: string) {
  const procs = await fs.readFile(`${directory}/cgroup.procs`, "utf8").catch(() => "");
  const root = process.env.PAPERCLIP_CGROUP_ROOT || "/sys/fs/cgroup";
  let failed = 0;
  for (const line of procs.split("\n")) {
    const member = line.trim();
    if (!member) continue;
    try {
      await fs.writeFile(`${root}/cgroup.procs`, `${member}\n`, { flag: "a" });
    } catch (error) {
      if (!isBenignProcWriteError(error)) failed += 1;
    }
  }
  return { failed };
}
async function tryCreateCgroup(runId: string, pid: number, pgid: number | null, quotaPercent: number) {
  if (process.platform !== "linux") throw new Error("cgroup v2 is only available on Linux");
  const root = process.env.PAPERCLIP_CGROUP_ROOT || "/sys/fs/cgroup";
  const parent = `${root}/paperclip-runs`;
  const directory = `${parent}/${runId}`;
  try {
    await fs.mkdir(parent, { recursive: true });
    // cgroup v2: a child exposes cpu.max only when +cpu is enabled in its parent's
    // subtree_control, and creating directories does not enable it. Enable at both ancestors
    // (append: each write is an add-command on cgroupfs and must not clear other controllers).
    // A failure here means this host cannot enforce the quota in a fresh subtree, so it
    // propagates into the honest nice fallback below.
    await fs.writeFile(`${root}/cgroup.subtree_control`, "+cpu\n", { flag: "a" });
    await fs.writeFile(`${parent}/cgroup.subtree_control`, "+cpu\n", { flag: "a" });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(`${directory}/cpu.max`, `${Math.max(1, Math.floor(quotaPercent * 1_000))} 100000`);
    await containProcessGroupInCgroup(directory, pid, pgid);
    const start = cpuStat(await fs.readFile(`${directory}/cpu.stat`, "utf8")); if (!start) throw new Error("cgroup cpu.stat did not report usage_usec");
    return { directory, start };
  } catch (error) {
    const rollback = await releaseCgroupProcesses(directory);
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (rollback.failed > 0) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}; cgroup rollback incomplete: ${rollback.failed} moved process(es) could not be moved back out of ${directory} and may still be confined by its cpu.max`);
    }
    throw error;
  }
}
export async function beginLocalRunCpuAccounting(runId: string, pid: number, processGroupId: number | null) {
  const requested = controls.get(runId) ?? { nice: null, quotaPercent: null }, startedAt = Date.now();
  let cgroup: Awaited<ReturnType<typeof tryCreateCgroup>> | null = null, fallbackReason: string | undefined, appliedNice: number | undefined;
  if (requested.quotaPercent !== null) try { cgroup = await tryCreateCgroup(runId, pid, processGroupId, requested.quotaPercent); } catch (error) { fallbackReason = error instanceof Error ? error.message : String(error); }
  const desiredNice = requested.nice ?? (requested.quotaPercent !== null && !cgroup ? 10 : null);
  if (desiredNice !== null) try { os.setPriority(pid, desiredNice); appliedNice = desiredNice; } catch (error) { fallbackReason = [fallbackReason, error instanceof Error ? error.message : String(error)].filter(Boolean).join("; "); }
  // Non-cgroup sampling: per-process high-water accumulation keyed by pid AND kernel starttime,
  // so a recycled pid is a distinct process and never conflated with its predecessor. A
  // process's /proc counters only rise while it lives, so keeping the highest value observed
  // per identity preserves CPU already observed for descendants that exited before a later
  // sample (they then disappear from /proc). Applies to both the process-group match and the
  // process-tree match (no process group on the ACP spawn path; see processTreeRows for the
  // tree membership rule). Identities present in the begin sample keep their observed value as
  // a subtracted baseline, so a reused (warm) process reports only this window's work. An
  // identity entering the sampled set later is disambiguated by its kernel starttime against
  // the window start (see foldProcRowsIntoHighWater): born in-window counts from zero, a
  // pre-existing entrant is baselined and flagged in unmeasuredPriorCpuProcesses because its
  // prior CPU is unknown rather than measured run CPU.
  // Measured sampling limitations (not guaranteed bounds): a process that starts and exits
  // entirely between two samples is never observed; a process reparented out of the tree stops
  // being matched.
  // Round the window start up so fractional-tick truncation cannot classify a just-pre-window
  // process as born in-window.
  const uptimeTicks = await kernelUptimeTicks();
  const windowStartTicks = uptimeTicks === null ? null : Math.ceil(uptimeTicks);
  let preWindowEntrants = 0;
  const collectRows = processGroupId ? () => processGroupRows(processGroupId) : () => processTreeRows(pid);
  const highWater = new Map<string, HighWaterEntry>();
  foldProcRowsIntoHighWater(highWater, await collectRows(), true, windowStartTicks);
  const sampler = setInterval(() => { void collectRows().then(rows => { preWindowEntrants += foldProcRowsIntoHighWater(highWater, rows, false, windowStartTicks); }); }, 250); sampler.unref();
  return async () => {
    if (sampler) clearInterval(sampler); const wallSeconds = (Date.now() - startedAt) / 1_000;
    let result: LocalRunCpuAccounting;
    if (cgroup) {
      const end = cpuStat(await fs.readFile(`${cgroup.directory}/cpu.stat`, "utf8").catch(() => ""));
      const user = end && end.user !== null && cgroup.start.user !== null ? (end.user - cgroup.start.user) / 1_000_000 : null, system = end && end.system !== null && cgroup.start.system !== null ? (end.system - cgroup.start.system) / 1_000_000 : null, cpu = end ? (end.usage - cgroup.start.usage) / 1_000_000 : null;
      await releaseCgroupProcesses(cgroup.directory);
      await fs.rm(cgroup.directory, { recursive: true, force: true }).catch(() => undefined);
      result = { schema: "paperclip.local_run_cpu.v1", scope: "local_process_tree", quality: "exact_cgroup_v2", userCpuSeconds: user, systemCpuSeconds: system, cpuSeconds: cpu, wallSeconds, control: { requestedQuotaPercent: requested.quotaPercent, requestedNice: requested.nice, method: "cgroup_v2", quotaEnforced: true, ...(appliedNice !== undefined ? { appliedNice } : {}) } };
    } else {
      preWindowEntrants += foldProcRowsIntoHighWater(highWater, await collectRows(), false, windowStartTicks);
      const end = highWaterDeltaTotals(highWater), userCpuSeconds = end.user / PROC_TICKS_PER_SECOND, systemCpuSeconds = end.system / PROC_TICKS_PER_SECOND;
      result = { schema: "paperclip.local_run_cpu.v1", scope: "local_process_tree", quality: "approximate_proc_group", userCpuSeconds, systemCpuSeconds, cpuSeconds: userCpuSeconds + systemCpuSeconds, wallSeconds, ...(preWindowEntrants > 0 ? { unmeasuredPriorCpuProcesses: preWindowEntrants } : {}), control: { requestedQuotaPercent: requested.quotaPercent, requestedNice: requested.nice, method: appliedNice !== undefined ? "nice" : "none", quotaEnforced: false, ...(fallbackReason ? { fallbackReason } : requested.quotaPercent !== null ? { fallbackReason: "No delegated writable cgroup v2 subtree was available" } : {}), ...(appliedNice !== undefined ? { appliedNice } : {}) } };
    }
    const merged = mergeLocalRunCpuAccounting(completed.get(runId)?.accounting ?? null, result);
    rememberCompleted(runId, merged); return merged;
  };
}
