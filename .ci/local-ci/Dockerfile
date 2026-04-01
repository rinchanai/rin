FROM node:22-bookworm-slim

WORKDIR /opt/rin

COPY package.json package-lock.json ./
COPY third_party/pi-coding-agent ./third_party/pi-coding-agent

RUN npm ci

COPY .ci/local-ci/run-checks.sh /usr/local/bin/rin-local-ci-runner
RUN chmod +x /usr/local/bin/rin-local-ci-runner

ENTRYPOINT ["/usr/local/bin/rin-local-ci-runner"]
