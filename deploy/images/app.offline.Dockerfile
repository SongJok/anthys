# Supply --build-context offline_dependencies=<verified extracted local cache>.
# This filesystem context avoids any registry lookup for the dependency image.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY --from=offline_dependencies /node_modules ./node_modules
COPY --from=offline_dependencies /package.json /tmp/offline-dependency-package.json
COPY . .
RUN node -e 'const fs=require("node:fs"),assert=require("node:assert/strict");const expected=require("./package.json"),cached=require("/tmp/offline-dependency-package.json");assert.equal(process.version,"v24.21.0");assert.deepEqual(cached.dependencies,expected.dependencies);assert.deepEqual(cached.devDependencies,expected.devDependencies);assert.deepEqual(fs.readFileSync("pnpm-lock.yaml"),fs.readFileSync("node_modules/.pnpm/lock.yaml"));console.log("Exact offline dependency lock and root versions verified.");'
RUN node scripts/update-schema-contract.mjs --check && node --import tsx scripts/capability-output-contracts.ts --check && node node_modules/typescript/bin/tsc -p tsconfig.build.json && node scripts/copy-runtime-assets.mjs && node node_modules/vite/bin/vite.js build --config apps/web/vite.config.ts
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
RUN groupadd --gid 10001 aider && useradd --uid 10001 --gid 10001 --no-create-home aider
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/package.json ./package.json
COPY --from=build --chown=10001:10001 /app/config ./config
COPY --from=build --chown=10001:10001 /app/db ./db
ARG SOURCE_COMMIT
ARG SOURCE_TREE_HASH
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT org.open-aider.source-tree-hash=$SOURCE_TREE_HASH
USER 10001:10001
ENV HOST=0.0.0.0
EXPOSE 52330
CMD ["node", "dist/apps/api/src/main.js"]
