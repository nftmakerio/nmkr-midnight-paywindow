// ============================================================
// NMKR Midnight Paywindow — bridge server.
//
// Flow:
//   1. Browser opens /?id=<paywindowId>
//   2. Frontend calls   GET  /api/paywindow/:id           (pre-flight)
//        -> bridge fetches paywindow data from NMKR Studio
//        -> returns { ok, priceNight } (NO seed, NO metadata)
//        -> 404 if unknown, 410 if consumed/expired
//   3. Frontend calls   POST /api/build-mint              (on button click)
//        -> bridge calls nmkr-midnight-api /api/nft/build-unsealed-mint
//        -> returns { unsealedTxHex, bytes, tokenId, preview:{name,image} }
//   4. Wallet balances + submits the tx
//   5. Frontend calls   POST /api/reveal-metadata         (after submit)
//        -> bridge returns the full NFT metadata
//
// Env:
//   PORT                       default 4100
//   NMKR_API_URL               default http://localhost:3002
//   NMKR_STUDIO_URL            URL of the paywindow lookup API
//   NMKR_STUDIO_API_KEY        optional bearer token
//   PAYWINDOW_MOCK=1           dev mode: serve a synthetic paywindow built from
//                              OWNER_SEED + CONTRACT_ADDRESS + RECIPIENT_* env vars
// ============================================================

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT              = Number(process.env.PORT) || 4100;
const NMKR_API_URL      = process.env.NMKR_API_URL      || 'http://localhost:3002';
const NMKR_STUDIO_URL   = process.env.NMKR_STUDIO_URL   || '';
const NMKR_STUDIO_KEY   = process.env.NMKR_STUDIO_API_KEY || '';
const PAYWINDOW_MOCK    = process.env.PAYWINDOW_MOCK === '1';

const MOCK_OWNER_SEED       = process.env.OWNER_SEED       || '';
const MOCK_CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '';
const MOCK_RECIPIENTS = [process.env.RECIPIENT_1, process.env.RECIPIENT_2, process.env.RECIPIENT_3].filter(Boolean);
const MOCK_PRICE_NIGHT = Number(process.env.PRICE_NIGHT) || 2;

if (!PAYWINDOW_MOCK && !NMKR_STUDIO_URL) {
  console.error('FATAL: set NMKR_STUDIO_URL, or PAYWINDOW_MOCK=1 with OWNER_SEED + CONTRACT_ADDRESS.');
  process.exit(1);
}
if (PAYWINDOW_MOCK && (!MOCK_OWNER_SEED || !MOCK_CONTRACT_ADDRESS || MOCK_RECIPIENTS.length === 0)) {
  console.error('FATAL: PAYWINDOW_MOCK=1 requires OWNER_SEED, CONTRACT_ADDRESS and at least RECIPIENT_1.');
  process.exit(1);
}

// ------------------------------------------------------------
// Typed error so route handlers can map upstream failures to
// the correct HTTP status code with a clean JSON message.
// ------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Parse a response body as JSON, but if the upstream returned HTML or text
// (typical when an endpoint is missing, behind a login page, or proxied
// through nginx), surface that clearly instead of letting JSON.parse throw
// a useless "Unexpected token '<'" message.
async function readJsonOrThrow(res, contextLabel) {
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const looksLikeJson = ct.includes('application/json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
  if (!looksLikeJson) {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 200);
    throw new HttpError(
      res.ok ? 502 : res.status,
      `${contextLabel}: expected JSON but got ${ct || 'no content-type'} (HTTP ${res.status}). Body starts with: ${snippet}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(502, `${contextLabel}: malformed JSON (${err.message})`);
  }
}

// ------------------------------------------------------------
// Paywindow lookup: returns the full PaywindowData record for an id.
// In production this hits NMKR Studio; in mock mode it returns a
// synthetic record built from env vars.
// ------------------------------------------------------------
async function fetchPaywindow(id) {
  if (PAYWINDOW_MOCK) {
    if (id === 'invalid' || id === 'notfound') {
      throw new HttpError(404, `paywindow id "${id}" not found`);
    }
    if (id === 'expired') {
      throw new HttpError(410, `paywindow id "${id}" has been consumed or expired`);
    }
    const perRaw = BigInt(Math.floor((MOCK_PRICE_NIGHT * 1_000_000) / MOCK_RECIPIENTS.length));
    return {
      id,
      ownerSeed: MOCK_OWNER_SEED,
      contractAddress: MOCK_CONTRACT_ADDRESS,
      nft: {
        name: `Paywindow Demo NFT #${id}`,
        uri:  `https://nmkr.io/paywindow/${id}`,
        image: 'https://studio.nmkr.io/images/nmkr-studio-logo.svg',
        mediaType: 'image/svg+xml',
        description: 'Demo NFT minted from the NMKR Paywindow.',
      },
      payment: {
        priceNight: MOCK_PRICE_NIGHT,
        recipients: MOCK_RECIPIENTS.map(addr => ({ address: addr, amountRaw: perRaw.toString() })),
      },
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (NMKR_STUDIO_KEY) headers['Authorization'] = `Bearer ${NMKR_STUDIO_KEY}`;

  let r;
  try {
    r = await fetch(`${NMKR_STUDIO_URL.replace(/\/$/, '')}/paywindow/${encodeURIComponent(id)}`, { headers });
  } catch (err) {
    throw new HttpError(502, `cannot reach NMKR Studio: ${err.message}`);
  }

  if (r.status === 404) throw new HttpError(404, `paywindow id "${id}" not found`);
  if (r.status === 410) throw new HttpError(410, `paywindow id "${id}" has been consumed or expired`);
  if (r.status === 401 || r.status === 403) {
    throw new HttpError(502, `NMKR Studio rejected the bridge credentials (HTTP ${r.status}) — check NMKR_STUDIO_API_KEY`);
  }
  if (!r.ok) {
    // try to extract the upstream error message but never crash on HTML
    let msg = `NMKR Studio error (HTTP ${r.status})`;
    try {
      const body = await readJsonOrThrow(r, 'NMKR Studio');
      if (body?.error) msg = `NMKR Studio: ${body.error}`;
    } catch { /* keep generic msg */ }
    throw new HttpError(502, msg);
  }

  return await readJsonOrThrow(r, 'NMKR Studio');
}

// Send an HttpError (or unknown Error) as a JSON response with the
// right status code. Never lets HTML leak to the client.
function sendError(res, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  console.error('[bridge] unexpected error:', err);
  return res.status(500).json({ error: err?.message || 'internal error' });
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store, max-age=0'); next(); });

// Catch-all JSON 404 for /api/* so a missing route never returns the SPA's HTML.
// (Must be registered AFTER all real /api routes — done below.)

app.use(express.static(path.join(__dirname, '..', 'web', 'public')));

// 1) Pre-flight: validate the paywindow id without exposing any
//    sensitive data. Used by the frontend on page load to fail fast
//    if the link is bad/expired.
app.get('/api/paywindow/:id', async (req, res) => {
  try {
    const pw = await fetchPaywindow(req.params.id);
    res.json({
      ok: true,
      id: pw.id,
      priceNight: pw.payment?.priceNight ?? 0,
      hasPayment: Boolean(pw.payment?.recipients?.length),
    });
  } catch (err) { sendError(res, err); }
});

// 2) Build the unsealed mint tx. Returns only the tx hex + a preview
//    (name + image). The owner seed never leaves this server.
app.post('/api/build-mint', async (req, res) => {
  try {
    const { id, buyerShieldedAddress } = req.body ?? {};
    if (!id) throw new HttpError(400, 'id is required');
    if (!buyerShieldedAddress?.startsWith?.('mn_shield-addr_')) {
      throw new HttpError(400, 'buyerShieldedAddress is required');
    }

    const pw = await fetchPaywindow(id);

    const body = {
      ownerSeed: pw.ownerSeed,
      contractAddress: pw.contractAddress,
      name: pw.nft.name,
      uri:  pw.nft.uri,
      image: pw.nft.image || '',
      mediaType: pw.nft.mediaType || '',
      toShieldedAddress: buyerShieldedAddress,
      nightRecipients: (pw.payment?.recipients || []).map(r => ({
        address: r.address,
        amountRaw: r.amountRaw,
      })),
    };

    let r;
    try {
      r = await fetch(`${NMKR_API_URL}/api/nft/build-unsealed-mint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new HttpError(502, `cannot reach nmkr-midnight-api at ${NMKR_API_URL}: ${err.message}`);
    }

    const j = await readJsonOrThrow(r, 'nmkr-midnight-api');
    if (!r.ok) throw new HttpError(r.status, j?.error || `nmkr-midnight-api HTTP ${r.status}`);

    res.json({
      unsealedTxHex: j.unsealedTxHex,
      bytes: j.bytes,
      tokenId: j.tokenId,
      contractAddress: j.contractAddress,
      preview: { name: pw.nft.name, image: pw.nft.image },
      priceNight: pw.payment?.priceNight ?? 0,
    });
  } catch (err) { sendError(res, err); }
});

// 3) Reveal metadata — called only after a successful submit.
app.post('/api/reveal-metadata', async (req, res) => {
  try {
    const { id } = req.body ?? {};
    if (!id) throw new HttpError(400, 'id is required');
    const pw = await fetchPaywindow(id);
    res.json({
      name: pw.nft.name,
      image: pw.nft.image,
      uri: pw.nft.uri,
      mediaType: pw.nft.mediaType,
      description: pw.nft.description,
    });
  } catch (err) { sendError(res, err); }
});

// Catch-all for any unknown /api/* route → JSON 404 (not HTML).
app.all('/api/*splat', (req, res) => {
  res.status(404).json({ error: `unknown api route: ${req.method} ${req.path}` });
});

app.listen(PORT, () => {
  console.log(`NMKR Midnight Paywindow listening on http://localhost:${PORT}`);
  console.log(`  NMKR API : ${NMKR_API_URL}`);
  console.log(`  Studio   : ${PAYWINDOW_MOCK ? '[MOCK]' : NMKR_STUDIO_URL}`);
});
