FROM caddy:2.11.6-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY dist/ /usr/share/caddy/

RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
