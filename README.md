# TSN Stock Standalone — MongoDB URI persistent history

This is the standalone TSN Stock website. It reads activity metrics from your original TSN website, calculates the TSN Stock price inside the standalone TSN Stock service with a more bullish activity model, and saves price snapshots in MongoDB, so the graph history does **not** reset after Render restarts/redeploys.

This version uses the normal MongoDB Atlas connection string:

```txt
MONGODB_URI=mongodb+srv://...
```

## What is included

- Saves TSN Stock price snapshots whenever metrics change, checked about every 2 seconds.
- Calculates the next price from the last MongoDB snapshot, so the number moves when TSN activity changes.
- Uses a bullish activity model: active users, messages, and posts push the price up much more strongly, while quiet-period drops are much smaller.
- Loads old price history after restart/redeploy.
- Keeps the Nordnet-style hover chart.
- Uses the official `mongodb` Node package.
- Falls back to temporary in-memory history if `MONGODB_URI` is not configured.
- Keeps `/healthz` for uptime checks.

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
Build Command: npm install --omit=dev --no-audit --no-fund
Start Command: npm start
```

Required environment variables:

```txt
TSN_API_BASE_URL=https://your-normal-tsn.onrender.com
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/tsn_stock?retryWrites=true&w=majority
NODE_ENV=production
NODE_VERSION=22.16.0
NPM_CONFIG_AUDIT=false
NPM_CONFIG_FUND=false
```

Optional:

```txt
MONGODB_DATABASE=tsn_stock
MONGODB_COLLECTION=stockSnapshots
TSN_STOCK_REFRESH_MS=2000
TSN_STOCK_MAX_HISTORY=720
```

`TSN_STOCK_MAX_HISTORY=720` means about 24 minutes of 2-second snapshots if activity constantly changes. Increase it if you want a longer chart, for example `TSN_STOCK_MAX_HISTORY=10800` for about 6 hours.

## Where to find `MONGODB_URI`

1. Go to MongoDB Atlas.
2. Open your project.
3. Go to **Database**.
4. Click **Connect** on your cluster.
5. Choose **Drivers**.
6. Copy the connection string.
7. Replace `<password>` with your database user's password.
8. Make sure the database name is included before the `?`, for example `/tsn_stock?retryWrites=true...`.

Example:

```txt
mongodb+srv://tsnuser:YOUR_PASSWORD@cluster0.xxxxx.mongodb.net/tsn_stock?retryWrites=true&w=majority
```

## Important MongoDB Atlas settings

In Atlas, also check:

- **Database Access**: your database user exists and has read/write permissions.
- **Network Access**: allow Render to connect. For easiest setup, add `0.0.0.0/0` while testing.
- Your password is URL-safe. If it has special characters, create a simpler MongoDB password or URL-encode it.

## Local setup

```bash
npm install --omit=dev --no-audit --no-fund
npm start
```

Open:

```txt
http://localhost:3010
```

## Endpoints

```txt
GET /api/stock
GET /api/history
GET /healthz
```

## What affects the price?

TSN Stock is fictional. The standalone TSN Stock server calculates the price from the previous saved price plus current activity. This version is intentionally more bullish, so active TSN usage pushes the price up clearly. The price changes based on:

- online users
- private messages + global comments per hour
- global posts per hour
- expected activity for the current time of day

It is not a real stock and is not financial advice.


## If the number does not move

Use this fixed version. The old MongoDB URI version could save history but still trusted the original TSN API price too much. This version calculates the price inside TSN Stock from:

- latest saved MongoDB price
- online users
- messages per hour
- posts per hour
- time-of-day expected activity

You can force a new snapshot by opening:

```txt
/api/stock?force=1
```
