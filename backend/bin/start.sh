#!/bin/sh
#
# Container entrypoint: migrate, then serve.
#
# A script rather than a `dockerCommand: sh -c "..."` in render.yaml, because a
# multi-command string in a hosting dashboard is quoted by whatever that host
# does with it, and when it goes wrong the only symptom is "exited with status
# 127" — command not found — with nothing to say which command.
#
# Here the sequence is in the image, it is the same locally and in production,
# and each step announces itself so a failing deploy log says where it stopped.

set -e

echo "→ applying database migrations"
node db/migrate.js

echo "→ starting the API"
exec node src/server.js
