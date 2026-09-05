# Runs the Spicy Lyrics proxy outside Cloudflare Workers.
#
# Easiest path is docker-compose.yml next to this file (it sets the build
# context, the volume and the host-gateway alias for you):
#
#   cd web/server && cp .env.example .env && $EDITOR .env && docker compose up -d
#
# By hand, from the REPO ROOT (the build context must be the repo, not this
# directory — the COPY paths below are repo-relative):
#
#   docker build -f web/server/Dockerfile -t spicy-lyrics-proxy .
#   docker run -d --name spicy-lyrics-proxy -p 8787:8787 \
#     -e SP_DC=<your sp_dc cookie> -v spicy-proxy-state:/state \
#     --restart unless-stopped spicy-lyrics-proxy
#
# To send the proxy's own outbound traffic through a SOCKS5/CONNECT proxy, add
#   -e PROXY_URL=socks5://host.docker.internal:1080 \
#   --add-host=host.docker.internal:host-gateway
# (inside a container 127.0.0.1 is the container itself, not your host).
#
# No dependencies to install: the proxy uses only Node's built-ins.
FROM node:22-alpine

WORKDIR /app
COPY web/proxy/worker.js web/proxy/package.json ./web/proxy/
COPY web/server/server.mjs web/server/outbound.mjs web/server/package.json ./web/server/

ENV STATE_DIR=/state \
    PORT=8787 \
    NODE_ENV=production
RUN mkdir -p /state && chown -R node:node /state /app
USER node
VOLUME ["/state"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/__spicy/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "web/server/server.mjs"]
