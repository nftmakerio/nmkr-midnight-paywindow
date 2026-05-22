// ============================================================
// NMKR Midnight Paywindow — bridge server.
//
// Flow:
//   1. Browser opens /?id=<paywindowId>
//   2. Frontend calls   GET  /api/paywindow/:id           (pre-flight)
//        -> bridge fetches paywindow data from NMKR Studio
//        -> returns { ok, hasPayment, totalNightRaw } (NO seed, NO metadata)
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
//   NMKR_NETWORK               preprod | mainnet — picks the Studio base URL.
//                              default preprod
//   NMKR_API_URL               default http://localhost:3002 (the local mint signer)
//   NMKR_STUDIO_URL            explicit override for the Studio base URL.
//                              normally not needed — set NMKR_NETWORK instead.
//   NMKR_STUDIO_API_KEY        bearer token for NMKR Studio (required unless PAYWINDOW_MOCK=1)
//   ALLOWED_ORIGIN             optional CORS allow-list (comma-separated).
//                              omit to allow same-origin only (no Access-Control header).
//   PAYWINDOW_MOCK=1           dev mode: serve a synthetic paywindow built from
//                              OWNER_SEED + CONTRACT_ADDRESS + RECIPIENT_* env vars
// ============================================================

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT              = Number(process.env.PORT) || 4100;
const NMKR_NETWORK      = (process.env.NMKR_NETWORK || 'preprod').toLowerCase();
const NMKR_API_URL      = process.env.NMKR_API_URL      || 'http://localhost:3002';
const NMKR_STUDIO_KEY   = process.env.NMKR_STUDIO_API_KEY || '';
const PAYWINDOW_MOCK    = process.env.PAYWINDOW_MOCK === '1';
const ALLOWED_ORIGINS   = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);

const STUDIO_DEFAULTS = {
  preprod: 'https://studio-api.preprod.nmkr.io/v2',
  mainnet: 'https://studio-api.nmkr.io/v2',
};
if (!STUDIO_DEFAULTS[NMKR_NETWORK] && !process.env.NMKR_STUDIO_URL) {
  console.error(`FATAL: NMKR_NETWORK="${NMKR_NETWORK}" is not recognised. Use "preprod" or "mainnet", or set NMKR_STUDIO_URL explicitly.`);
  process.exit(1);
}
const NMKR_STUDIO_URL = (process.env.NMKR_STUDIO_URL || STUDIO_DEFAULTS[NMKR_NETWORK]).replace(/\/$/, '');

const MOCK_OWNER_SEED       = process.env.OWNER_SEED       || '';
const MOCK_CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '';
const MOCK_RECIPIENTS = [process.env.RECIPIENT_1, process.env.RECIPIENT_2, process.env.RECIPIENT_3].filter(Boolean);
const MOCK_PRICE_NIGHT = Number(process.env.PRICE_NIGHT) || 2;

if (!PAYWINDOW_MOCK && !NMKR_STUDIO_KEY) {
  console.error('FATAL: NMKR_STUDIO_API_KEY is required (or set PAYWINDOW_MOCK=1 for dev).');
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
    const perRaw = Math.floor((MOCK_PRICE_NIGHT * 1_000_000) / MOCK_RECIPIENTS.length);
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
      recipients: MOCK_RECIPIENTS.map(addr => ({ address: addr, amountRaw: perRaw })),
    };
  }

  // NMKR Studio: GET {base}/GetMidnightPaywindowDetails?reservationid={id}
  // (preprod or mainnet, depending on NMKR_STUDIO_URL — see env docs above).
  const headers = {
    accept: 'text/plain',
    Authorization: `Bearer ${NMKR_STUDIO_KEY}`,
  };
  const url = `${NMKR_STUDIO_URL}/GetMidnightPaywindowDetails?reservationid=${encodeURIComponent(id)}`;

  let r;
  try {
    r = await fetch(url, { headers });
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
// Sum the recipient amounts. Returned in atomic units; the browser
// divides by 1_000_000 for display.
function totalNightRaw(pw) {
  const recipients = pw?.recipients || [];
  return recipients.reduce((s, r) => s + Number(r.amountRaw), 0);
}

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

// Optional CORS — only emitted when the request's Origin is on the
// configured allow-list. Set ALLOWED_ORIGIN=https://example.com,https://other.com.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Catch-all JSON 404 for /api/* so a missing route never returns the SPA's HTML.
// (Must be registered AFTER all real /api routes — done below.)

app.use(express.static(path.join(__dirname, '..', 'web', 'public')));

// Health check: probes nmkr-midnight-api and NMKR Studio so the frontend
// can fail fast and tell the user which dependency is down. Cheap to call;
// no auth required.
app.get('/api/health', async (_req, res) => {
  const result = {
    bridge: { ok: true, port: PORT, mock: PAYWINDOW_MOCK },
    nmkrMidnightApi: { ok: false, url: NMKR_API_URL },
    nmkrStudio: { ok: false, url: PAYWINDOW_MOCK ? '[MOCK]' : NMKR_STUDIO_URL },
  };

  // nmkr-midnight-api — quick GET /api/health with a 3s timeout.
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`${NMKR_API_URL}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      result.nmkrMidnightApi = { ok: true, url: NMKR_API_URL, network: j?.network ?? null };
    } else {
      result.nmkrMidnightApi.error = `HTTP ${r.status}`;
    }
  } catch (err) {
    result.nmkrMidnightApi.error = err.name === 'AbortError'
      ? `timeout after 3s contacting ${NMKR_API_URL}`
      : err.message;
  }

  // NMKR Studio — in MOCK mode there's nothing to probe.
  if (PAYWINDOW_MOCK) {
    result.nmkrStudio.ok = true;
  } else {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3000);
      // We don't have an unauthenticated health endpoint at Studio; hit
      // /GetMidnightPaywindowDetails with a sentinel id and rely on the
      // server returning 401/404 (which proves it's reachable + auth works
      // or the bearer is wrong, depending on the code).
      const headers = { accept: 'text/plain', Authorization: `Bearer ${NMKR_STUDIO_KEY}` };
      const r = await fetch(`${NMKR_STUDIO_URL}/GetMidnightPaywindowDetails?reservationid=healthcheck-probe`,
        { headers, signal: ctl.signal });
      clearTimeout(t);
      if (r.status === 401 || r.status === 403) {
        result.nmkrStudio.error = `auth rejected (HTTP ${r.status}) — check NMKR_STUDIO_API_KEY`;
      } else {
        // Any other response (200, 404, 410, even 500) means we reached the
        // server with a valid bearer; the health check passes.
        result.nmkrStudio.ok = true;
        result.nmkrStudio.probeStatus = r.status;
      }
    } catch (err) {
      result.nmkrStudio.error = err.name === 'AbortError'
        ? `timeout after 3s contacting ${NMKR_STUDIO_URL}`
        : err.message;
    }
  }

  const allOk = result.bridge.ok && result.nmkrMidnightApi.ok && result.nmkrStudio.ok;
  res.status(allOk ? 200 : 503).json({ ok: allOk, ...result });
});

// 1) Pre-flight: validate the paywindow id without exposing any
//    sensitive data. Used by the frontend on page load to fail fast
//    if the link is bad/expired.
app.get('/api/paywindow/:id', async (req, res) => {
  try {
    const pw = await fetchPaywindow(req.params.id);
    // Recipients are public bech32m addresses + amounts — fine to expose
    // to the browser so the wallet can build the NIGHT transfer locally.
    // The owner seed and contract metadata stay server-side.
    res.json({
      ok: true,
      id: pw.id,
      hasPayment: Boolean(pw.recipients?.length),
      totalNightRaw: totalNightRaw(pw),
      recipients: (pw.recipients || []).map(r => ({
        address: r.address,
        amountRaw: Number(r.amountRaw),
      })),
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

    // NOTE: nightRecipients are intentionally NOT included here. The
    // current nmkr-nft Compact contract does not declare unshieldedOutputs
    // in its ContractCallPrototype, so any NIGHT outputs attached to the
    // mint intent are silently dropped on-chain (verified via tx
    // af894bc9d5b5… — Public Outputs: 0). The browser instead does a
    // separate 1AM makeTransfer for the NIGHT before submitting this
    // mint tx, using the recipient list returned by /api/paywindow/:id.
    const body = {
      ownerSeed: pw.ownerSeed,
      contractAddress: pw.contractAddress,
      name: pw.nft.name,
      uri:  pw.nft.uri,
      image: pw.nft.image || '',
      mediaType: pw.nft.mediaType || '',
      toShieldedAddress: buyerShieldedAddress,
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
    if (!r.ok) {
      // Log the full upstream response so the failure is visible in
      // bridge logs even when the browser only sees a short message.
      console.error('[/api/build-mint] nmkr-midnight-api error', {
        status: r.status,
        body: j,
        request: {
          contractAddress: body.contractAddress,
          name: body.name,
          toShieldedAddress: body.toShieldedAddress?.slice(0, 35) + '…',
          nightRecipients: body.nightRecipients.map(x => ({
            addr: x.address.slice(0, 35) + '…',
            amountRaw: x.amountRaw,
          })),
        },
      });
      // Pass through whatever the upstream said (incl. stack snippet) so
      // the frontend can show the real cause.
      throw new HttpError(r.status, j?.error || `nmkr-midnight-api HTTP ${r.status}`, j?.stack);
    }

    res.json({
      unsealedTxHex: j.unsealedTxHex,
      bytes: j.bytes,
      tokenId: j.tokenId,
      contractAddress: j.contractAddress,
      preview: { name: pw.nft.name, image: pw.nft.image },
      totalNightRaw: totalNightRaw(pw),
    });
  } catch (err) { sendError(res, err); }
});

// 3) Wait for the NIGHT transfer to be observed on-chain. The browser
// calls this after 1AM's makeTransfer so we can confirm the payment
// arrived BEFORE asking it to submit the mint tx. Polls the
// nmkr-midnight-api address-history endpoint and looks for a sent
// (or self) tx with outputs to every paywindow recipient.
app.post('/api/wait-for-night-tx', async (req, res) => {
  try {
    const { id, buyerUnshieldedAddress, sinceMs = 60_000, maxWaitMs = 120_000 } = req.body ?? {};
    if (!id) throw new HttpError(400, 'id is required');
    if (!buyerUnshieldedAddress?.startsWith?.('mn_addr_')) {
      throw new HttpError(400, 'buyerUnshieldedAddress is required (mn_addr_…)');
    }
    const pw = await fetchPaywindow(id);
    const expectedRecipients = (pw.recipients || []).map(r => ({
      address:   r.address,
      amountRaw: BigInt(r.amountRaw),
    }));
    if (expectedRecipients.length === 0) {
      return res.json({ ok: true, skipped: 'no payment configured for this paywindow' });
    }

    const since = Date.now() - sinceMs;
    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      try {
        const r = await fetch(`${NMKR_API_URL}/api/address/${encodeURIComponent(buyerUnshieldedAddress)}/transactions`);
        if (r.ok) {
          const data = await r.json();
          const txs = data.transactions || [];
          const match = txs.find((t) => {
            if (t.type !== 'sent' && t.type !== 'self') return false;
            const ts = t.timestamp ? Date.parse(t.timestamp) : 0;
            if (ts && ts < since - 60_000) return false;
            return expectedRecipients.every(rcv =>
              (t.allOutputs || []).some(o =>
                o.to === rcv.address && BigInt(o.value) >= rcv.amountRaw));
          });
          if (match) {
            console.log(`[wait-for-night-tx] match after ${attempt} attempts: ${match.txHash}`);
            return res.json({ ok: true, txHash: match.txHash, attempts: attempt });
          }
        }
      } catch (err) {
        console.warn(`[wait-for-night-tx] poll attempt ${attempt} failed: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 5_000));
    }
    throw new HttpError(408, `NIGHT payment not observed in ${Math.round(maxWaitMs/1000)}s. The mint will not proceed.`);
  } catch (err) { sendError(res, err); }
});

// 4) Reveal metadata — called only after a successful submit.
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
  console.log(`  Network  : ${PAYWINDOW_MOCK ? '[MOCK]' : NMKR_NETWORK}`);
  console.log(`  Studio   : ${PAYWINDOW_MOCK ? '[MOCK]' : NMKR_STUDIO_URL}`);
  console.log(`  NMKR API : ${NMKR_API_URL}`);
  if (!PAYWINDOW_MOCK) console.log(`  Auth     : Bearer ${NMKR_STUDIO_KEY.slice(0, 6)}…`);
  if (ALLOWED_ORIGINS.length) console.log(`  CORS     : ${ALLOWED_ORIGINS.join(', ')}`);
});
