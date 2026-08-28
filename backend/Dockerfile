# syntax=docker/dockerfile:1

# One image, two processes. The API and the worker share every line of code —
# the worker imports the same services the API does — so shipping two images
# would guarantee they eventually drift apart. Which one runs is a command, not
# a build.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci --omit=dev` installs exactly the lockfile and nothing else. It fails
# if package.json and the lock have diverged, which is the entire point of
# committing a lockfile.
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# OCR for scanned and photographed bills. tesseract reads the pixels; poppler
# rasterises a scanned PDF into pages for it to read.
#
# Two apt packages rather than tesseract.js, which is a WASM build of this same
# engine that downloads a language model at runtime — a container that fetches
# 15MB on its first upload is one that fails on its first upload behind a
# firewall.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils \
  && rm -rf /var/lib/apt/lists/*

# Runs as the non-root `node` user that the base image already provides. A
# process holding client financial documents has no business being root.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node db ./db
COPY --chown=node:node bin ./bin

# Create the storage directory in the IMAGE, owned by node.
#
# Docker seeds a fresh named volume from whatever is at the mount point in the
# image, ownership included. Without this the volume is created owned by root,
# the container runs as node, and every upload fails with EACCES on mkdir —
# after the API has already started and reported itself healthy.
RUN mkdir -p /data/uploads && chown -R node:node /data
VOLUME /data/uploads

USER node
EXPOSE 4000

# The health endpoint checks the database too, so an instance that has lost its
# connection is taken out of rotation rather than left accepting requests it
# cannot serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run before the API serves a request, so a release that adds a
# column cannot start serving before the column exists.
CMD ["./bin/start.sh"]
