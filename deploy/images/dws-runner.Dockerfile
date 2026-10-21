# Prepared v1.0.61 release only; identical provenance checks to dws.Dockerfile.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.7
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
RUN groupadd --gid 10001 aider && useradd --uid 10001 --gid 10001 --no-create-home aider
COPY --from=build --chown=10001:10001 /app/dist/packages ./dist/packages
COPY --from=build --chown=10001:10001 /app/dist/apps/dws-runner ./dist/apps/dws-runner
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/config/dws/lock.json ./config/dws/lock.json
COPY --from=build --chown=10001:10001 /app/scripts/start-dws-runner.mjs /app/scripts/probe-dws-signed-offline.mjs ./scripts/
COPY --from=dws_release --chmod=0555 dws /usr/local/bin/dws
COPY --from=dws_release --chmod=0444 LICENSE NOTICE prepared.json /usr/local/share/dws/
RUN node --input-type=module -e "import fs from 'node:fs';import crypto from 'node:crypto';const lock=JSON.parse(fs.readFileSync('/app/config/dws/lock.json'));const platform='linux-'+({arm64:'arm64',x64:'amd64'}[process.arch]??'unsupported');const actual=crypto.createHash('sha256').update(fs.readFileSync('/usr/local/bin/dws')).digest('hex');const prepared=JSON.parse(fs.readFileSync('/usr/local/share/dws/prepared.json'));if(actual!==lock.platforms[platform]?.binarySha256||prepared.platform!==platform||prepared.binarySha256!==actual||prepared.version!==lock.version)throw Error('DWS_IMAGE_BINARY_LOCK_MISMATCH');"
USER 10001:10001
# Operator must supply a 0600 config/key mount, 0700 socket directory and tmpfs
# workspaces, --network none, read-only root and no other secrets/host mounts.
# This component intentionally has no HTTP listener or application entrypoint.
ENTRYPOINT ["node","scripts/start-dws-runner.mjs"]
