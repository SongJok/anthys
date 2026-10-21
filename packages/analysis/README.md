# Structured analysis job contract

This package currently supplies a **broker-reusable contract**, not a sandbox executor or completion of R21/P09. It performs no filesystem access, process creation, networking, credential access or artifact loading.

`src/job-contract.ts` exports `analysisJobSchema`, `AnalysisJob`, `AnalysisJobSubject`, `AnalysisJobPayload`, `AnalysisSignedJob`, `AnalysisJobSigningOptions`, `AnalysisJobVerificationOptions`, `AnalysisJobError`, `analysisDefaultLimits`, `analysisJobWireLimit`, `analysisJobMaxLifetimeMs`, `signAnalysisJob`, and `verifyAnalysisJob`.

## Wire and trusted configuration

```ts
const envelope = signAnalysisJob(job, {
  subject: {tenantId, actorId, authEpoch, taskId, runId, jobId},
  imageDigest: reviewedImageDigest, // trusted service configuration, sha256:<64 lowercase hex>
  keyId, privateKey, nonce, issuedAt, expiresAt,
});
const payload = verifyAnalysisJob(JSON.stringify(envelope), {
  expectedSubject: currentHostSubject,
  imageDigest: reviewedImageDigest,
  keyId, publicKey,
});
```

Keys are trusted host `KeyObject`s with algorithm Ed25519; signing requires a private key and verification a public key. Key ID and image digest have no fallback. `now` is optional in both configurations and defaults to `Date.now()`; an injected clock is a trusted host/test facility, never a request field. Verification accepts a string or UTF-8 `Uint8Array`/`Buffer`, bounds it to 32 KiB before decoding/JSON parsing, and rejects malformed UTF-8. It does not coerce object inputs to wire strings.

The closed job contains tenant/task/run/job UUIDs, `language` (`typescript` or `javascript`), a code artifact UUID, at most 64 unique input artifact UUIDs, `network: NONE`, four explicit positive integer limits, and one to eight unique output formats (`markdown`, `txt`, `csv`, `json`, `html`, `xlsx`, `docx`, `pdf`, matching the renderer names). There is no code text, image selector, path, mount, environment, secret, URL, command or raw identity/authorization field in a job. Artifact references are not resolved or authorized here.

Limits can only decrease from CPU time 60,000 ms, memory 512 MiB, wall time 60,000 ms and total output 20 MiB. CPU time and wall time are independent. The CPU time ceiling is this component's conservative mapping of the documented fixed 1 CPU × 60-second wall profile; the broker must separately enforce the fixed CPU quota. No default is silently filled into requests.

The signed payload binds `OA_ANALYSIS_JOB_V1`, the full job, its SHA-256, the service-selected image digest, nonce UUID, subject and issued/expiry integer epoch milliseconds. All repeated tenant/task/run/job values must match exactly. The subject additionally binds actor UUID and positive safe integer auth epoch. Verification also requires an exact match to the current subject supplied by the trusted host. The valid interval is `[issuedAt, expiresAt)`, at most 60,000 ms, with no future-issued clock allowance. Domain separation is `open_aider.analysis.job.v1` followed by a NUL byte. The signature encoding is canonical unpadded base64url (64 signature bytes).

Canonical JSON sorts object keys by JavaScript UTF-16 code-unit order, retains array order, and uses `JSON.stringify` primitive spelling. Only finite JSON data is allowed, and schema numbers are safe integers. Job hashing and signature canonicalization are local to this module; they import no gateway/runtime/storage code. Unknown input is snapshotted by inspecting own property descriptors: getters, `toJSON`, proxies, custom prototypes, symbol properties, sparse/decorated arrays, cycles, over-deep or overlarge data are rejected without invoking callbacks. Accepted outputs are independent, deeply frozen plain JSON snapshots.

Errors use fixed safe codes: `ANALYSIS_JOB_INVALID`, `ANALYSIS_JOB_WIRE_INVALID`, `ANALYSIS_JOB_WIRE_TOO_LARGE`, `ANALYSIS_JOB_KEY_INVALID`, `ANALYSIS_JOB_CONFIGURATION_INVALID`, `ANALYSIS_JOB_SIGNATURE_INVALID`, `ANALYSIS_JOB_BINDING_MISMATCH`, `ANALYSIS_JOB_EXPIRED`. They contain no request contents or key material.

## Required host and broker work

A signature authenticates a caller assertion. It does **not** prove artifact ownership/existence/content, task or run permission, current authorization, budget reservation, or nonce uniqueness. The same valid envelope can be verified repeatedly. Before execution, the host/broker must independently check current ACL, actor epoch, task/run state and cancellation; atomically persist/claim the nonce and bind the immutable code/input contents; reserve and enforce quotas. Recovery cannot treat an unconfirmed job as never dispatched merely because its signature expires.

The executor still needs the documented fixed image, non-root user, read-only dependency/root filesystem, private tmpfs, no network or business secrets, no host/Docker socket, no devices or arbitrary mounts, capability removal, no-new-privileges, seccomp/AppArmor, CPU/memory/wall/output limits, and explicit bounded PID/file quotas. The documents do not specify numeric PID/file-count defaults; this contract does not invent or claim enforcement of them. Runtime cancellation, process-tree termination, cleanup on failure/restart, output MIME/content/archive checks, artifact ACL/storage/downloads and task/tool registration are outside this module.

Pure contract tests cannot establish T097/T098 isolation, infinite-loop termination, memory/fork/file containment or cleanup. Those require an actual isolated executor and its integration/security acceptance. No execution service, startup hook, DB migration or formal test discovery registration is added here.
