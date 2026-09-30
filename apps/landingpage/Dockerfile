FROM node:24-alpine AS builder

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/landingpage/package.json apps/landingpage/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY apps/landingpage apps/landingpage
COPY packages packages

RUN pnpm install --filter landingpage... --frozen-lockfile
RUN pnpm --filter landingpage build

FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV production

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/landingpage ./apps/landingpage

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

EXPOSE 3000

CMD ["pnpm", "--filter", "landingpage", "start"]
