FROM alpine:latest

RUN apk upgrade --no-cache \
    && apk add --no-cache python3 nodejs npm git bash curl jq \
    && apk add --no-cache --virtual .pty-build make g++ nodejs-dev

WORKDIR /usr/local/lib/wingman
COPY package.json package-lock.json ./
RUN npm_config_nodedir=/usr npm_config_build_from_source=true npm ci --omit=dev --workspaces=false \
    && npm cache clean --force \
    && apk del .pty-build
COPY pty-supervisor.cjs ./

USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["/bin/sleep", "infinity"]
