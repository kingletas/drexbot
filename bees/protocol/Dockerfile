# The protocol bee: k6 running bees/protocol/bee.js. socat is added for the
# entrypoint's relays; nothing else changes the upstream image. Build from the
# repository root:
#
#   docker build -f bees/protocol/Dockerfile -t drexbot-bee-protocol .
FROM grafana/k6:2.3.0

USER root
RUN apk add --no-cache socat
COPY bees/protocol/bee.js /bee/bee.js
COPY bees/entrypoint.sh /usr/local/bin/bee-entrypoint
USER k6

ENTRYPOINT ["bee-entrypoint", "k6", "run", "--quiet", "/bee/bee.js"]
