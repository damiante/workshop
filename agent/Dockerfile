# Workshop agent images: Claude Code plus common build toolchains (Node 24, Python 3, C toolchain).
# Two targets: `base` (the default for every run) and `browser` (base plus Playwright with headless
# Chromium, used for Implementation runs on tickets labelled workshop/needs:browser). With no
# --target Docker builds the last stage, browser, so build the base image with `--target base`.
# A repository that needs other toolchains can use its own image built FROM one of these
# (set it on the repository in Workshop's Connections page). Images built FROM the browser image keep
# its workshop.capabilities label, which Workshop reads and reports to the agent.
FROM node:24-trixie-slim AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git jq ca-certificates curl openssh-client procps ripgrep \
      python3 python3-venv python3-pip build-essential \
 && rm -rf /var/lib/apt/lists/*

# Claude Code refuses to skip permission prompts as root, so agents run as an unprivileged user.
# /work is the run's volume; a new volume copies this directory's ownership.
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node \
 && mkdir -p /work && chown agent:agent /work

USER agent

# Pinned so behaviour (flags, stream-json fields Workshop reads) only changes when this file does.
ARG CLAUDE_CODE_VERSION=2.1.296
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
 && /home/agent/.local/bin/claude --version

COPY --chmod=755 entrypoint.sh /usr/local/bin/workshop-agent

WORKDIR /work
ENV PATH=/home/agent/.local/bin:$PATH \
    CLAUDE_CONFIG_DIR=/work/.claude \
    DISABLE_AUTOUPDATER=1
ENTRYPOINT ["workshop-agent"]

# The browser image: the base image plus Playwright with headless Chromium, for screenshots and
# browser tests. Browsers live outside $HOME at a fixed path, owned by agent. Each Playwright release
# looks for its own Chromium build there, so the recent minors in PLAYWRIGHT_EXTRA_VERSIONS are
# preinstalled too: a repository pinned to one of them finds its browser without downloading it.
FROM base AS browser
USER root
ARG PLAYWRIGHT_VERSION=1.64.1
ARG PLAYWRIGHT_EXTRA_VERSIONS="1.63.0 1.62.1 1.61.1 1.60.0"
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g playwright@${PLAYWRIGHT_VERSION} \
 && playwright install --with-deps --only-shell chromium \
 && for v in ${PLAYWRIGHT_EXTRA_VERSIONS}; do npx --yes playwright@${v} install --only-shell chromium; done \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && chown -R agent:agent /opt/ms-playwright
USER agent
ENV NODE_PATH=/usr/local/lib/node_modules
LABEL workshop.capabilities="browser"
