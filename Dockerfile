FROM node:24-slim

# Pinned so the bot runs the gates the way CI runs them. Update deliberately, not by drift.
ARG GO_VERSION=1.24.6
ARG GOLANGCI_LINT_VERSION=v1.62.2
ARG GH_VERSION=2.66.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client tar xz-utils make ripgrep fd-find \
 && rm -rf /var/lib/apt/lists/*

# gh plus the stack extension pr-review uses to resolve stacked PRs.
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_amd64/bin/gh"

# Go toolchain, and the linter at the version the repository's workflow pins.
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -xz -C /usr/local \
 && ln -s /usr/local/go/bin/go /usr/local/bin/go \
 && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt

RUN curl -fsSL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh \
      | bash -s -- -b /usr/local/bin "${GOLANGCI_LINT_VERSION}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# The image holds no credentials and no configuration: config.yaml, .env, .pi/agent, the skill mount
# and the state directory are bind-mounted at start. See docker-compose.yml.
#
# Deliberately absent: kubectl, helm, docker, terraform, ssh keys. A review bot has nothing to deploy.
RUN mkdir -p /data /work /skills && chown -R node:node /app /data /work

USER node

# Installed as the runtime user so the extension directory is the one the bot reads.
RUN gh extension install github/gh-stack@v0.2.1

ENV LAIDBACK_CONFIG=/app/config.yaml \
    LAIDBACK_STATE_DB=/data/state.db \
    LAIDBACK_ARTIFACT_DIR=/data/reviews \
    PI_CODING_AGENT_DIR=/app/.pi/agent \
    GOMODCACHE=/data/go/pkg/mod \
    GOCACHE=/data/go/build \
    GOLANGCI_LINT_CACHE=/data/golangci-lint

HEALTHCHECK --interval=120s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "console.log('alive')"

CMD ["node", "src/index.mjs"]
