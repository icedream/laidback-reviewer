FROM node:24-slim

# Pinned so the bot runs the gates the way CI runs them. Update deliberately, not by drift. This is a
# floor, not a promise: repositories pin their own golangci-lint, and the harness installs a pinned
# release that differs from this one into the writable tools dir at run time.
ARG GO_VERSION=1.26.10
ARG GOLANGCI_LINT_VERSION=v2.15.0
ARG GH_VERSION=2.66.1
ARG GH_STACK_VERSION=v0.2.1

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

RUN curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION#v}-linux-amd64.tar.gz" \
    | tar -xz -C /tmp \
 && mv "/tmp/golangci-lint-${GOLANGCI_LINT_VERSION#v}-linux-amd64/golangci-lint" /usr/local/bin/golangci-lint \
 && chmod 755 /usr/local/bin/golangci-lint \
 && rm -rf "/tmp/golangci-lint-${GOLANGCI_LINT_VERSION#v}-linux-amd64" \
 && golangci-lint --version

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

# gh-stack as a binary extension. `gh extension install` needs a GitHub token, and building from source
# wants a Go newer than the toolchain pinned above. An extension is a directory holding an executable,
# so the prebuilt release asset is placed there directly.
RUN mkdir -p /home/node/.local/share/gh/extensions/gh-stack \
 && curl -fsSL "https://github.com/github/gh-stack/releases/download/${GH_STACK_VERSION}/linux-amd64" \
      -o /home/node/.local/share/gh/extensions/gh-stack/gh-stack \
 && chmod 755 /home/node/.local/share/gh/extensions/gh-stack/gh-stack \
 && gh stack --help >/dev/null

ENV LAIDBACK_CONFIG=/app/config.yaml \
    LAIDBACK_STATE_DB=/data/state.db \
    LAIDBACK_ARTIFACT_DIR=/data/reviews \
    PI_CODING_AGENT_DIR=/app/.pi/agent \
    GOMODCACHE=/data/go/pkg/mod \
    GOCACHE=/data/go/build \
    # A repository that declares a newer Go than this floor gets its own toolchain, fetched into the
    # module cache rather than failing the gate.
    GOTOOLCHAIN=auto \
    GOLANGCI_LINT_CACHE=/data/golangci-lint

HEALTHCHECK --interval=120s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "console.log('alive')"

CMD ["node", "src/index.mjs"]
