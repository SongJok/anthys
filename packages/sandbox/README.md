# Analysis sandbox executor

`DockerAnalysisSandbox` runs one already-authorized job from `packages/analysis` in the pinned `deploy/images/analysis-sandbox.Dockerfile` image. It is not a broker and does not verify signatures, resolve artifacts, persist results or enforce budgets.

## Required host responsibilities

The caller must verify the signed job against the current subject, run/task state, cancellation, actor epoch, nonce and artifact ACLs, and bind the actual code/input bytes. The executor re-validates the closed job shape, code size (1 MiB), input count/size (at most the job's artifact IDs, 8 MiB total), code/input correspondence and output count/size.

The image argument must be an exact sha256 image ID (`sha256:<64 hex>` or the bare ID). Tags are rejected. `seccompPath` must be an absolute existing file, normally `deploy/policies/seccomp.json`. `workspaceRoot` must be on a filesystem shared with the Docker daemon; the default temp directory may not be shared on Docker Desktop.

## Isolation

Every execution creates a fresh workspace, writes the entry point and input artifacts read-only, and starts a new container with:

- pinned image, `--pull never`, `--network none`, `--ipc none`
- `--read-only`, a no-exec `/tmp` tmpfs, non-root `10001:10001`
- `--cap-drop ALL`, `no-new-privileges`, the reviewed seccomp profile
- `--pids-limit` (64 default), memory and memory-swap equal to the job limit, fixed one CPU
- CPU rlimit derived from the job, `nofile=64`
- only the read-only input and writable output bind mounts; no host env, Docker socket, devices or extra mounts
- Node's permission model allowing reads under `/sandbox/input`, `/sandbox/output` and writes only under `/sandbox/output` and `/tmp`

The user code is the container entry point. `ANTHYS_INPUT_DIR` and `ANTHYS_OUTPUT_DIR` are fixed; `manifest.json` maps the code artifact ID and input artifact IDs. Outputs are flat regular files with extensions derived from `allowedOutputTypes`; symlinks, directories, oversized totals and more than 64 files are rejected. Output is not content-type verified here.

Wall time, stdout/stderr and output totals are enforced by the host. The output bind directory has no filesystem quota, so the 25 ms host poll is a best-effort kill shortly after the cap; the production broker should place `workspaceRoot` on a quota-limited volume. A timed-out, cancelled, oversized or failed run returns no outputs. The container is force-removed and the workspace is deleted after every run, with a root-inside-container cleanup fallback for files the sandbox made unreadable to the host.

The result states are `SUCCEEDED`, `FAILED`, `TIMEOUT`, `CANCELLED` and `LIMIT_EXCEEDED`. `SUCCEEDED` only means the process exited zero and final outputs passed the sandbox checks; it does not prove business correctness, archive/MIME safety or result ACLs.

## Limitations

This package is not wired to an API, queue, artifact store or broker. It does not persist a nonce or reservation, enforce tenant budgets, verify output MIME/office validity, deliver results, or implement restart-safe cancellation. `deploy/compose` still has no sandbox-broker service.
