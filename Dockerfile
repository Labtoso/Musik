FROM rust:1-bookworm AS build
WORKDIR /src
COPY web web
COPY server server
RUN cd server && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/server/target/release/musik-server /usr/local/bin/musik-server
ENV PORT=8484 DATA_DIR=/data MUSIC_DIRS=/music
VOLUME ["/data", "/music"]
EXPOSE 8484
CMD ["musik-server"]
