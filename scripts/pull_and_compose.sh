#!/usr/bin/env bash
set -e

# Navigate to project root directory
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

git pull https://lionellembang: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@github.com/lionellembang/calendar-bm.git
docker compose -f docker/docker-compose.yml down -v
docker compose -f docker/docker-compose.yml up -d --build