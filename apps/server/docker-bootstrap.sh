#!/bin/sh
set -eu

# Environment variables from docker-compose.yaml must be passed to subprocesses.
# Run migrations
DATABASE_URL="${DATABASE_URL}" npx prisma migrate deploy
# start app
exec env DATABASE_URL="${DATABASE_URL}" node dist/main
