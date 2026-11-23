FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY VERSION VERSION
COPY tools/protect tools/protect
RUN npm ci --prefix tools/protect --no-audit --no-fund
COPY web web
RUN node tools/protect/protect.mjs web

FROM rust:1-bookworm AS build
WORKDIR /src
COPY --from=web /src/web web
COPY server server
COPY VERSION VERSION
COPY LICENSE LICENSE
RUN cd server && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/server/target/release/streyn-server /usr/local/bin/streyn-server
ENV STREYN_DOCKER=1 PUBLIC_HOST=0.0.0.0 PORT=8484 DATA_DIR=/data MUSIC_DIRS=/music
VOLUME ["/data", "/music"]
EXPOSE 8484 8485
CMD ["streyn-server"]
