// ============================================================
// NMKR Paywindow client
// - Reads ?id=... from the URL
// - On load: validates the id against the bridge (GET /api/paywindow/:id)
//   and connects 1AM in parallel
// - Mint button only becomes active when BOTH succeed
// - On click: build-mint -> balanceUnsealedTransaction -> submitTransaction
// - On success: reveals image+name, then metadata on a separate click
// ============================================================

const NETWORK = 'preview';
const API = '/api';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PAYWINDOW_ID = params.get('id');

const setStatus = (msg, isError = false) => {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', Boolean(isError));
};
const setTitle = (msg) => { $('title').textContent = msg; };

// Format a raw NIGHT amount (atomic units, as a string from the server)
// as a human-readable "X NIGHT" / "X.YYY NIGHT" line. BigInt-safe so it
// works for amounts that exceed Number.MAX_SAFE_INTEGER.
function formatNight(rawString) {
  const raw = BigInt(rawString || '0');
  if (raw === 0n) return '';
  const whole = raw / 1_000_000n;
  const frac  = raw % 1_000_000n;
  if (frac === 0n) return `${whole} NIGHT`;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr} NIGHT`;
}

let connectedApi = null;
let shieldedAddr = null;
let paywindowOk  = false;
let walletOk     = false;

// ------------------------------------------------------------
// Robust JSON fetch: if the response is HTML (typical for misrouted
// requests, missing endpoints behind a reverse proxy, or login pages),
// surface a readable error instead of "Unexpected token '<'".
// ------------------------------------------------------------
async function fetchJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`Network error contacting ${url}: ${err.message}`);
  }
  const text = await res.text();
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const looksLikeJson = ct.includes('application/json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
  if (!looksLikeJson) {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`Expected JSON from ${url} but got ${ct || 'no content-type'} (HTTP ${res.status}). Body starts with: ${snippet}`);
  }
  let data;
  try { data = JSON.parse(text); }
  catch (err) { throw new Error(`Malformed JSON from ${url}: ${err.message}`); }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status} from ${url}`);
  }
  return data;
}

function findProviders() {
  const root = window.midnight;
  if (!root) return [];
  return Object.entries(root)
    .filter(([_, api]) => typeof api?.connect === 'function')
    .map(([key, api]) => ({ key, api, name: api.name, rdns: api.rdns }));
}

function refreshButton() {
  $('mintBtn').disabled = !(paywindowOk && walletOk);
  if (paywindowOk && walletOk) setStatus('Ready to mint.');
}

// ------------------------------------------------------------
// Pre-flight: validate the id against the bridge before doing anything else.
// ------------------------------------------------------------
async function validatePaywindow() {
  if (!PAYWINDOW_ID) {
    setTitle('Invalid link');
    setStatus('Missing ?id=… parameter in the URL.', true);
    return;
  }
  try {
    const info = await fetchJson(`${API}/paywindow/${encodeURIComponent(PAYWINDOW_ID)}`);
    paywindowOk = info.ok === true;
    $('price').textContent = formatNight(info.totalNightRaw);
    refreshButton();
  } catch (err) {
    setTitle('Cannot load paywindow');
    setStatus(err.message, true);
  }
}

// ------------------------------------------------------------
// Wallet auto-connect.
// ------------------------------------------------------------
async function connectWallet() {
  let providers = findProviders();
  for (let i = 0; i < 8 && providers.length === 0; i++) {
    await new Promise(r => setTimeout(r, 350));
    providers = findProviders();
  }
  if (providers.length === 0) {
    setStatus('No Midnight wallet detected in this browser.', true);
    return;
  }
  const pick = providers.find(p => /1am|midnight/i.test(p.name + p.rdns)) ?? providers[0];
  try {
    connectedApi = await pick.api.connect(NETWORK);
    const s = await connectedApi.getShieldedAddresses();
    shieldedAddr = s.shieldedAddress;
    walletOk = true;
    refreshButton();
  } catch (err) {
    setStatus(`Wallet connection failed: ${err.message ?? err}`, true);
  }
}

// ------------------------------------------------------------
// Mint flow.
// ------------------------------------------------------------
async function mint() {
  $('mintBtn').disabled = true;
  setStatus('Building mint transaction…');
  try {
    const built = await fetchJson(`${API}/build-mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: PAYWINDOW_ID, buyerShieldedAddress: shieldedAddr }),
    });

    setStatus('Confirm in your wallet — balancing transaction…');
    const balanced = await connectedApi.balanceUnsealedTransaction(built.unsealedTxHex);
    const txHex = balanced?.tx ?? balanced?.transaction;
    if (!txHex) throw new Error('Wallet did not return a balanced transaction.');

    setStatus('Confirm in your wallet — submitting transaction…');
    await connectedApi.submitTransaction(txHex);

    setStatus('Mint successful — decrypting NFT…');
    await revealNft(built);
  } catch (err) {
    setStatus(`Error: ${err.message ?? err}`, true);
    $('mintBtn').disabled = false;
  }
}

async function revealNft(built) {
  const meta = await fetchJson(`${API}/reveal-metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PAYWINDOW_ID }),
  });

  $('nftImage').src = meta.image;
  $('nftImage').alt = meta.name;
  $('nftName').textContent = meta.name;
  $('nftTokenId').textContent = built.tokenId ?? '?';
  $('nftContract').textContent = (built.contractAddress || '').slice(0, 20) + '…';
  $('nftDesc').textContent = meta.description || '';
  if (meta.uri) {
    $('nftUri').href = meta.uri;
    $('nftUri').style.display = '';
  } else {
    $('nftUri').style.display = 'none';
  }

  $('mintBtn').style.display = 'none';
  setStatus('');
  $('reveal').classList.add('show');
}

$('mintBtn').addEventListener('click', mint);

window.addEventListener('DOMContentLoaded', () => {
  // Run both in parallel — the button only unlocks when both succeed.
  validatePaywindow();
  connectWallet();
});
