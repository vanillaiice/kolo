# Build from the repository root: docker build -f apps/server/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
# Workspace manifests are needed by npm ci even when their app is not built.
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
RUN npm ci --ignore-scripts
RUN npm run build:packages && npm run build -w @kolo/server

FROM node:24-bookworm-slim AS runtime-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace=@kolo/server --include-workspace-root=false

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=runtime-dependencies --chown=node:node /app /app
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]
