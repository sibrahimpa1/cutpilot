# syntax=docker/dockerfile:1.7

# ---- whisper.cpp (local speech-to-text) ------------------------------------
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG WHISPER_CPP_REF=v1.9.5
RUN git clone --depth 1 --branch ${WHISPER_CPP_REF} https://github.com/ggml-org/whisper.cpp /src \
  && cmake -S /src -B /src/build -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=OFF \
  && cmake --build /src/build --config Release -j --target whisper-cli \
  && cp /src/build/bin/whisper-cli /usr/local/bin/whisper-cli

# ---- app ---------------------------------------------------------------------
FROM node:22-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg espeak-ng fonts-liberation fontconfig ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/mcp/package.json apps/mcp/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @cutpilot/web build

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    CAPTION_FONT="Liberation Sans" \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 3210
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["pnpm", "--filter", "@cutpilot/web", "start"]
