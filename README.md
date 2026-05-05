# TSN Stock Standalone — persistent MongoDB history

This is the standalone TSN Stock website. It reads activity data from your original TSN website and now saves TSN Stock price snapshots so the graph history does **not** reset after Render restarts/redeploys.

This version still uses **zero npm dependencies**. MongoDB persistence is done through the **MongoDB Atlas Data API**, so Render does not need to install the MongoDB npm driver.

## What is new

- Saves a TSN Stock price snapshot roughly every 20 seconds.
- Loads old price history after restart/redeploy.
- Keeps the Nordnet-style hover chart.
- Falls back to temporary in-memory history if MongoDB Data API is not configured.
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
Build Command: npm run build
Start Command: npm start
```

Required environment variables:

```txt
TSN_API_BASE_URL=https://your-normal-tsn.onrender.com
NODE_ENV=production
NODE_VERSION=22.16.0
NPM_CONFIG_AUDIT=false
NPM_CONFIG_FUND=false
```

Required for permanent MongoDB history:

```txt
MONGODB_DATA_API_URL=https://data.mongodb-api.com/app/YOUR_APP_ID/endpoint/data/v1
MONGODB_DATA_API_KEY=your_data_api_key
MONGODB_DATA_SOURCE=Cluster0
MONGODB_DATABASE=tsn_stock
MONGODB_COLLECTION=stockSnapshots
```

Optional:

```txt
TSN_STOCK_REFRESH_MS=20000
TSN_STOCK_MAX_HISTORY=720
```

`TSN_STOCK_MAX_HISTORY=720` means about 4 hours of 20-second snapshots. Increase it if you want a longer chart.

## How to set up MongoDB Atlas Data API

1. Go to MongoDB Atlas.
2. Open **App Services**.
3. Create or open an App Services app connected to your Atlas cluster.
4. Enable **Data API**.
5. Create an API key.
6. Copy the Data API endpoint URL into `MONGODB_DATA_API_URL`.
7. Put the API key into `MONGODB_DATA_API_KEY`.
8. Set `MONGODB_DATA_SOURCE` to your cluster name, often `Cluster0`.
9. Use `MONGODB_DATABASE=tsn_stock` and `MONGODB_COLLECTION=stockSnapshots`.

## Why it does not use `MONGODB_URI`

This Render-fixed TSN Stock version avoids npm dependencies so Render does not get stuck at `npm install`. A normal `MONGODB_URI` needs the MongoDB Node driver package. The Atlas Data API works over HTTPS using built-in Node `fetch`, so the project stays dependency-free.

## Local setup

```bash
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

TSN Stock is fictional. The price changes based on:

- online users
- private messages + global comments per hour
- global posts per hour
- expected activity for the current time of day

It is not a real stock and is not financial advice.
