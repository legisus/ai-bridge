FROM node:22-bookworm-slim
# ca-certificates: outbound TLS to the model APIs. git: Claude Code wants it for
# its own bookkeeping; the agent itself never touches a repo.
# Pin the two CLIs: their sandbox and auth behaviour changes between releases.
# procps: the channels daemon's crash recovery calls `ps` to inspect a recorded pid.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@2.1.317 @openai/codex@0.171.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
# State and work dirs owned by the unprivileged image user *before* USER switches.
# A fresh named volume copies the image's ownership of /data; a bind mount does not
# (see compose.yml for ./work).
RUN mkdir -p /data /work && chown 1000:1000 /data /work && chmod 700 /data
USER node
ENV AI_BRIDGE_HOME=/data \
    BRIDGE_BIND=0.0.0.0 \
    BRIDGE_PORT=8765 \
    AI_BRIDGE_DEBUGGER=1 \
    AI_BRIDGE_CODEX_SANDBOX=container
WORKDIR /work
EXPOSE 8765
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
  CMD node -e "require('net').connect(8765,'127.0.0.1').once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))"
CMD ["node", "/app/server/server.js"]
