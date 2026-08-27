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

# Runs as the non-root `node` user that the base image already provides. A
# process holding client financial documents has no business being root.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node db ./db

USER node
EXPOSE 4000

# The health endpoint checks the database too, so an instance that has lost its
# connection is taken out of rotation rather than left accepting requests it
# cannot serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
