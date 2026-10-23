FROM oven/bun:1.4.4-slim AS base
WORKDIR /app

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS frontend
COPY web ./web
COPY themes/default ./themes/default
COPY shared ./shared
RUN bun run build:web

FROM base AS production-dependencies
COPY package.json bun.lock ./
# The glibc runtime needs neither musl binaries nor TypeScript declarations.
RUN bun install --frozen-lockfile --production \
    && rm -rf node_modules/@img/*linuxmusl* node_modules/@types node_modules/bun-types node_modules/undici-types

FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-dejavu-core libjemalloc2 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/picloom/app
# One Simplified Chinese weight, pinned with its redistribution license.
ADD --checksum=sha256:faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9 --chmod=644 https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf /usr/local/share/fonts/NotoSansSC-Regular.otf
ADD --checksum=sha256:6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2 --chmod=644 https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE /usr/share/doc/noto-sans-sc/LICENSE
RUN fc-cache -f
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src ./src
COPY shared ./shared
COPY docker/healthcheck.ts ./docker/healthcheck.ts
COPY --from=frontend /app/dist/web ./dist/web
ENV LD_PRELOAD=libjemalloc.so.2 VIPS_CONCURRENCY=1
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/var/lib/picloom/app
USER root
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["bun", "docker/healthcheck.ts"]
CMD ["bun", "src/main.ts"]
