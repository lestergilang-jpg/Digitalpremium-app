FROM node:24-alpine AS builder

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY apps/api apps/api
COPY packages packages

RUN pnpm install --filter @volvecapital/api... --frozen-lockfile
RUN pnpm --filter @volvecapital/api build:bundle

FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --chown=node:node --from=builder /app/apps/api/dist_bundle ./dist_bundle
COPY --chown=node:node --from=builder /app/apps/api/dist_migrations ./migrations
RUN npm install typescript pg pg-hstore && mkdir -p /app/dist_bundle/logs

USER node

EXPOSE 3000

CMD ["node", "dist_bundle/index.js"]
