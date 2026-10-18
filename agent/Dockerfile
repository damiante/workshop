# Workshop agent image: Claude Code plus common build toolchains (Node 24, Python 3, C toolchain)
# and Playwright with headless Chromium for screenshots and browser tests.
# A repository that needs other toolchains can use its own image built FROM this one
# (set it on the repository in Workshop's Connections page). Such images keep the
# workshop.capabilities label below, which Workshop reads and reports to the agent.
FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git jq ca-certificates curl openssh-client procps ripgrep \
      python3 python3-venv python3-pip build-essential \
 && rm -rf /var/lib/apt/lists/*

# Claude Code refuses to skip permission prompts as root, so agents run as an unprivileged user.
# /work is the run's volume; a new volume copies this directory's ownership.
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node \
 && mkdir -p /work && chown agent:agent /work

# Headless Chromium for screenshots and browser tests. Browsers live outside $HOME at a fixed path,
# owned by agent, so a repository pinned to another Playwright version can install its own build there.
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g playwright@${PLAYWRIGHT_VERSION} \
 && playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && chown -R agent:agent /opt/ms-playwright

USER agent

# Pinned so behaviour (flags, stream-json fields Workshop reads) only changes when this file does.
ARG CLAUDE_CODE_VERSION=2.1.296
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
 && /home/agent/.local/bin/claude --version

COPY --chmod=755 entrypoint.sh /usr/local/bin/workshop-agent

WORKDIR /work
ENV PATH=/home/agent/.local/bin:$PATH \
    CLAUDE_CONFIG_DIR=/work/.claude \
    DISABLE_AUTOUPDATER=1 \
    NODE_PATH=/usr/local/lib/node_modules
LABEL workshop.capabilities="browser"
ENTRYPOINT ["workshop-agent"]
