IMPORTANT FIX FOR EJSONPARSE

If Render says package.json starts with something like:
PORT=3010
TSN_API_BASE_URL=...

then your package.json file in GitHub was accidentally replaced with environment variables.
package.json must stay JSON. Environment variables must be added in Render > Environment, not inside package.json.

Correct Render settings:
Build Command: npm install --omit=dev --no-audit --no-fund
Start Command: npm start

Add these in Render > Environment:
TSN_API_BASE_URL=https://YOUR-NORMAL-TSN.onrender.com
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/tsn_stock?retryWrites=true&w=majority
TSN_ORIGINAL_MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/tsn?retryWrites=true&w=majority
TSN_ORIGINAL_MONGODB_DATABASE=tsn
TSN_ORIGINAL_MONGODB_STATE_COLLECTION=app_state
TSN_ORIGINAL_MONGODB_STATE_ID=main
TSN_STOCK_SESSION_SECRET=make-this-a-long-random-secret
NODE_ENV=production
NODE_VERSION=22.16.0
NPM_CONFIG_AUDIT=false
NPM_CONFIG_FUND=false

Optional:
PORT=3010
TSN_STOCK_MAX_HISTORY=302400
TSN_STOCK_REFRESH_MS=2000
