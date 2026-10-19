
FROM oven/bun:1

WORKDIR /app

ENV NODE_ENV=production \
    PORT=20129 \
    HOST=0.0.0.0 \
    OPENCODE_CACHE_DIR=/data/cache \
    # Egress proxy pool (comma-separated http/https proxy URLs). Empty means
    # direct egress; see README § Proxy pool and proxy-pool.js.
    PROXY_POOLS=""

COPY --chown=bun:bun . .

RUN mkdir -p /data/cache \
    && chown -R bun:bun /data

USER bun

EXPOSE 20129

CMD ["bun", "server.js"]
