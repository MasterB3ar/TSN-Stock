# TSN Stock Standalone — dependency-free Render fix

This is the standalone TSN Stock website. It reads activity data from your original TSN website.

This version has been rebuilt to fix Render builds getting stuck at `npm install` / npm audit.
It uses **zero npm dependencies**. The server uses only Node.js built-in modules.

## Original TSN requirement

Your original TSN website must have this endpoint:

```txt
/api/public/stock
```

Example:

```txt
https://your-normal-tsn.onrender.com/api/public/stock
```

## Render setup

Use these settings for the TSN Stock Render service:

```txt
Build Command: npm run build
Start Command: npm start
```

Environment variables:

```txt
TSN_API_BASE_URL=https://your-normal-tsn.onrender.com
NODE_ENV=production
NODE_VERSION=22.16.0
NPM_CONFIG_AUDIT=false
NPM_CONFIG_FUND=false
```

Important: `TSN_API_BASE_URL` must point to the normal/original TSN website, not the TSN Stock website.

## If Render still runs `npm install`

Go to Render → your TSN Stock service → Settings and manually change the Build Command to:

```bash
npm run build
```

Then click:

```txt
Manual Deploy → Clear build cache & deploy
```

## Local setup

```bash
npm start
```

Open:

```txt
http://localhost:3010
```

## What affects the price?

TSN Stock is fictional. The price changes based on:

- online users
- private messages + global comments per hour
- global posts per hour
- expected activity for the current time of day

It is not a real stock and is not financial advice.
