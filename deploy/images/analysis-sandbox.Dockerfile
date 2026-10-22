# Offline analysis sandbox runtime launched per job by the standalone broker
# (apps/sandbox-broker, Compose profile "sandbox"). The broker pins this image by
# digest; deploy/setup-sandbox-broker.mjs builds and records that digest.
#
# Run per job with all of the following (see deploy/compose/compose.dev.yml and
# deploy/compose/compose.prod.yml comments for the exact stanza):
#   --network none
#   --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m
#   --user 10001:10001
#   --cap-drop ALL
#   --security-opt no-new-privileges=true
#   --security-opt seccomp=deploy/policies/seccomp.json
#   --pids-limit 256 --memory 512m --cpus 1.0
#   -v <job-input>:/sandbox/input:ro -v <job-output>:/sandbox/output:rw
#
# The image intentionally has no curl/wget/nc/ssh/git (bookworm-slim ships none)
# and removes npm/npx/corepack so a job cannot install new network tooling.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN groupadd --gid 10001 sandbox \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && install -d -o 10001 -g 10001 -m 0700 /sandbox /sandbox/input /sandbox/output /tmp/anthys-sandbox

WORKDIR /sandbox
ENV HOME=/tmp \
    NODE_OPTIONS=--max-old-space-size=512 \
    NODE_NO_WARNINGS=1
USER 10001:10001

LABEL org.opencontainers.image.title="anthys-analysis-sandbox" \
      org.opencontainers.image.description="Networkless, non-root Node 24 analysis sandbox" \
      org.anthys.policy.seccomp="deploy/policies/seccomp.json" \
      org.anthys.policy.egress="deploy/policies/egress-allowlist.json"

# The broker passes an absolute script path; there is no long-lived listener.
ENTRYPOINT ["node"]
CMD ["--version"]
