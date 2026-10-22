# Standalone analysis sandbox broker. It is the only process that mounts the
# host Docker socket, and it never carries DingTalk, GLM, DWS or company MCP
# credentials. The API/worker reach it over the internal network with an
# HMAC-signed service request.
#
# The docker CLI is copied from a digest-pinned official image so the broker can
# launch one networkless container per signed job. The analysis runtime image is
# built separately (deploy/images/analysis-sandbox.Dockerfile) and pinned by
# digest in config.json.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.7
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS docker-cli

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
RUN groupadd --gid 10001 anthys && useradd --uid 10001 --gid 10001 --no-create-home anthys
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/config ./config
USER 10001:10001
ENV HOST=0.0.0.0
EXPOSE 8092
# The config path is an argument because it is mounted from outside the image.
CMD ["node","dist/apps/sandbox-broker/src/main.js","/run/secrets/sandbox_broker_config"]
