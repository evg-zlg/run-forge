FROM node:20-bookworm-slim

WORKDIR /app
RUN useradd --create-home --shell /usr/sbin/nologin runforge
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile || pnpm install
COPY . .
RUN pnpm build
USER runforge
ENTRYPOINT ["node", "/app/dist/src/cli/index.js"]
