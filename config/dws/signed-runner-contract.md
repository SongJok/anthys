# P06 standalone signed read transport, component v1

This component implements an independent DWS process and a Unix socket client.
It is an offline engineering deliverable. P06, P00–P14 and ENTERPRISE_DWS remain
incomplete. `configureDws` still rejects `DWS_RUNNER_SERVICE_REQUIRED`; no
application, real identity, resource grant or trial is automatically connected.

The only accepted operations are `VERIFY_IDENTITY` and `READ_SELF`, bound to the
locked v1.0.61 binary and exact `contact +me` schema. The service constructs CLI
arguments itself and retains the existing isolated workspace/process supervisor.
There is no generic argv, endpoint, file output, profile override, write command,
`--yes`, SQL or shell endpoint. Document and group RPC operations are absent.

## Integrity and delegation snapshot

Ed25519 signatures have a protocol domain separator. The caller first verifies a
runner-signed challenge containing its fresh nonce, the process instance UUID,
binary/schema binding and policy hash. Each signed request includes a fresh
request UUID, issue/expiry times (at most ten seconds), operation, credential
state and an exact tenant/owner/identity/task/run/auth-epoch/authorization-version
snapshot. The capability version and private owner audience must match the
fixed read leaf, and the caller key is pinned to one tenant/corp policy.

The runner verifies signatures, schema, scope, expiry and single-use nonce before
creating a credential workspace. Live nonces are never evicted to make room.
Retention requires both monotonic and wall-clock expiry; a wall-clock rollback
fails closed. A new process instance invalidates requests from previous starts.
Replies are signed and bound to the entire request digest, request UUID and
instance; the client verifies these before accepting rotated credential state.
The self result excludes phone/email and must name the exact delegated user.
Failures contain fixed codes, never vendor stderr, arbitrary error text or state.
The client does not retry or fall back to an in-process runner.

The signed snapshot is an assertion from the trusted caller. It does **not**
independently query current task, policy, grant, revocation or authorization rows.
It is not proof of current Gateway authority or a full revocable task delegation.
Production integration must add that lifecycle before the application can use it.

## Process, socket and secrets

The launcher passes only PATH and LANG. The entrypoint rejects additional env
names; synthetic tests alone permit the two isolation markers and macOS's
automatically injected encoding hint. It reads explicit private config/key files,
accepts no inherited app/model/MCP/database credentials, and requires canonical
absolute files with 0600 permissions. Only Ed25519 keys are accepted.

The socket must have a canonical absolute path, dedicated 0700 parent and 0600
socket. An existing socket is refused, including a stale socket after SIGKILL;
an operator must establish ownership and remove it before restart. There is no
TCP listener. Signatures provide integrity, not encryption; the local mount and
OS identity boundary must protect credential bytes. Do not expose the socket
through a proxy or share its writable parent with untrusted processes.

The Linux production entrypoint is `PRODUCTION_OFFLINE` only: it requires loopback-only enabled interfaces/routes and zero inheritable/permitted/effective/bounding/ambient capabilities plus NoNewPrivs=1,
pins binary/schema, and the runner still requires private tmpfs
workspaces. The recorded container probe additionally uses Docker network=none,
read-only root, nonroot 10001, no capabilities and a bounded noexec tmpfs. A policy
reference does not enable outbound access. A separate enforced egress design,
dedicated secret mounts, TLS/mTLS if remote transport is added, authorization
device flow and production acceptance remain unfinished. No online service is
started as part of delivery.

## Execution and evidence

Use the repository's guarded test toolchain, not `.env`:

```sh
node scripts/run-tests.mjs vitest run tests/integration/dws-signed-service.test.ts --maxWorkers=2
node scripts/run-tests.mjs vitest run --coverage --maxWorkers=2
pnpm typecheck
pnpm lint
pnpm build
```

Build from the release context produced by `scripts/prepare-dws-release.mjs`.
The local candidate reuses the exact locked binary/license/provenance from the
previous verified P06 image in a temporary context; Dockerfile checks all hashes.

```sh
docker build --build-context dws_release=/absolute/prepared/linux-arm64 -f deploy/images/dws-runner.Dockerfile -t open-aider:p06-signed-runner .
docker run --rm --network none --read-only --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 64 --memory 512m --tmpfs /run/dws:rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=10001,gid=10001 --entrypoint node open-aider:p06-signed-runner scripts/probe-dws-signed-offline.mjs
```

The probe generates ephemeral keys in tmpfs, starts the actual compiled service,
verifies a signed challenge, rejects an invalid credential state and its replay,
and checks the binary hash. It performs no business CLI operation, device login
or enterprise API request. The independent process tests use a synthetic CLI and
synthetic credential bundles; these are not enterprise success evidence.

No new SQL migration is required: the transport persists no credential or task
records and uses instance-scoped nonce memory. Existing migrations 001–065 are
unchanged; P06 identity storage still uses 033/034. No database is connected by
the standalone service. Migration/deployment acceptance is still a separate
requirement. Executed commands, exact source hashes, failures, coverage and image
proof are retained in `reports/p06-signed-runner-candidate.json` and its records.

Node crypto signing and Unix socket HTTP implementation follow the official
[Node 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html) and
[HTTP request](https://nodejs.org/docs/latest-v24.x/api/http.html) contracts.
The engineering runtime stays locked to Node 24.21.0.

## Configured private document read

`SIGNED_DOCUMENT_READ_V1` is the document-only application reader configuration. It shares the reviewed schemaVersion/executionMode/reviewReference/socket/key-file/bindingHash/policyHash/deadline/byte-limit fields with the group reader, replaces group digests with `documentSchemaHash`, and requires 1–32 `documentPolicies`. Each policy fixes scope ID/version, exact owner-private principal (tenant/owner/identity/auth epoch/authorization version/capability/audience/corp/user), node ID, normalized selector, independently reviewed payload mapping, binary/schema digests and an absolute validity window. It contains no taskId/runId: a real native DM can create its random task/run after this stable provider binding has already been approved by the exact formal profile. Configuration/key files are bounded private regular files belonging to the current UID; symlinks and foreign/group/world access are rejected. This mode exposes no contact, enrollment, group-body, write, URL, title or arbitrary command operation.

The standalone runner accepts the optional pair `documentSchemaHash` + `documentPolicies`; partial or mixed policy/scope configuration is invalid. The earlier fixed-run `documentScopes` shape is retained only for isolated SYNTHETIC_TEST compatibility and is rejected in production. Its mode remains `SYNTHETIC_TEST` or Linux UID10001 `PRODUCTION_OFFLINE`, with the existing actual offline-network and exact binary/metadata checks. This change does not activate live platform access, device authorization or any real enterprise profile. A reviewed result mapping is still mandatory because the pinned CLI has no published upstream document payload schema.

The actual signed `READ_DOCUMENT` request binds the complete delegation and target digest. The service snapshots reviewed principal/resource policies. For each authenticated caller request it verifies exact principal/node/selector/profile/hash/time, reconstructs the full scope with the request’s actual taskId/runId, compares its complete target digest and signed delegation, rejects replays, calls the existing constrained `DwsRunner.readDocument`, then verifies the signed projection and current pinned binding again before returning. Legacy and group-only service binding hashes are preserved when both documentScopes and documentPolicies are absent. Results carry `grantsAuthority:false`.

`configureDws` constructs this real signed reader; the gateway and identity service independently check current task/run/fence/lease/goal/budget/lifecycle, active owner identity and authorization version, reviewed node scope/version/profile/expiry, private resource grant/classification and current capability binding before and after the socket read. The authority checks are database reads under the existing owner/RLS boundary. A changed scope/grant rejects returned content before credential persistence at that barrier; the capability also re-reads and compares its encrypted source proof before retaining a fact. Scope/signature validity alone never grants access or publishing rights. No new SQL migration is required: existing identity, document scope and lifecycle tables are reused. No target database, real credential, budget, trial or formal authorization is installed by these configuration or code changes.

Signed document reads require the actual guarded PostgreSQL client to flow through both initial execution and current-source verification into identity/credential reads. Lifecycle admission, scope/grant/identity checks and credential persistence run in that same transaction; no nested connection re-acquires the caller's formal lifecycle locks. The standalone identity API rejects signed document reads without this guarded-client context. Lifecycle checks and existing lock/deadline limits remain mandatory. This is transaction propagation, not removal of a formal admission check.

The stable reviewed policy is not a task authorization. Runtime task/run IDs enter the request only through the actual Gateway lease and current database checks, never through model arguments. Each full request target and response delegation digest still binds those exact dynamic IDs. The runner authenticates the signing caller and independently confines it to the reviewed principal, resource, selector, mapping, version, hashes and expiry; the caller remains responsible for current run/lease/lifecycle checks in the guarded transaction. A changed static principal/resource policy changes the provider binding and requires approval again; a new native task/run alone does not change it.

For FORMAL runtime monitoring, the existing 100 ms watcher and 1000 ms authority query limit remain active. Its initial authorization and every dispatch still call the original locking schema69 functions. Periodic FORMAL observation reads the same committed owner/profile/state/validity/trial-tombstone/identity/per-run-admission predicates through a bounded MVCC SELECT using the runtime role’s existing SELECT grants. It obtains no lifecycle row locks, so a lawful bounded document read cannot cause its own monitor to time out. Missing, ambiguous, unavailable or denied observations still stop the runtime; TRIAL monitoring and the independent monotonic deadline are unchanged. This observer is private to monitoring and grants no dispatch admission. No schema69 SQL, credential, role or timeout is changed. Revocation becomes authoritative at its actual commit; every document pre/post guard remains mandatory.
