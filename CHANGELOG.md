# Changelog

## 0.5.10 — 2026-11-09

- Include the cluster column in `slurm_jobs` rendering when cluster-qualified
  jobs are present.

## 0.5.9 — 2026-11-09

- Decode backslash escapes in `#SBATCH` directives before checking, closing the
  `--ar\ray` / `\--array` / `--clu\sters` bypasses.
- Complete cluster identity: the ledger key includes cluster, `slurm_jobs`
  exposes it, status uses per-job `-M`, and `slurm_watch` uses the explicit
  cluster for both the query and the stored record.

## 0.5.8 — 2026-11-09

- Restore the post-transfer symlink escape scan removed while rewriting the
  finalize helper; add direct `sftpFetch` coverage so the executable path is
  exercised.

## 0.5.7 — 2026-11-09

- Preserve cluster identity for a cluster-qualified parsable id: store it on
  the job and pass `-M <cluster>` to `squeue`, `sacct`, `scancel`, `scontrol`
  and `slurm_watch`.
- Tokenize `#SBATCH` lines with quote awareness so `--comment="#" --array`
  cannot bypass the array/cluster guard; anchor final fetch rename to the
  directory inode with `chdir` to close the check/rename window.

## 0.5.6 — 2026-11-09

- Final recheck: canonicalize the fetch destination parent before staging and
  revalidate it at finalize; require complete SINFO/QUEUE/NODES framing.
- Normalize quoted `#SBATCH` tokens, stop at unescaped inline comments, and
  parse clustered short options without treating option values as flags.
- Derive an array parent's state from its task rows and keep only the parent
  row; allow `-A/-C` style short options.

## 0.5.5 — 2026-11-09

- Recheck fixes: revalidate the destination parent before finalize; require
  section start markers and numeric exits; aggregate array parents without
  duplicate task rows and prefer RUNNING; mixed completed/preempted arrays use
  the requeue grace; delivery checks the watcher stop hook after agent
  resolution; snapshot cache is per plugin instance and keyed by the resolved
  connection.
- Reject clustered short options and long-option abbreviations that change the
  submit protocol, while allowing `--gres-flags`, `--mem-bind` and
  `--wait-all-nodes`; stop reading `#SBATCH` directives at the first executable
  line.
- Treat an empty lock owner as in-progress; fix the E2E output directory;
  separate GET and host-switch errors.

## 0.5.4 — 2026-11-09

- Fetch writes into a private staging directory and renames it into place,
  closing the pre-existing-symlink window.
- Requeueable states get a three-check grace window before finishing.
- A queue-only terminal row keeps its real state instead of `UNKNOWN`.
- Require complete query framing; reject truncated/timeout snapshots.
- Preserve a cluster-qualified parsable job id with a tracking error.
- Validate script `#SBATCH` directives; fix `%%` templates; reject option
  abbreviations; atomic lock directory; pre-abort and process-group kill;
  separate host-switch errors.

## 0.5.3 — 2026-11-09

- Shorten the OpenSSH control-socket path (the 0.5.2 per-home prefix could
  exceed the 104-byte Unix socket limit on macOS).
- Surface the SSH error alongside “status marker missing” diagnostics.
- Keep the panel error text when a cluster switch fails after a successful
  read.

## 0.5.2 — 2026-11-09

- Preserve the job id when `--parsable` returns `<id>;<cluster>`; report a
  `trackingError` instead of failing after a successful submission.
- Require complete section markers and reject truncated/timed-out queries.
- Add the requeue grace window for `PREEMPTED`/`NODE_FAIL`/`SPECIAL_EXIT`.
- Validate script `#SBATCH` directives and fix `%%` log-template parsing.
- Reject short/long sbatch option abbreviations that bypass reserved flags.
- Use an atomic writer-lock directory, pre-abort checks and process-group kill.
- Keep a separate client host-switch error; localize progress accessibility.
- Strengthen tests to 91 cases and fix manual probe paths.

## 0.5.1 — 2026-11-09

- A stale snapshot is no longer served from the fresh TTL window.
- Add regression coverage for SFTP path quoting, symlink escapes, writer locks,
  array aggregation, per-section query failures, submit uniqueness, tracking
  errors, stderr logs, reattach and the time-limit units.

## 0.5.0 — 2026-11-09

Security and correctness pass after the Codex review (0.4.1):

- `slurm_fetch` now uses SFTP batch transfers (no remote shell), creates a fresh
  destination under an allowed root, and rejects downloaded symlinks that
  escape it.
- Scheduler queries carry per-section exit markers; a failed `squeue`/`sacct`
  is no longer an empty observation and never marks a job finished. Missing
  jobs stay tracked as `MISSING`.
- Arrays match exact task ids and aggregate parent state/exit codes; submission
  of `--array` and `--clusters` is rejected explicitly.
- `PREEMPTED`, `NODE_FAIL` and `SPECIAL_EXIT` are no longer terminal.
- Watcher stop aborts in-flight SSH/tail; no write/delivery after disposal.
- Job operations resolve host/task identity; ambiguous ids require `host`.
- Submission scripts get a random suffix, exclusive create, preflight Session
  validation, and a `trackingError` result when the ledger write fails.
- Extra sbatch args are validated (reserved flags rejected) instead of dropped;
  log templates only expand `%j`, `%x`, `%A`, `%%`.
- State/prefs commit to disk before memory; a writer lock rejects a second Host
  sharing `$DSH_HOME`.
- Snapshot cache shares in-flight requests, records real capture time, and keeps
  the last good snapshot on failure.
- Client: switch failures are no longer cleared by a successful refresh; POST
  is abortable; stale/error indicators are explicit.


## 0.4.1 — 2026-11-09

- Keep the previous panel snapshot and mark the header when the scheduler is
  unreachable; show the stale reason inline.
- Treat a route-level `ok:false` as an error without discarding the last good
  panel data.

## 0.4.0 — 2026-11-09

- Rename the package from `@local/dsh-slurm` to `dsh-slurm`; add MIT license,
  CI, dependency declarations and publishable metadata.
- Remove the bundled default host; the cluster is selected in the right
  sidebar and stored in `$DSH_HOME/slurm/prefs.json`.
- Make `dsh-better-sidebar` an optional peer: tools and completion follow-ups
  work without it; the panel mounts when the service is present.
- Redesign the right sidebar: one merged job list, collapsible recent
  completions, compact cluster capacity, theme tokens, relative timestamps,
  loading/error/empty states, and visibility-aware polling.
- Refactor the host into `src/panel.js`, `src/message.js` and `src/http.js`;
  add schema, watcher, route and client smoke tests.
- Fix `timeLimit` output-schema drift, relative `logPath`, and `slurm_watch`
  detach across clusters.

## 0.3.1

- Declare `timeLimit` in the `slurm_status` queue schema.
- Add the cluster selector to the right sidebar and let the Agent see the
  selected cluster.

## 0.3.0

- Add host switching persisted in `$DSH_HOME/slurm/prefs.json`; tools default
  to the selected cluster.

## 0.2.2

- Add the right-sidebar panel (dsh-better-sidebar) with progress, queue and
  cluster capacity.

## 0.1.0

- Initial Host-only bundle: `slurm_*` tools, completion watcher, logs, cancel,
  watch and fetch.
