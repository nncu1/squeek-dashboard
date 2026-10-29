# squeek-dash: indexer + dashboard in one small container. Build: docker build -t squeek-dash .
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data
WORKDIR /app

# runtime dependencies only (viem + the prebuilt SVG renderer for linux-x64/arm64)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY index.mjs ./
COPY src ./src
COPY public ./public

# the index, image cache and thumbnails live here; mount a volume so they survive rebuilds
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data
USER node

EXPOSE 8787
# healthy once the first sync is done (that can take a few minutes on a fresh volume)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15m --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "index.mjs"]
