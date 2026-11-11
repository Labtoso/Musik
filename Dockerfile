FROM node:22-bookworm-slim
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server server
COPY web web
ENV PORT=8484 DATA_DIR=/data MUSIC_DIRS=/music WEB_DIR=/app/web
VOLUME ["/data", "/music"]
EXPOSE 8484
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
