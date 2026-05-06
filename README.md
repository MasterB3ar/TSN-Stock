# TSN Stock Standalone — TSNM + MongoDB persistent stock trading

This is the standalone TSN Stock website. It reads activity metrics from your original TSN website, calculates the TSN Stock price inside the standalone TSN Stock service, saves price snapshots in MongoDB, and adds **TSNM (TSN Money)**: a fictional points system where users log in with their original TSN account, earn 10 TSNM per online minute, and can buy/sell fictional TSN Stock.

This version uses the normal MongoDB Atlas connection string:

```txt
MONGODB_URI=mongodb+srv://...
```

## What is included

- Saves TSN Stock price snapshots whenever metrics change, checked about every 2 seconds.
- Calculates the next price from the last MongoDB snapshot, so the number moves when TSN activity changes.
- Uses a 100-base activity model: active users, messages, and posts can push the price up, but the stock has stronger gravity back toward 100 so it does not explode to 500+.
- Loads old price history after restart/redeploy.
- Keeps the Nordnet-style hover chart.
- Uses the official `mongodb` Node package.
- Falls back to temporary in-memory history if `MONGODB_URI` is not configured.
- Keeps `/healthz` for uptime checks.
- Adds a **Reset** button that clears stock history and starts the price from the reset baseline again.
- Adds **original TSN account login/logout** inside TSN-S.
- TSN-S verifies sessions through the original TSN `/api/auth/login` and `/api/me` endpoints.
- Adds **TSNM wallets** persisted in MongoDB and tied to the original TSN user id.
- Users earn **10 TSNM per online minute** while logged in and the TSN Stock page is open.
- Users can buy and sell fictional TSN Stock with TSNM.
- Tracks balance, shares, average buy price, portfolio value, net worth, realized/unrealized profit, and trade history.

## Original TSN requirement

Your original TSN website must have these endpoints:

```txt
/api/public/stock
/api/auth/login
/api/me
```

Example:

```txt
https://your-normal-tsn.onrender.com/api/public/stock
```


### Activity score

This version removes the old activity-score cap. The visible activity score is now shown as activity points, so it can go beyond **3500** when TSN has high usage. The stock price still uses a softened score internally, so a huge activity score does not instantly destroy the around-100 price balance.

Optional settings:

```env
TSN_STOCK_ACTIVITY_POINTS_MULTIPLIER=1000
TSN_STOCK_ACTIVITY_PRICE_SOFT_CAP=8
TSN_STOCK_MESSAGE_EPSILON=0.05
TSN_STOCK_POST_EPSILON=0.05
TSN_STOCK_ACTIVITY_EPSILON=0.01
TSN_STOCK_MAX_PRICE_MOVE_PER_TICK=1.25
TSN_STOCK_DOWNTURN_STRENGTH=1
TSN_STOCK_QUIET_DECAY_PER_TICK=0.08
```


## TSN-S login

TSN-S does not create separate stock accounts anymore. Users log in with their original TSN account.

Flow:

1. User enters normal TSN username/password on TSN-S.
2. TSN-S sends that login to the original TSN server.
3. Original TSN returns the normal TSN token and user id.
4. TSN-S stores the token in the browser and verifies it with `/api/me`.
5. TSNM wallet/trades are stored under the original TSN user id.

Logout only removes the TSN-S browser session. It does not delete the original TSN account.

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
TSN_STOCK_MAX_HISTORY=302400
TSN_STOCK_RESET_KEY=optional-secret-key
TSN_STOCK_RESET_PRICE=100
TSN_STOCK_TARGET_BASE_PRICE=100
TSN_STOCK_AUTO_REBASE=true
TSN_STOCK_AUTO_REBASE_THRESHOLD=1.8
TSNM_EARN_PER_MINUTE=10
TSNM_MAX_REWARD_MINUTES_PER_TICK=30
MONGODB_WALLET_COLLECTION=tsnMoneyWallets
MONGODB_TRADE_COLLECTION=tsnMoneyTrades
```

`TSN_STOCK_MAX_HISTORY=302400` means about 24 minutes of 2-second snapshots if activity constantly changes. Increase it if you want a longer chart, for example `TSN_STOCK_MAX_HISTORY=10800` for about 6 hours.

`TSN_STOCK_TARGET_BASE_PRICE=100` keeps the stock centered around 100. If your old MongoDB history is already around 500, `TSN_STOCK_AUTO_REBASE=true` automatically scales the saved history down the first time the app runs after deployment.


### Price stability + down-move fix

This version uses event-driven price ticks. If online users, messages/hour, posts/hour, and activity score are effectively unchanged, the stock holds still and shows `0` movement instead of bouncing `+4 / -4 / +4 / -4`.

The price now moves both ways:

- Activity increases → the stock can move up.
- Activity decreases → the stock can move down.
- No meaningful change → the stock stays flat.
- No activity → the stock slowly drifts down by `TSN_STOCK_QUIET_DECAY_PER_TICK`.

`TSN_STOCK_DOWNTURN_STRENGTH` controls how strongly falling activity pushes the price down. The optional epsilon settings above control how small a rolling-rate change must be before it counts as a real stock event.

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
GET /api/wallet?playerId=...
POST /api/wallet/tick
POST /api/trade
GET /healthz
POST /api/reset
```

## What affects the price?

TSN Stock is fictional. The standalone TSN Stock server calculates the price from the previous saved price plus current activity. This version is active/bullish, but it is also rebased around 100 so the price does not permanently drift toward 500+. The price changes based on:

- online users
- private messages + global comments per hour
- global posts per hour
- expected activity for the current time of day

It is not a real stock and is not financial advice.

## Keeping the stock around 100

This version adds automatic rebalancing. If the latest saved MongoDB price is much higher than the target base, for example around 500, the server scales the saved chart history down so the latest point lands around 100.

Important environment variables:

```txt
TSN_STOCK_TARGET_BASE_PRICE=100
TSN_STOCK_AUTO_REBASE=true
TSN_STOCK_AUTO_REBASE_THRESHOLD=1.8
TSNM_EARN_PER_MINUTE=10
TSNM_MAX_REWARD_MINUTES_PER_TICK=30
MONGODB_WALLET_COLLECTION=tsnMoneyWallets
MONGODB_TRADE_COLLECTION=tsnMoneyTrades
```

With those defaults, if the newest saved price is above about `180`, TSN Stock automatically rebases history around `100`. You can also press the **Reset** button to clear history and start at 100.


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


## Reset button

The chart page now has a **Reset** button next to **Opdater**.

When you press it, TSN Stock:

- deletes the saved stock history from MongoDB,
- clears temporary memory history,
- creates one new baseline snapshot,
- resets the visible price to `TSN_STOCK_RESET_PRICE` or `100` by default.

For protection, set this optional Render environment variable:

```txt
TSN_STOCK_RESET_KEY=your-secret-reset-key
```

If `TSN_STOCK_RESET_KEY` is set, the website asks for the key before resetting. If it is empty, the reset button works without a key.


## TSNM / trading system

TSNM is fictional. It is not real money, crypto, gambling, or financial trading. It is only an internal game/points system for TSN Stock.

How it works:

- Each browser gets a local `playerId` saved in `localStorage`.
- The server creates a wallet for that `playerId`.
- Every full online minute gives the user `10 TSNM` by default.
- Users can buy TSN Stock at the current TSN Stock price.
- Users can sell TSN Stock back into TSNM.
- Wallets and trades are saved in MongoDB when `MONGODB_URI` is configured.

Optional TSNM settings:

```txt
TSNM_EARN_PER_MINUTE=10
TSNM_MAX_REWARD_MINUTES_PER_TICK=30
MONGODB_WALLET_COLLECTION=tsnMoneyWallets
MONGODB_TRADE_COLLECTION=tsnMoneyTrades
```

`TSNM_MAX_REWARD_MINUTES_PER_TICK=30` prevents someone from closing the tab for days and then claiming a huge amount at once.


## Chart time ranges

The TSN-S graph now has selectable periods:

- 10 minutes
- 30 minutes
- 1 hour
- 6 hours
- 1 day
- 7 days
- All available history

The frontend asks `/api/history?range=...` for the selected period and still adds the latest live price point to the chart. The chart history is refreshed about every 20 seconds, while the stock price itself can still update faster.

Optional env vars:

```env
TSN_STOCK_HISTORY_API_MAX_POINTS=1400
TSN_STOCK_MAX_HISTORY=302400
TSN_STOCK_PAYLOAD_HISTORY_POINTS=720
```

`TSN_STOCK_HISTORY_API_MAX_POINTS` controls how many points the graph API returns after downsampling. For long periods like 1 day or 7 days, the server down-samples the saved MongoDB history so the browser stays fast.

`TSN_STOCK_MAX_HISTORY` controls how many saved MongoDB snapshots the app can keep/load. At the default 2-second refresh, `302400` is about 7 days. The graph API then downsamples that history so long ranges do not lag the browser.


## Login fix / original TSN account login

TSN-S can now log users in in two ways:

1. Directly through the original TSN MongoDB database. This is recommended because it works even if the original TSN API is older.
2. Through the original TSN API at `TSN_API_BASE_URL`.

Recommended Render environment variables for login:

```env
TSN_API_BASE_URL=https://YOUR-NORMAL-TSN.onrender.com
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/tsn_stock?retryWrites=true&w=majority
TSN_ORIGINAL_MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/tsn?retryWrites=true&w=majority
TSN_ORIGINAL_MONGODB_DATABASE=tsn
TSN_ORIGINAL_MONGODB_STATE_COLLECTION=app_state
TSN_STOCK_SESSION_SECRET=make-this-a-long-random-secret
TSN_DATA_ENCRYPTION_KEY=same-key-as-original-tsn
NODE_VERSION=22.16.0
NODE_ENV=production
```

If your original TSN and TSN-S use the same Atlas cluster, `TSN_ORIGINAL_MONGODB_URI` can use the same username/password as `MONGODB_URI`, but the database should be the original TSN database, normally `tsn`, not `tsn_stock`.


## Fix: TSN-S cannot connect to original TSN

This version can connect in two ways:

1. **Primary:** `TSN_API_BASE_URL` calls the original TSN endpoint `/api/public/stock`.
2. **Fallback:** `TSN_ORIGINAL_MONGODB_URI` reads activity directly from the original TSN MongoDB database if the API endpoint is missing/asleep/broken.

Recommended TSN-S environment variables on Render:

```env
TSN_API_BASE_URL=https://YOUR-NORMAL-TSN.onrender.com
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/tsn_stock?retryWrites=true&w=majority

TSN_ORIGINAL_MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/tsn?retryWrites=true&w=majority
TSN_ORIGINAL_MONGODB_DATABASE=tsn
TSN_ORIGINAL_MONGODB_STATE_COLLECTION=app_state
TSN_ORIGINAL_MONGODB_STATE_ID=main

TSN_STOCK_SESSION_SECRET=make-this-a-long-random-secret
TSN_DATA_ENCRYPTION_KEY=same-key-as-original-tsn-if-your-tsn-uses-encrypted-usernames
NODE_ENV=production
NODE_VERSION=22.16.0
NPM_CONFIG_AUDIT=false
NPM_CONFIG_FUND=false
```

After deploying, test this URL in your browser:

```txt
https://YOUR-TSN-STOCK.onrender.com/api/source-test
```

It shows whether TSN-S can reach the original TSN API and/or the MongoDB fallback.

## Render npm crash fix

If Render fails with `npm error Exit handler never called!`, use these settings:

```txt
Build Command:
npm cache clean --force && npm install --omit=dev --no-audit --no-fund --prefer-online

Start Command:
node server.js
```

Set this environment variable on Render:

```env
NODE_VERSION=20.12.2
```

Then use **Manual Deploy → Clear build cache & deploy**.
