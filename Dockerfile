FROM oven/bun:1.4.3-debian AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS frontend
COPY web ./web
COPY shared ./shared
RUN bun run build:web

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-dejavu-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/picloom/app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src ./src
COPY shared ./shared
COPY plugin-sdk ./plugin-sdk
COPY docker/healthcheck.ts ./docker/healthcheck.ts
COPY --from=frontend /app/dist/web ./dist/web
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/var/lib/picloom/app
USER root
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["bun", "docker/healthcheck.ts"]
CMD ["bun", "src/main.ts"]
