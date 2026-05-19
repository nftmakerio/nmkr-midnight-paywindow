# NMKR Midnight Paywindow

A single-shot NFT mint window for the [Midnight Network](https://midnight.network),
designed to be opened in its own browser window via

```
https://midnight-paywindow.nmkr.io/?id=<paywindowId>
```

The window auto-connects to a Midnight wallet (e.g. 1AM), builds an atomic
mint transaction on the server, has the wallet balance and submit it, and
then reveals the minted NFT (image, name, description, and a link to
the off-chain metadata JSON).

---

## Architecture

```
┌─────────────────┐
│  Browser        │   /?id=<paywindowId>
│  (1AM / Lace)   │
└────────┬────────┘
         │  GET  /api/paywindow/:id           (pre-flight)
         │  POST /api/build-mint              (on Mint click)
         │  POST /api/reveal-metadata         (after submit)
         ▼
┌────────────────────────────┐
│  Bridge server (this repo) │   Node + Express
└──────┬──────────────┬──────┘
       │              │
       │              │  GET /paywindow/:id (Bearer)
       │              ▼
       │      ┌──────────────────────────┐
       │      │  NMKR Studio              │
       │      │  (PaywindowData lookup —  │
       │      │   contains owner seed)    │
       │      └──────────────────────────┘
       │
       │  POST /api/nft/build-unsealed-mint
       ▼
┌──────────────────────────┐
│  nmkr-midnight-api       │
│  (signs + proves the tx) │
└──────────┬───────────────┘
           │
           ▼
     Midnight node / indexer
```

The **owner seed never leaves the server side**. The browser only ever
sees `unsealedTxHex`, the future `tokenId`, the contract address, and —
after a successful mint — the NFT name, image, and metadata.

---

## Repository layout

```
.
├── server/server.js            # Express bridge (this is what you deploy)
├── web/public/
│   ├── index.html              # Logo + Mint button + reveal card
│   └── app.js                  # Wallet auto-connect, mint flow, reveal
├── csharp/
│   ├── PaywindowModels.cs      # DTOs for the NMKR Studio response
│   └── PaywindowController.cs  # ASP.NET controller skeleton
└── package.json
```

---

## Running locally (mock mode)

The bridge ships with a **mock** mode that synthesises a PaywindowData
record from environment variables, so you can iterate on the UI without
the NMKR Studio endpoint being live yet.

```bash
git clone https://github.com/nftmakerio/nmkr-midnight-paywindow.git
cd nmkr-midnight-paywindow
npm install

# Make sure nmkr-midnight-api is running on :3002

PAYWINDOW_MOCK=1 \
OWNER_SEED=<collection-owner-seed> \
CONTRACT_ADDRESS=<bech32m-contract-address> \
RECIPIENT_1=<mn_addr_preview1...> \
PRICE_NIGHT=2 \
npm start
```

Then open `http://localhost:4100/?id=demo` in a browser with the 1AM
extension installed and switched to Preview.

The mock recognises a few special ids so you can test error paths
without touching the real Studio:

| id | Result |
|----|--------|
| anything else | 200 OK — synthetic PaywindowData |
| `invalid` / `notfound` | 404 — `paywindow id "..." not found` |
| `expired` | 410 — `paywindow id "..." has been consumed or expired` |

---

## Running against real NMKR Studio

```bash
PORT=4100 \
NMKR_API_URL=http://127.0.0.1:3002 \
NMKR_STUDIO_URL=https://studio.nmkr.io/api \
NMKR_STUDIO_API_KEY=<bearer-token> \
npm start
```

The bridge will hit `GET {NMKR_STUDIO_URL}/paywindow/{id}` with the
configured bearer token and expects the response to match
[`PaywindowData`](csharp/PaywindowModels.cs).

---

## Environment variables

| Var | Default | Description |
|---|---|---|
| `PORT` | `4100` | HTTP port the bridge listens on |
| `NMKR_API_URL` | `http://localhost:3002` | URL of the `nmkr-midnight-api` instance that does the actual proving + signing |
| `NMKR_STUDIO_URL` | — | URL of the paywindow lookup API (production) |
| `NMKR_STUDIO_API_KEY` | — | Optional bearer token sent to NMKR Studio |
| `PAYWINDOW_MOCK` | — | Set to `1` to bypass NMKR Studio (dev mode) |
| `OWNER_SEED` | — | (mock mode) seed used to sign the mint |
| `CONTRACT_ADDRESS` | — | (mock mode) contract to mint into |
| `RECIPIENT_1`/`_2`/`_3` | — | (mock mode) NIGHT payment recipients |
| `PRICE_NIGHT` | `2` | (mock mode) total price split across recipients |

---

## HTTP API

All responses are JSON. Errors look like `{ "error": "..." }`.

### `GET /api/paywindow/:id`

Pre-flight used by the frontend on page load. Does **not** expose any
sensitive data — the bridge calls NMKR Studio internally and only
returns whether the id is usable and the price.

```json
{ "ok": true, "id": "12345", "priceNight": 2, "hasPayment": true }
```

Returns `404` if the id is unknown, `410` if it was already consumed or
has expired, `502` if NMKR Studio is unreachable.

### `POST /api/build-mint`

Body: `{ "id": "12345", "buyerShieldedAddress": "mn_shield-addr_preview1..." }`

The bridge fetches the PaywindowData, forwards the build to
`nmkr-midnight-api`, and returns:

```json
{
  "unsealedTxHex": "...hex...",
  "bytes": 12345,
  "tokenId": 42,
  "contractAddress": "...",
  "preview": { "name": "...", "image": "https://..." },
  "priceNight": 2
}
```

The frontend then calls `connectedApi.balanceUnsealedTransaction()` and
`connectedApi.submitTransaction()` against the user's wallet (each step
requires a separate wallet confirmation).

### `POST /api/reveal-metadata`

Body: `{ "id": "12345" }`

Called only after the mint tx has been submitted. Returns the NFT's
name, image, description, mediaType, and URI — kept on the server
until this point so the user cannot inspect them before paying. The
URI is shown as a clickable link in the reveal card; rich attributes
(rarity, edition, …) live in the JSON document at that URI.

---

## NMKR Studio side — required endpoint

```
GET  /paywindow/{id}
Authorization: Bearer <api-key>
```

Response: a `PaywindowData` JSON document — see
[`csharp/PaywindowModels.cs`](csharp/PaywindowModels.cs) and the
controller skeleton in
[`csharp/PaywindowController.cs`](csharp/PaywindowController.cs).

Example response:

```json
{
  "id": "12345",
  "ownerSeed": "abcdef...",
  "contractAddress": "0200abc...",
  "nft": {
    "name": "My Paywindow NFT",
    "uri":  "https://nmkr.io/meta/12345.json",
    "image": "https://nmkr.io/img/12345.png",
    "mediaType": "image/png",
    "description": "Shown after the reveal."
  },
  "payment": {
    "priceNight": 2,
    "recipients": [
      { "address": "mn_addr_preview1...", "amountRaw": "1000000" },
      { "address": "mn_addr_preview1...", "amountRaw": "1000000" }
    ]
  }
}
```

Recommended behaviour:

- **Authenticate** the endpoint with a bearer token and restrict it to
  the bridge server's IP — the response contains the owner seed.
- Return **`404`** for unknown ids.
- Return **`410 Gone`** once a paywindow has been redeemed (the bridge
  can call `POST /paywindow/{id}/consume` after a successful mint to
  mark it as such — see `PaywindowController.cs`).

---

## Deployment notes

The bridge is a tiny stateless Node process. Typical setup on a single
host:

- `nmkr-midnight-api` on `127.0.0.1:3002`
- This bridge on `127.0.0.1:4100`
- nginx terminates TLS for `midnight-paywindow.nmkr.io` and reverse-proxies
  to `127.0.0.1:4100`
- Both Node processes managed by `systemd` (or `pm2`)
- Outbound access to NMKR Studio and to the Midnight node / indexer

Never log the request body in `/api/build-mint` — it contains the owner
seed in transit.

---

## License

Proprietary, © NMKR.
