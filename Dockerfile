# syntax = docker/dockerfile:1
FROM node:20-bullseye-slim

# System deps for Chromium/Puppeteer & fonts for QR rendering
RUN apt-get update && apt-get install -y \
  chromium \
  ffmpeg \
  libnss3 libxss1 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
  libx11-6 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
  libgbm1 libxshmfence1 libpangocairo-1.0-0 libpango-1.0-0 \
  libcairo2 libgtk-3-0 fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# App
WORKDIR /opt/app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Render will inject a persistent disk at /data (see render.yaml below)
ENV DATA_DIR=/data \
    WWEB_AUTH_DIR=/data/.wweb-auth

# Start the worker
CMD ["node","index.js"]
