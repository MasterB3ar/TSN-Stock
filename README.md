{
  "name": "tsn-stock-standalone",
  "version": "1.1.2",
  "description": "Standalone TSN Stock with robust original TSN API/MongoDB fallback connection, original TSN account login, TSNM trading, MongoDB persistence, balanced movement, and chart ranges.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "build": "node -e \"console.log('No build step needed for TSN Stock')\""
  },
  "dependencies": {
    "mongodb": "^6.18.0",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2"
  },
  "keywords": [
    "tsn",
    "stock",
    "activity",
    "dashboard",
    "mongodb"
  ],
  "author": "TSN",
  "license": "MIT",
  "engines": {
    "node": "22.x"
  }
}
