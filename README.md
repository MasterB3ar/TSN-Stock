# TSN Stock Standalone

This is a separate website for TSN Stock. It does **not** store its own TSN data. It reads activity data from the original TSN website.

## Important

Deploy the updated original TSN project first. It adds this public endpoint:

```txt
/api/public/stock
```

That endpoint returns only the fictional stock snapshot and activity metrics. It does not expose private message content, passwords, sessions, or user data.

## Local setup

```bash
npm install
cp .env.example .env
npm run dev
```

Set this in `.env`:

```txt
TSN_API_BASE_URL=https://your-original-tsn-url.onrender.com
```

Then open:

```txt
http://localhost:3010
```

## Render setup

1. Create a new Web Service for this `tsn-stock-standalone` folder.
2. Set build command:

```bash
npm install
```

3. Set start command:

```bash
npm start
```

4. Add environment variable:

```txt
TSN_API_BASE_URL=https://your-original-tsn-url.onrender.com
```

## What affects the price?

TSN Stock is fictional. The price changes based on:

- online users
- private messages + global comments per hour
- global posts per hour
- expected activity for the current time of day

It is not a real stock and is not financial advice.
