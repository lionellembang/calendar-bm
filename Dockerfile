# Node 24 — required for the built-in `node:sqlite` module (no native build).
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install JS deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# Install Chromium + matching OS libraries for the Playwright scraper.
RUN npx playwright install --with-deps chromium

# App source (see .dockerignore — secrets and data are NOT baked in).
COPY . .

# Persistent state (schedule-request.json, tokens.json, binus-state.json,
# schedule.db) lives here. .env is provided at runtime (env_file / bind mount).
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "index.js"]
