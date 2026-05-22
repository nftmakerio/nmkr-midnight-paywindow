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

// Native NIGHT token type — 32 zero bytes (hex)
const NIGHT_TOKEN = '0000000000000000000000000000000000000000000000000000000000000000';

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

let connectedApi    = null;
let shieldedAddr    = null;
let unshieldedAddr  = null;
let paywindowOk     = false;
let walletOk        = false;
let backendOk       = false;
let paywindowInfo   = null;   // pre-flight response with recipients + totals

// ------------------------------------------------------------
// Timeline state machine: pending → active → done | failed.
// Each step also gets an optional sub-text line.
// ------------------------------------------------------------
function showTimeline(visible) {
  const el = $('timeline');
  el.classList.toggle('show', visible);
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}
function setStep(step, state, subText) {
  const el = document.querySelector(`.timeline-step[data-step="${step}"]`);
  if (!el) return;
  el.classList.remove('active', 'done', 'failed', 'skipped');
  if (state) el.classList.add(state);
  if (typeof subText === 'string') {
    el.querySelector('[data-sub]').textContent = subText;
  }
}
function failStep(step, subText) { setStep(step, 'failed', subText); }
function resetTimeline() {
  for (const step of ['start', 'night', 'confirm', 'mint', 'done']) {
    setStep(step, null, '');
  }
}

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

// Rewrite ipfs://<hash>[/<path>] to the NMKR HTTPS gateway so browsers
// (Chrome, Brave with native ipfs disabled, …) can fetch it. Anything
// that isn't an ipfs:// URL is returned unchanged.
const IPFS_GATEWAY = 'https://c-ipfs-gw.nmkr.io/ipfs/';
function ipfsToHttps(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) return uri;
  return IPFS_GATEWAY + uri.slice('ipfs://'.length);
}

function findProviders() {
  const root = window.midnight;
  if (!root) return [];
  return Object.entries(root)
    .filter(([_, api]) => typeof api?.connect === 'function')
    .map(([key, api]) => ({ key, api, name: api.name, rdns: api.rdns }));
}

function refreshButton() {
  $('mintBtn').disabled = !(paywindowOk && walletOk && backendOk);
  if (paywindowOk && walletOk && backendOk) setStatus('Ready to mint.');
}

// ------------------------------------------------------------
// Health check: probes the bridge's /api/health, which in turn
// probes nmkr-midnight-api and NMKR Studio. Fails fast with a clear
// message if any dependency is unreachable or misconfigured.
// ------------------------------------------------------------
async function checkBackends() {
  let info;
  try {
    info = await fetchJson(`${API}/health`);
  } catch (err) {
    // fetchJson throws on !res.ok — but our health endpoint returns the
    // diagnostic body even at 503. Re-fetch raw to get it.
    try {
      const raw = await fetch(`${API}/health`);
      info = await raw.json();
    } catch {
      setTitle('Service unavailable');
      setStatus(`Cannot reach the paywindow backend: ${err.message}`, true);
      return;
    }
  }
  console.log('[paywindow] health', info);

  const problems = [];
  if (!info.nmkrMidnightApi?.ok) {
    problems.push(`Midnight API: ${info.nmkrMidnightApi?.error ?? 'unreachable'}`);
  } else if (info.nmkrMidnightApi?.network && info.nmkrMidnightApi.network !== NETWORK) {
    problems.push(
      `Midnight API is running on "${info.nmkrMidnightApi.network}" ` +
      `but this paywindow targets "${NETWORK}". Set MIDNIGHT_NETWORK=${NETWORK} on the API service.`,
    );
  }
  if (!info.nmkrStudio?.ok) {
    problems.push(`NMKR Studio: ${info.nmkrStudio?.error ?? 'unreachable'}`);
  }

  if (problems.length) {
    setTitle('Service unavailable');
    setStatus(problems.join('\n'), true);
    return;
  }
  backendOk = true;
  refreshButton();
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
    paywindowInfo = info;
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
    // Unshielded address is needed for /api/wait-for-night-tx so the
    // bridge can scan the buyer's tx history for the NIGHT payment.
    try {
      const u = await connectedApi.getUnshieldedAddress();
      unshieldedAddr = u?.unshieldedAddress ?? u?.address ?? null;
    } catch (err) {
      console.warn('[paywindow] could not read unshielded address:', err);
    }

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
// Mint flow — two-tx pattern with timeline:
//   1. Start mint                            ← user clicks
//   2. Send NIGHT (1AM makeTransfer)         ← parallel: mint build on server
//   3. Confirm NIGHT on-chain                ← server polls address history
//   4. Build & submit mint                   ← balance + submit
//   5. Finished                              ← reveal NFT
// Step 2+3 are skipped for free-mints (no recipients).
// ------------------------------------------------------------
async function mint() {
  $('mintBtn').disabled = true;
  $('mintBtn').style.display = 'none';
  $('status').textContent = '';
  showTimeline(true);
  resetTimeline();

  const hasPayment = Boolean(paywindowInfo?.hasPayment);
  const recipients = paywindowInfo?.recipients || [];
  if (!hasPayment) {
    setStep('night',   'skipped', 'no payment configured');
    setStep('confirm', 'skipped', '');
  }

  try {
    // Step 1: Start
    setStep('start', 'active', 'preparing …');

    // Kick off the mint build on the server now — it can run in parallel
    // to the wallet's NIGHT-tx approval, so we don't waste minutes after
    // the user has signed.
    const mintBuildPromise = fetchJson(`${API}/build-mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: PAYWINDOW_ID, buyerShieldedAddress: shieldedAddr }),
    });

    setStep('start', 'done', '');

    // Step 2: NIGHT transfer
    if (hasPayment) {
      setStep('night', 'active', 'waiting for wallet approval …');
      const transferSpecs = recipients.map(r => ({
        kind: 'unshielded',
        type: NIGHT_TOKEN,
        value: BigInt(r.amountRaw),
        recipient: r.address,
      }));
      const transferResult = await connectedApi.makeTransfer(transferSpecs);
      const dappTxId = transferResult?.tx_id ?? transferResult?.txHash ?? null;
      if (transferResult?.tx || transferResult?.transaction) {
        // Wallet didn't auto-submit (rare) — submit ourselves
        await connectedApi.submitTransaction(transferResult.tx ?? transferResult.transaction);
      }
      setStep('night', 'done',
        dappTxId ? `1AM record ${dappTxId.slice(0, 12)}… (the real Sent tx will appear in the explorer)` : 'submitted');

      // Step 3: Confirm on-chain via server polling
      setStep('confirm', 'active', 'scanning chain (up to 2 min)…');
      if (!unshieldedAddr) {
        // Best effort: try to fetch it now if connectWallet didn't get it
        try {
          const u = await connectedApi.getUnshieldedAddress();
          unshieldedAddr = u?.unshieldedAddress ?? u?.address ?? null;
        } catch {}
      }
      if (!unshieldedAddr) throw new Error('Cannot confirm NIGHT tx: wallet did not expose its unshielded address');

      const confirmation = await fetchJson(`${API}/wait-for-night-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: PAYWINDOW_ID,
          buyerUnshieldedAddress: unshieldedAddr,
          maxWaitMs: 120_000,
        }),
      });
      const realTxHash = confirmation?.txHash ?? null;
      setStep('confirm', 'done',
        realTxHash ? `on-chain: ${realTxHash.slice(0, 16)}…` : 'confirmed');
    }

    // Step 4: Build & submit mint
    setStep('mint', 'active', 'waiting for server build …');
    const built = await mintBuildPromise;
    setStep('mint', 'active', `tx ready (${built.bytes} bytes) — waiting for wallet…`);
    const balanced = await connectedApi.balanceUnsealedTransaction(built.unsealedTxHex);
    const txHex = balanced?.tx ?? balanced?.transaction;
    if (!txHex) throw new Error('Wallet did not return a balanced transaction.');
    setStep('mint', 'active', 'submitting …');
    await connectedApi.submitTransaction(txHex);
    setStep('mint', 'done', `submitted, future tokenId=${built.tokenId}`);

    // Step 5: Done
    setStep('done', 'active', 'decrypting NFT …');
    await revealNft(built);
    setStep('done', 'done', '');
  } catch (err) {
    console.error('[paywindow] mint failed', err, {
      message: err?.message,
      status: err?.status,
      details: err?.details,
      shieldedAddress: shieldedAddr,
      unshieldedAddress: unshieldedAddr,
      walletAddressNetwork: addressNetwork(shieldedAddr),
      targetNetwork: NETWORK,
    });
    // Mark whichever step is currently active as failed.
    const activeStep = document.querySelector('.timeline-step.active');
    if (activeStep) {
      failStep(activeStep.dataset.step, err.message?.slice(0, 80) || 'failed');
    }
    let msg = `Error: ${err.message ?? err}`;
    if (err?.details) {
      const det = Array.isArray(err.details) ? err.details.join('\n') : String(err.details);
      msg += `\n\n${det}`;
    }
    setStatus(msg, true);
    $('mintBtn').disabled = false;
    $('mintBtn').style.display = '';
  }
}

async function revealNft(built) {
  const meta = await fetchJson(`${API}/reveal-metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PAYWINDOW_ID }),
  });

  $('nftImage').src = ipfsToHttps(meta.image);
  $('nftImage').alt = meta.name;
  $('nftName').textContent = meta.name;
  $('nftTokenId').textContent = built.tokenId ?? '?';
  $('nftContract').textContent = (built.contractAddress || '').slice(0, 20) + '…';
  $('nftDesc').textContent = meta.description || '';
  if (meta.uri) {
    $('nftUri').href = ipfsToHttps(meta.uri);
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
  // Three checks run in parallel; the Mint button unlocks only when
  // all three have passed (backend healthy, paywindow id valid, wallet
  // connected and on the matching network).
  checkBackends();
  validatePaywindow();
  connectWallet();
});
