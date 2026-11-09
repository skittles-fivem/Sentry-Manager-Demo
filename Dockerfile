# Sentry Six Manager demo: the real app from the published image, in demo
# mode (no sign-in, nothing can be changed), with highway-only demo drives.
#
#   docker build -t ghcr.io/skittles-fivem/manager-demo:latest .

ARG MANAGER_IMAGE=ghcr.io/skittles-fivem/sentry-manager
ARG MANAGER_TAG=latest
FROM ${MANAGER_IMAGE}:${MANAGER_TAG}

COPY demo /demo
# the demo's drives and CAN data (made with tools/sanitize; see README)
COPY seed /demo/seed

# Runs as a normal user with no capabilities: the demo uses folders, never
# SMB shares, so it needs nothing the supervisor keeps root for.
RUN mkdir -p /data /footage \
 && chown 1000:1000 /data /footage \
 && chmod -R a+rX /demo

ENV NODE_OPTIONS=--require=/demo/preload.js \
    DEMO_SEED=/demo/seed \
    DEMO_RESET_HOURS=24 \
    DEMO_EXPORT_QUEUE=2 \
    FOOTAGE_ROOT=/footage \
    DATA_PATH=/data

USER 1000:1000
