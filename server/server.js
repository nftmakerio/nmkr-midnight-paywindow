// ============================================================
// NMKR Midnight Paywindow — Bridge-Server.
//
// Flow:
//   1. Browser oeffnet /?id=<paywindowId>
//   2. Frontend ruft  POST /api/build-mint        { id, buyerShieldedAddress }
//        -> Server holt vom NMKR Studio die Paywindow-Daten zur id
//        -> Server ruft nmkr-midnight-api /api/nft/build-unsealed-mint
//        -> Server gibt zurueck: { unsealedTxHex, bytes, tokenId, preview:{ name, image } }
//   3. Wallet balanced + submittet die Tx
//   4. Frontend ruft  POST /api/reveal-metadata   { id, paymentTxOk:true }
//        -> Server liefert die vollen Metadaten erst nach dem Mint
//
// Env-Vars:
//   PORT                       default 4100
//   NMKR_API_URL               default http://localhost:3002
//   NMKR_STUDIO_URL            URL der Paywindow-Lookup-API (vom User bereitgestellt)
//   NMKR_STUDIO_API_KEY        optionaler API-Key, wird als Authorization-Header gesetzt
//   PAYWINDOW_MOCK=1           solange die Studio-API noch nicht existiert: gibt
//                              ein Dummy-Paywindow-Datenobjekt zurueck (Seed/Contract
//                              kommen dann aus den Env-Vars unten — wie bei dapp-demo)
//   OWNER_SEED, CONTRACT_ADDRESS, RECIPIENT_1..3, PRICE_NIGHT (nur fuer Mock)
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
  console.error('FATAL: entweder NMKR_STUDIO_URL setzen oder PAYWINDOW_MOCK=1 mit OWNER_SEED + CONTRACT_ADDRESS.');
  process.exit(1);
}
if (PAYWINDOW_MOCK && (!MOCK_OWNER_SEED || !MOCK_CONTRACT_ADDRESS || MOCK_RECIPIENTS.length === 0)) {
  console.error('FATAL: PAYWINDOW_MOCK=1 verlangt OWNER_SEED, CONTRACT_ADDRESS und mindestens RECIPIENT_1.');
  process.exit(1);
}

// ------------------------------------------------------------
// Paywindow-Lookup: holt fuer eine id ein Datenobjekt, das alles
// enthaelt was zum Minten benoetigt wird. In Produktion: NMKR Studio.
// Format siehe csharp/PaywindowModels.cs
// ------------------------------------------------------------
async function fetchPaywindow(id) {
  if (PAYWINDOW_MOCK) {
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
        description: 'Demo-NFT, geminted aus dem NMKR Paywindow.',
        attributes: { rarity: 'demo', edition: 1 },
      },
      payment: {
        priceNight: MOCK_PRICE_NIGHT,
        recipients: MOCK_RECIPIENTS.map(addr => ({ address: addr, amountRaw: perRaw.toString() })),
      },
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (NMKR_STUDIO_KEY) headers['Authorization'] = `Bearer ${NMKR_STUDIO_KEY}`;
  const r = await fetch(`${NMKR_STUDIO_URL.replace(/\/$/, '')}/paywindow/${encodeURIComponent(id)}`, { headers });
  if (!r.ok) throw new Error(`Studio-Lookup HTTP ${r.status}`);
  return await r.json();
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store, max-age=0'); next(); });
app.use(express.static(path.join(__dirname, '..', 'web', 'public')));

// 1) Build unsealed mint tx — Frontend ruft das mit { id, buyerShieldedAddress } auf.
//    Antwort enthaelt nur Preview-Daten (Name + Image) — Metadaten kommen erst beim Reveal.
app.post('/api/build-mint', async (req, res) => {
  try {
    const { id, buyerShieldedAddress } = req.body ?? {};
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!buyerShieldedAddress?.startsWith('mn_shield-addr_')) {
      return res.status(400).json({ error: 'buyerShieldedAddress required' });
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

    const r = await fetch(`${NMKR_API_URL}/api/nft/build-unsealed-mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);

    res.json({
      unsealedTxHex: j.unsealedTxHex,
      bytes: j.bytes,
      tokenId: j.tokenId,
      contractAddress: j.contractAddress,
      preview: { name: pw.nft.name, image: pw.nft.image },
      priceNight: pw.payment?.priceNight ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2) Reveal-Metadaten — wird erst aufgerufen, nachdem die Wallet submittet hat.
//    Frontend muss die paymentTxHash mitgeben, damit ein Verifizierungs-Hook moeglich ist
//    (aktuell trivial; spaeter ggf. Indexer-Check).
app.post('/api/reveal-metadata', async (req, res) => {
  try {
    const { id } = req.body ?? {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const pw = await fetchPaywindow(id);
    res.json({
      name: pw.nft.name,
      image: pw.nft.image,
      uri: pw.nft.uri,
      mediaType: pw.nft.mediaType,
      description: pw.nft.description,
      attributes: pw.nft.attributes ?? {},
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`NMKR Midnight Paywindow listening on http://localhost:${PORT}`);
  console.log(`  NMKR API     : ${NMKR_API_URL}`);
  console.log(`  Studio       : ${PAYWINDOW_MOCK ? '[MOCK]' : NMKR_STUDIO_URL}`);
});
