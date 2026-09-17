FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json vitest.config.ts eslint.config.mjs ./
COPY src ./src
COPY tests ./tests
RUN pnpm typecheck
RUN pnpm test:run
RUN pnpm build
RUN pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable \
  && addgroup --system ledger \
  && adduser --system --ingroup ledger ledger \
  && mkdir -p /app/data \
  && chown -R ledger:ledger /app
COPY --from=build --chown=ledger:ledger /app/package.json ./package.json
COPY --from=build --chown=ledger:ledger /app/node_modules ./node_modules
COPY --from=build --chown=ledger:ledger /app/dist ./dist
USER ledger
VOLUME ["/app/data"]
CMD ["node", "--enable-source-maps", "dist/src/main.js"]
