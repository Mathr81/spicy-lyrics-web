# The Spicy Lyrics proxy. Nothing to install: it uses only Node's built-ins, so
# the image is the base image plus three source files.
#
# Build context is this directory (web/server), not the repo root — the proxy
# shares no code with the extension, and a small context keeps builds instant.
#
#   cd web/server && docker compose up -d
#
# Or without compose:
#   docker build -t spicy-lyrics-proxy web/server
#   docker run -d --name spicy-lyrics-proxy -p 127.0.0.1:8787:8787 \
#     -e SP_DC=<your sp_dc cookie> -v spicy-proxy-state:/state \
#     --restart unless-stopped spicy-lyrics-proxy
FROM node:22-alpine

WORKDIR /app
COPY package.json proxy.mjs server.mjs outbound.mjs ./

ENV STATE_DIR=/state \
    PORT=8787 \
    NODE_ENV=production
RUN mkdir -p /state && chown node:node /state
USER node
VOLUME ["/state"]
EXPOSE 8787

# `/__spicy/stats` answers from local state only, so this stays honest when the
# upstream API is down: it reports the proxy's health, not the API's.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/__spicy/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
