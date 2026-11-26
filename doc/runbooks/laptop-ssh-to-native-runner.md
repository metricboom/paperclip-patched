# Deploy card: move a laptop agent from SSH to the native runner

Scope: agents on one SSH execution environment (Laptop 1), currently `claude_local` (Ada, Finch) and `codex_local` (Chloe, Neo). Written against master `ff5e35dd`. Nothing here was run against a live server, the VPS, or a laptop. The operator runs every step.

**Read this first: after the switch, an SSH run resumes from its checkpoint as a new launch. It is not reattached.** A server restart starts a new Runner process and a new provider attempt that resumes the saved session; the live process is not adopted. This is accepted as interim behaviour because it beats today's dead `legacy_execution_requires_reconciliation` runs. It does not meet the goal of a true reattach, which is a separate job (SSH reattach is not built). The pilot criteria in section 5 check for this resume behaviour.

Placeholders: `$PC` (Paperclip base URL), `$AUTH` (a board credential header, kept in your shell; never paste its value into a ticket or log), `$AGENT_ID`, `$ENV_ID`, `$RUN_ID`, `$COMPANY_ID`.

## 0. Read this first: SSH is not restart-reattachable today

The goal of the move is that a server restart no longer kills a laptop run. The code does not give that on an SSH environment:

- The same-run reattach check for a native runner only accepts a **sandbox lease** (or a plugin task). `verifyRemoteRunnerReattachment` throws `native_remote_recovery_lease_mismatch` (stage `runner_verification`, field `target`) for any other target, before it runs a command on the host: `server/src/services/native-runtime/native-session-executor.ts` (search `verifyRemoteRunnerReattachment`).
- Restart classification only produces `reattach_remote_runner` for a run with a synced sandbox workspace (`nativeWorkspaceSync` / `remoteWorkspace`) or a plugin task. SSH runs have neither: `server/src/services/native-runtime/native-restart-recovery.ts` (`remoteSandbox`, `classifyNativeRunnerRecoveryEvidence`). From the code, an SSH run lands on the checkpoint path (`resume_dead_runner`: a new Runner launch that resumes the saved provider session, charged against 3 provider attempts) instead of adopting the live process. This reading is not proven by a test; the pilot in section 5 measures it.
- Pinned by `server/src/services/native-runtime/remote-runner-ssh-reattach.test.ts`.

What moving to the native runner does give on SSH: runs finish through the durable PRP outbox, and a restart goes to a bounded checkpoint resume rather than `legacy_execution_requires_reconciliation`. Decision (tech lead): checkpoint resume is acceptable for now. **Do not roll out past the pilot unless section 5 passes.** Same-process reattach is not expected on SSH and is not a pass criterion.

## 1. Which route: adapter switch, not environment switch

Switch the agent's adapter to `paperclip_runner`. There is no "native runner environment" that keeps `claude_local` / `codex_local`:

- `resolveNativeRuntimeMode` returns `legacy` / `direct_adapter` for any adapter other than `paperclip_runner`, and the compatibility rules say "a direct adapter stays direct": `server/src/services/native-runtime/runtime-mode.ts`, `doc/architecture/paperclip-runner-compatibility.md`.
- `paperclip_runner` supports the `ssh` driver: `packages/shared/src/environment-support.ts` (`supportedEnvironmentDriversForAdapter`). So the existing SSH environment `5de82ba7-1a62-4d50-8d16-194f40039504` stays as is.
- The product converts in place: `PATCH /api/agents/:id` with `runner: "paperclip"` maps Codex to provider `codex`, and Claude to provider `acpx` with `acpxAgent: claude`, keeping model, instructions, and environment: `server/src/services/agent-runner-selection.ts`, `server/src/routes/agents.ts` (PATCH handler). Execution sessions reset; run history is kept (`doc/runner-internals.md`, "Paperclip Runner Adapter Conversion").
- Conversion rejects, before saving, settings the runner cannot honor (custom `command`, `extraArgs`, legacy permission modes, nonzero turn limits). Fix those first or the agent stays legacy.

## 2. Laptop prerequisites (names only; no values)

1. **Platform.** Linux x64/arm64 with glibc >= 2.39 (for WSL: Ubuntu 24.04 or newer), or macOS. Claude over macOS SSH keeps a Legacy default and needs matching remote assets: `packages/shared/src/agent-runner.ts`, `server/src/services/agent-runner-selection.ts`.
2. **No resident daemon to install or enrol.** The server launches `paperclip-runnerd` over SSH per run from the installed Paperclip release and stages its launch files. Enrolment is automatic: a one-use bootstrap ticket bound to company, agent, issue, run, and artifact is exchanged for a short-lived connection lease; raw tickets are not stored (`doc/architecture/paperclip-runner.md`, "Trust boundary"). The daemon must come from the **same release** as the server. Override only with `PAPERCLIP_RUNNER_REMOTE_BINARY_PATH`.
3. **Claude agents (Ada, Finch).** Install that release's provider pack on the laptop at `$HOME/.local/share/paperclip-runner/provider-pack` or `/opt/paperclip-runner/provider-pack` (`doc/runner-internals.md`). A missing or mismatched pack fails the run with a clear error.
4. **Codex agents (Chloe, Neo).** Codex CLI accepted window is `>=0.149.0 <0.171.0`; install pin `0.170.0` (`doc/architecture/paperclip-runner-compatibility.md`, `server/src/services/native-runtime/codex-runtime-compatibility.ts`). If the laptop's Codex is outside the window, set the server variable `PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC` to `@openai/codex@0.170.0`.
5. **Network path.** The Runner dials **back** to the server over `wss://`. The Paperclip server needs `PAPERCLIP_RUNNER_PUBLIC_URL` set to a `wss:` URL (no userinfo, query, or fragment) that the laptop can reach, and `PAPERCLIP_RUNNER_CA_BUNDLE_PATH` if its certificate is private: `packages/adapter-utils/src/runner-connectivity.ts`. Without it the run fails with `runner_direct_wss_failed` / `runner_transport_ineligible`. Today's SSH path over Tailscale (`doc/tailscale-environments.md`) covers only the server-to-laptop SSH leg; confirm the laptop can also open an outbound HTTPS/WSS connection to the server's tailnet name.
6. **Surviving reboots and WSL restarts.** Nothing keeps the Runner alive across them: it is a per-run process, so a laptop reboot or `wsl --shutdown` ends the run's Runner and provider. The laptop must keep `sshd` reachable: in WSL set `systemd=true` under `[boot]` in `/etc/wsl.conf` and `sudo systemctl enable ssh`, and keep the laptop awake and on the tailnet while agents work. A run lost this way goes to checkpoint resume, not reattach.
7. **Secrets by name.** Agents use their Paperclip AI connection, or the laptop user's own provider login when the environment has "Use authentication configured on the remote machine" on (it is what selects `homeMode: preconfigured`). The server holds `PAPERCLIP_RUNNER_PUBLIC_URL` and, if needed, `PAPERCLIP_RUNNER_CA_BUNDLE_PATH`. No secret value belongs in this card.
8. **Instance flag.** Claude (ACPX) and Codex run without the experimental flag; other providers need it (`runtime-mode.ts`). Confirm with the probe in step 3.2.

## 3. Per-agent switch steps

Do these only when the agent has **no live run** (step 3.1 check).

1. Confirm idle: `curl -s -H "$AUTH" "$PC/api/companies/$COMPANY_ID/heartbeat-runs?agentId=$AGENT_ID" | jq '[.[] | select(.status=="queued" or .status=="running")] | length'`. Must print `0`. If not, wait or cancel via `POST /api/heartbeat-runs/$RUN_ID/cancel`.
2. Save current config:
   - `curl -s -H "$AUTH" "$PC/api/agents/$AGENT_ID/configuration" > agent-$AGENT_ID.before.json` (secrets are redacted in this output).
   - `curl -s -H "$AUTH" "$PC/api/environments/$ENV_ID" > env-$ENV_ID.before.json`.
   - `curl -s -H "$AUTH" "$PC/api/agents/$AGENT_ID/config-revisions" | jq '.[0]' > rev-$AGENT_ID.before.json` and note the newest revision id as `$REV_BEFORE` (the rollback target).
   - Keep these files off tickets; they hold host and path details.
3. Probe the environment for this agent's harness: `POST $PC/api/environments/$ENV_ID/probe`. Expect `ok: true`. Stop on failure.
4. Switch: `curl -s -X PATCH -H "$AUTH" -H 'content-type: application/json' "$PC/api/agents/$AGENT_ID" -d '{"runner":"paperclip","expectedConfigurationRevision":"<revision from step 2>"}'`. Expect HTTP 200 with `adapterType: "paperclip_runner"` and `adapterConfig.provider` of `codex` (Codex agents) or `acpx` with `acpxAgent: "claude"` (Claude agents). A 422 `agent_runner_config_incompatible` lists fields to remove; a 422 `agent_runner_unavailable` means the platform check failed (section 2.1). Nothing is saved on error.
5. Check: `curl -s -H "$AUTH" "$PC/api/agents/$AGENT_ID" | jq '{adapterType, defaultEnvironmentId}'` shows `paperclip_runner` and the same environment id as before.
6. UI path: not verified in this session. Use the API above.

## 4. Pilot order

1. Pilot agent: **Chloe** (`codex_local`). Codex has the most restart coverage (section 7). Switch it per section 3 while it has no live run.
2. Run the staged restart check (section 6) on Chloe.
3. Only if section 5 passes: switch Neo, then Ada, then Finch, one at a time, each idle at the time of the switch. Claude agents are a different provider path (ACPX); give Ada her own short pass (steps 5.1 to 5.3) before Finch.

## 5. Pass and stop criteria for the pilot

Pass (all of):
- A throwaway task run on the pilot shows `runtimeMode: native` and finishes `succeeded` with the expected output.
- After the restart check, the **same run id** continues and finishes (no new run id for the same wake), output continues in `GET $PC/api/heartbeat-runs/$RUN_ID/events` after the restart time, and no `issue_recovery_actions` row with cause `legacy_execution_requires_reconciliation` or `native_continuation_requires_reconciliation` exists for it.
- Checkpoint-resume evidence (section 6, step 7): `recovery_history` shows `resume_dead_runner`, a new `native.process_start_requested` event with a higher `providerAttempt`, and a new `paperclip-runnerd` PID on the laptop. This is the expected SSH outcome, not a failure.

Stop and roll back (any of):
- The run id changes, the run ends `failed`/`cancelled`, or a reconciliation cause above appears.
- `native_remote_recovery_lease_mismatch` surfaces as a run failure rather than falling through to checkpoint resume, or `runner_remote_recovery_identity_mismatch` appears.
- The disposition is neither `resume_dead_runner` nor `reattach_remote_runner`. If it is `reattach_remote_runner`, report it: it contradicts section 0.
- Two restarts in a row exhaust the 3-attempt budget (`execution_recovery_budget_exhausted`).

## 6. Staged restart check (operator decides when to restart the live server)

This step restarts the live Paperclip container. The operator chooses the time, confirms no other agents or users depend on it, and runs it; nothing in this repo does it.

1. Create a throwaway task assigned to the pilot agent whose prompt takes a few minutes and writes a visible marker, for example: "Count from 1 to 200, one number per line in the task comment thread every ~5 seconds, then reply DONE." Note `$RUN_ID` from `GET $PC/api/companies/$COMPANY_ID/heartbeat-runs?agentId=$AGENT_ID`.
2. Wait until output is flowing: `GET $PC/api/heartbeat-runs/$RUN_ID/events` returns events with rising `seq`. Record `seq` and `date -u` as T0.
3. Record before-evidence (read-only): `GET $PC/api/heartbeat-runs/$RUN_ID` fields `id`, `status`, `runtimeMode`, `processPid`; and on the laptop `pgrep -af paperclip-runnerd` (note the PID and start time).
4. **Restart the Paperclip container** (your orchestrator's restart command; the operator's call).
5. After `GET $PC/api/health` is ready, poll `GET $PC/api/heartbeat-runs/$RUN_ID` and the events until the task finishes.
6. Evidence of checkpoint resume (the expected SSH outcome; all must hold):
   - Same run id, final `status: succeeded`, `errorCode` null.
   - Events after T0 continue with `seq` above the recorded value, and a new `native.process_start_requested` event with a higher `providerAttempt` appears.
   - Laptop: a new `paperclip-runnerd` PID and start time, different from step 3. If the old PID is still running too, kill nothing; report it.
   - Read-only SQL: `select recovery_history from native_run_finalizations where run_id = '<RUN_ID>';` last entry has `disposition: resume_dead_runner`; and `select cause from issue_recovery_actions where fingerprint like '%<RUN_ID>%';` returns no reconciliation cause.
   - Server log lines (search by `$RUN_ID`) show no `runner_remote_recovery_identity_mismatch`.
7. Evidence that would show a true reattach (not expected on SSH; report it if seen): `disposition: reattach_remote_runner`, an unchanged `native.process_start_requested` count, and the same `paperclip-runnerd` PID and start time as step 3.

## 7. Existing tests this relies on, and what they do not prove

Run from the repo root (Rust toolchain 1.97.1 needed; the ACPX test builds `paperclip-runnerd`):

- Claude path (ACPX), controller replaced, same Runner process and turn: `cd packages/paperclip-runner && npx vitest run src/control-plane/acpx-controller-adoption.test.ts`: 11 passed. Test "keeps the original native ACPX process and active turn through controller replacement".
- Codex path, live Runner adopted by a new controller: `npx vitest run src/live/runnerd-codex-transport-adoption.test.ts`: 26 passed.
- Server verifier of a live remote Runner: `cd server && npx vitest run src/services/native-runtime/native-runner-restart-recovery.integration.test.ts -t "adopts a live Runner|fails closed when the Runner|stays fail-closed"` (with `environment-live-ssh.test.ts`): 7 passed, 243 skipped by filter.
- SSH gap (new): `cd server && npx vitest run src/services/native-runtime/remote-runner-ssh-reattach.test.ts`: 1 passed.
- SSH adapter tests unchanged: `packages/adapter-utils` `ssh-auth`, `ssh-command-managed`, `ssh-export`, `ssh-export-stream`, `ssh-fixture`, `ssh-tailscale` tests: 65 passed, 2 skipped; `packages/adapters/codex-local` `src/server/execute.ssh-host-auth.test.ts`: 14 passed.
- Container tests for completed-turn warm continuity under `native-runner-restart-recovery.integration.test.ts` run only with `PAPERCLIP_TEST_RUNNER_CONTAINER` set (Docker). They were not run here.

Not proven: a server restart with a real SSH-hosted Runner (no automated test; the server-level path refuses SSH), real laptop network drops, WSL restarts or sleep, the `wss` dial-back over Tailscale, or four agents under load.

## 8. Rollback to SSH

1. Prefer the saved revision: `curl -s -X POST -H "$AUTH" "$PC/api/agents/$AGENT_ID/config-revisions/$REV_BEFORE/rollback"`. It restores the saved `adapterType` and `adapterConfig`.
2. If the rollback is rejected, patch from the saved file: `PATCH $PC/api/agents/$AGENT_ID` with `{"runner":"legacy"}`, then re-apply `adapterConfig` values from `agent-$AGENT_ID.before.json` (redacted fields must be re-entered by name through the secrets UI). `runner: "legacy"` maps a native Claude/Codex agent back to `claude_local` / `codex_local`.
3. Confirm: `GET $PC/api/agents/$AGENT_ID` shows `adapterType` `claude_local` or `codex_local` and the original `defaultEnvironmentId`. Run a throwaway task; `GET $PC/api/heartbeat-runs/$RUN_ID` shows `runtimeMode: legacy` and the run executes on the SSH environment.
4. A run **in flight** during rollback keeps the path it started on: the runtime is persisted before launch and a later change does not move it (`doc/architecture/paperclip-runner-compatibility.md`, "Runtime selection"). The native run stays recoverable and finalizes as native; only new runs use SSH. To avoid mixed state, switch back only when the agent is idle, or cancel the native run first.
5. SSH adapter code is unchanged by this move, so rollback does not depend on any new code.
