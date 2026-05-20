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

// Format a raw NIGHT amount (atomic units, 1 NIGHT = 1_000_000)
// as a human-readable "X NIGHT" / "X.YYY NIGHT" line.
function formatNight(raw) {
  const n = Number(raw) || 0;
  if (n === 0) return '';
  const whole = Math.trunc(n / 1_000_000);
  const frac  = n % 1_000_000;
  if (frac === 0) return `${whole} NIGHT`;
  const fracStr = String(frac).padStart(6, '0').replace(/0+$/, '');
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
    // Surface server-side details (e.g. a stack snippet) so we don't drop
    // crucial context like "buyer address decode failed (network=preprod)".
    const err = new Error(data?.error || `HTTP ${res.status} from ${url}`);
    err.details = data?.details ?? data?.stack ?? null;
    err.status  = res.status;
    throw err;
  }
  return data;
}

// Pull the bech32m network prefix out of a Midnight address. Returns
// e.g. "preview", "preprod", "mainnet", or null if the address is malformed.
function addressNetwork(addr) {
  if (!addr) return null;
  // mn_addr_<network>1...  /  mn_shield-addr_<network>1...
  const m = /^mn_(?:shield-)?addr_([a-z0-9]+)1/.exec(addr);
  return m ? m[1] : null;
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

    // Verify the wallet is actually on the expected network — if the user
    // has 1AM set to e.g. preprod while the paywindow targets preview,
    // every later API call will fail with a confusing decode error. Catch
    // that here with a clear message.
    const walletNet = addressNetwork(shieldedAddr);
    console.log('[paywindow] wallet connected', {
      provider: pick.name,
      requestedNetwork: NETWORK,
      walletAddressNetwork: walletNet,
      shieldedAddress: shieldedAddr,
    });
    if (walletNet && walletNet !== NETWORK) {
      setStatus(
        `Wallet is on "${walletNet}" but this paywindow targets "${NETWORK}". ` +
        `Switch your Midnight wallet to ${NETWORK} and reload.`,
        true,
      );
      return;
    }
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
    // Print everything we know about the failure to the console so the
    // user can copy/paste the full chain — message + status + details.
    console.error('[paywindow] mint failed', err, {
      message: err?.message,
      status: err?.status,
      details: err?.details,
      shieldedAddress: shieldedAddr,
      walletAddressNetwork: addressNetwork(shieldedAddr),
      targetNetwork: NETWORK,
    });
    let msg = `Error: ${err.message ?? err}`;
    if (err?.details) {
      const det = Array.isArray(err.details) ? err.details.join('\n') : String(err.details);
      msg += `\n\n${det}`;
    }
    setStatus(msg, true);
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
