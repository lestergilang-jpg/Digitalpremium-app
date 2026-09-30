FROM node:24-alpine AS builder

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/socket/package.json apps/socket/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY apps/socket apps/socket
COPY packages packages

RUN pnpm install --filter @volvecapital/socket... --frozen-lockfile
RUN pnpm --filter @volvecapital/socket build:bundle

FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --chown=node:node --from=builder /app/apps/socket/dist_bundle ./dist_bundle

RUN npm install typescript && mkdir -p /app/dist_bundle/logs

USER node

EXPOSE 3000

CMD ["node", "dist_bundle/index.js"]
