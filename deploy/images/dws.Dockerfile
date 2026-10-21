# dws_release must be produced by scripts/prepare-dws-release.mjs for this platform.
# Example: docker build --build-context dws_release=/absolute/prepared/linux-arm64 \
#   -f deploy/images/dws.Dockerfile -t anthys:p06-dws .
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
RUN groupadd --gid 10001 anthys && useradd --uid 10001 --gid 10001 --no-create-home anthys
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/config ./config
COPY --from=build --chown=10001:10001 /app/scripts/probe-dws-offline.mjs ./scripts/probe-dws-offline.mjs
COPY --from=dws_release --chmod=0555 dws /usr/local/bin/dws
COPY --from=dws_release --chmod=0444 LICENSE NOTICE prepared.json /usr/local/share/dws/
RUN node --input-type=module -e "import fs from 'node:fs';import crypto from 'node:crypto';const lock=JSON.parse(fs.readFileSync('/app/config/dws/lock.json'));const platform='linux-'+({arm64:'arm64',x64:'amd64'}[process.arch]??'unsupported');const actual=crypto.createHash('sha256').update(fs.readFileSync('/usr/local/bin/dws')).digest('hex');const prepared=JSON.parse(fs.readFileSync('/usr/local/share/dws/prepared.json'));if(actual!==lock.platforms[platform]?.binarySha256||prepared.platform!==platform||prepared.binarySha256!==actual||prepared.version!==lock.version)throw Error('DWS_IMAGE_BINARY_LOCK_MISMATCH');"
USER 10001:10001
ENV HOST=0.0.0.0
EXPOSE 64700
CMD ["node","dist/apps/api/src/main.js"]
