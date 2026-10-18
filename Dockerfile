# ---------------------------------------------------------------------------
# Build stage: install the workspaces and build the client
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY tsconfig.base.json ./
COPY server server
COPY client client
RUN npm run build --workspace client

# ---------------------------------------------------------------------------
# Runtime stage: the server runs its TypeScript directly (Node strips the
# types; no compile step), plus the built client
# ---------------------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force

COPY server/src server/src
COPY --from=build /app/client/dist client/dist

# Set by CI: the app version shown in the UI, and the agent images built from the
# same commit, so the server and the agent containers always speak the same protocol.
ARG APP_VERSION=dev
ARG AGENT_IMAGE=ghcr.io/damiante/workshop-agent:latest
ARG AGENT_BROWSER_IMAGE=ghcr.io/damiante/workshop-agent-browser:latest
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    APP_VERSION=$APP_VERSION \
    WORKSHOP_AGENT_IMAGE=$AGENT_IMAGE \
    WORKSHOP_AGENT_BROWSER_IMAGE=$AGENT_BROWSER_IMAGE

# Database and run logs live in /data: mount a volume there.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
WORKDIR /app/server
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
