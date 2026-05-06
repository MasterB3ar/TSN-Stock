#!/usr/bin/env bash
set -euo pipefail

echo "TSN-S Render build: forcing public npm registry and ignoring old lockfiles..."
npm config set registry https://registry.npmjs.org/
npm config set package-lock false
npm config set audit false
npm config set fund false
npm config set progress false
npm config set fetch-retries 5
npm config set fetch-retry-mintimeout 20000
npm config set fetch-retry-maxtimeout 120000
npm config set fetch-timeout 300000
npm config delete proxy || true
npm config delete https-proxy || true

rm -f package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml
rm -rf node_modules
npm cache clean --force || true
npm install --omit=dev --no-audit --no-fund --prefer-online --registry=https://registry.npmjs.org/
