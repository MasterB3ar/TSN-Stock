# TSN-S — CEO-only read-only dashboard

TSN-S is now a restricted dashboard for the normal TSN site. It is **not** a wallet/trading app anymore.

## What changed in v1.2.1

- You must log in before the dashboard loads.
- Only the normal TSN user with username `ceo` can log in.
- Any other username gets the message: `access denied`.
- TSNM wallet is removed.
- TSNM earning is removed.
- Buying/selling TSN Stock is removed.
- `/api/wallet`, `/api/wallet/tick`, `/api/wallet/test`, `/api/trade`, and `/api/trade/test` are disabled.
- The dashboard only shows:
  - TSN-S price
  - price graph/history
  - online users
  - messages per hour
  - global chats per hour
- Anti-spam protection stays enabled so one person cannot pump the TSN-S price.

## Required normal TSN endpoints

TSN-S logs in through your normal TSN website and reads stock/activity data from it:

```txt
/api/auth/login
/api/me
/api/public/stock
```

Set this on the **TSN-S Render service**:

```env
TSN_API_BASE_URL=https://your-normal-tsn.onrender.com
```

Do **not** use the TSN-S URL, and do **not** add `/api` at the end.

## Required Render environment variables

```env
NODE_ENV=production
NODE_VERSION=20.12.2

TSN_API_BASE_URL=https://your-normal-tsn.onrender.com
TSN_API_CONNECT_TIMEOUT_MS=30000
TSN_API_RETRY_COUNT=2

TSN_STOCK_ALLOWED_USERNAME=ceo
TSN_STOCK_SESSION_SECRET=make-this-a-long-random-secret

MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/tsn_stock?retryWrites=true&w=majority
MONGODB_DATABASE=tsn_stock
MONGODB_COLLECTION=stockSnapshots

TSN_STOCK_ENABLE_RESET=false
TSN_STOCK_ANTI_SPAM=true
TSN_STOCK_SPAM_MESSAGE_CAP_PER_USER_PER_HOUR=8
TSN_STOCK_SPAM_POST_CAP_PER_USER_PER_HOUR=3
TSN_STOCK_SPAM_DUPLICATE_WINDOW_MS=120000
TSN_STOCK_SPAM_MIN_UNIQUE_USERS_FOR_FULL_BOOST=2
```

## Optional direct MongoDB login fallback

Use this only if the normal TSN API login is missing or unreliable. It must point to the **normal TSN database**, not the TSN-S history database.

```env
TSN_ORIGINAL_MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/tsn?retryWrites=true&w=majority
TSN_ORIGINAL_MONGODB_DATABASE=tsn
TSN_ORIGINAL_MONGODB_STATE_COLLECTION=app_state
TSN_ORIGINAL_MONGODB_STATE_ID=main
TSN_DATA_ENCRYPTION_KEY=your-original-tsn-data-encryption-key
```

## Render commands

```txt
Build Command: bash ./render-build.sh
Start Command: node server.js
```

After uploading, use:

```txt
Manual Deploy → Clear build cache & deploy
```

## Testing

- Open TSN-S. You should only see the login screen.
- Try a username that is not `ceo`. It should show `access denied`.
- Log in with the normal TSN account whose username is exactly `ceo`.
- The dashboard should then load price, graph, online users, messages/hour, and global chats/hour.
- `/api/stock` and `/api/history` require the CEO login token.
- `/api/wallet` and `/api/trade` return disabled/removed responses.


## v1.2.2 CEO Analytics Upgrades

TSN-S is still CEO-only and read-only. Wallets, TSNM earning, buying stocks, and selling stocks are still removed.

Added in this version:

- Extra CEO stat cards: private messages/hour, activity score, and selected-range price change.
- More graph ranges: Today and 30D, in addition to 10m, 30m, 1H, 6H, 1D, 7D, and All.
- Price explanation panel that describes why the TSN-S price moved or stayed flat.
- System alerts for stale TSN data, MongoDB persistence, closed market state, spam filtering, and source connection problems.
- Export Report button that downloads a JSON CEO report for the selected graph range.
- New backend endpoint: `/api/report`.

No new environment variables are required.
