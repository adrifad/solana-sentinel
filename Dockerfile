FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY config ./config
COPY tsconfig.json eslint.config.js ./
RUN pnpm install --frozen-lockfile
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV APP_MODE=DRY_RUN DB_PATH=/app/data/sentinel.db
CMD ["pnpm", "dev:worker"]
