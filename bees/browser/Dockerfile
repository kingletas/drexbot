# The browser bee: drexbot's compiled bee on Playwright's own image, which
# carries a Chromium that matches the library. PLAYWRIGHT_VERSION has to be the
# version in package-lock.json, or the library looks for a browser build the
# image does not have. Build from the repository root after `make build`:
#
#   docker build -f bees/browser/Dockerfile -t drexbot-bee-browser .
ARG PLAYWRIGHT_VERSION=1.62.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION

RUN apt-get update \
	&& apt-get install -y --no-install-recommends socat \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /bee
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production
RUN npm init -y >/dev/null \
	&& npm pkg set type=module \
	&& npm install --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}"

COPY dist/src/bee/ ./
COPY bees/entrypoint.sh /usr/local/bin/bee-entrypoint

USER pwuser
ENTRYPOINT ["bee-entrypoint", "node", "/bee/browser.js"]
