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
// Two ways to open the paywindow:
//   ?id=<reservationid>     → direct (skip lookup)
//   ?projectuid=<uid>       → ask Studio for the next available
//                             reservation; reserved for THIS buyer
//                             (1AM's shielded address is forwarded
//                             as optionalreceiveraddress).
const RAW_ID      = params.get('id');
const PROJECT_UID = params.get('projectuid');
// The id we actually use everywhere — set either from RAW_ID directly
// or resolved from PROJECT_UID via /api/reservation-from-project.
let RESERVATION_ID = RAW_ID;

// Resolved once 1AM is connected and we have its shielded address.
// validatePaywindow awaits this on the ?projectuid= path so the
// Studio reservation goes to the right buyer.
let walletReady;
let resolveWalletReady;
walletReady = new Promise(r => { resolveWalletReady = r; });

// Remember which window.midnight provider we picked at connect time
// so we can auto-reconnect if 1AM's session expires later.
let walletPickedProvider = null;

// Tell whether an error looks like a "session expired" / "please
// reconnect" message from any of the known wallet providers.
function isExpiredError(err) {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  return /connection expired|please reconnect|session expired|not connected/i.test(msg);
}

// Reconnect to the same provider we used at boot. Refreshes
// connectedApi and the cached addresses.
async function reconnectWallet() {
  if (!walletPickedProvider) {
    const providers = findProviders();
    walletPickedProvider = providers.find(p => /1am|midnight/i.test(p.name + p.rdns)) ?? providers[0];
  }
  if (!walletPickedProvider) throw new Error('No Midnight wallet detected — cannot reconnect');
  trace(`reconnecting to wallet (${walletPickedProvider.name}) …`);
  connectedApi = await walletPickedProvider.api.connect(NETWORK);
  const s = await connectedApi.getShieldedAddresses();
  shieldedAddr = s.shieldedAddress;
  try {
    const u = await connectedApi.getUnshieldedAddress();
    unshieldedAddr = u?.unshieldedAddress ?? u?.address ?? null;
  } catch {}
  trace('wallet reconnected');
  return connectedApi;
}

// Run a wallet-API call; if 1AM says the session is expired, reconnect
// transparently and retry once. Used for makeTransfer, balanceUnsealed-
// Transaction, submitTransaction etc.
async function withWallet(fn) {
  try {
    return await fn(connectedApi);
  } catch (err) {
    if (!isExpiredError(err)) throw err;
    setStatus('Wallet session expired — reconnecting …');
    await reconnectWallet();
    setStatus('');
    return await fn(connectedApi);
  }
}

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
let paywindowInfo   = null;   // pre-flight response with recipients + totals + expires
let expiresAt       = null;   // Date object or null
let mintStarted     = false;  // true once user clicked Mint — cancels not sent after this
let mintFinished    = false;  // true once we've notified Studio of an outcome

// ------------------------------------------------------------
// Log buffer — everything that logs() in the page also accumulates here
// so we can ship it to Studio as the "log" field on update.
// ------------------------------------------------------------
const mintLog = [];
function trace(msg) {
  const ts = new Date().toISOString();
  mintLog.push(`[${ts}] ${msg}`);
  if (mintLog.length > 500) mintLog.splice(0, mintLog.length - 500);
  console.log(`[paywindow] ${msg}`);
}
function getLog() { return mintLog.join('\n'); }

// ------------------------------------------------------------
// Notify NMKR Studio about the outcome of this paywindow attempt.
// updateType ∈ TransactionSuccessfully | TransactionFailed |
//              PartialError | CancelTransaction | TimeoutTransaction
// ------------------------------------------------------------
async function notifyStudio(updateType, extras = {}) {
  if (mintFinished) return;
  if (!RESERVATION_ID) return;
  mintFinished = true;
  const body = {
    updateType,
    receiverAddress: shieldedAddr ?? '',
    log: getLog(),
    ...extras,
  };
  trace(`notify studio: ${updateType}`);
  try {
    await fetch(`${API}/paywindow/${encodeURIComponent(RESERVATION_ID)}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,   // survives page unload
    });
  } catch (err) {
    console.warn('[paywindow] notifyStudio failed:', err);
  }
}

// Best-effort send on browser close — sendBeacon survives unload.
function sendBeaconUpdate(updateType, extras = {}) {
  if (mintFinished || !RESERVATION_ID) return;
  mintFinished = true;
  const body = JSON.stringify({
    updateType,
    receiverAddress: shieldedAddr ?? '',
    log: getLog(),
    ...extras,
  });
  const url = `${API}/paywindow/${encodeURIComponent(RESERVATION_ID)}/update`;
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
  }
}

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
  const expired = isExpired();
  // Mint button only needs the paywindow data and a connected wallet
  // — plus the reservation must not be expired.
  $('mintBtn').disabled = !(paywindowOk && walletOk && !expired);
  if (expired) {
    setStatus('Reservation expired — cannot mint anymore.', true);
  } else if (paywindowOk && walletOk) {
    setStatus('Ready to mint.');
  }
}

function isExpired() {
  return Boolean(expiresAt && expiresAt.getTime() <= Date.now());
}

// Render a live countdown to expires. Switches the line to warning
// color in the last minute and to expired/red when the deadline is hit.
let expiresTimer = null;
function startExpiresTimer() {
  if (expiresTimer) clearInterval(expiresTimer);
  const el = $('expires');
  const tick = () => {
    if (!expiresAt) { el.textContent = ''; return; }
    const ms = expiresAt.getTime() - Date.now();
    if (ms <= 0) {
      el.textContent = `Expired at ${expiresAt.toLocaleTimeString()}`;
      el.className = 'expires expired';
      clearInterval(expiresTimer);
      expiresTimer = null;
      // If the user is mid-mint we can't undo, but block any further
      // attempts and tell Studio.
      if (!mintStarted) {
        refreshButton();
      } else if (!mintFinished) {
        notifyStudio('TimeoutTransaction', { log: getLog() });
      }
      return;
    }
    const totalSec = Math.floor(ms / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    el.textContent = `Reservation expires in ${mm}:${String(ss).padStart(2, '0')}`;
    el.className = ms < 60_000 ? 'expires warning' : 'expires';
  };
  tick();
  expiresTimer = setInterval(tick, 1000);
}

// ------------------------------------------------------------
// Advisory health check — logs the bridge's view of nmkr-midnight-api +
// Studio to the console for diagnostics. It does NOT block the mint
// button: the pre-flight (validatePaywindow) is the real readiness
// signal, and any backend issue that affects minting will surface
// during the flow with a meaningful error in the timeline.
// ------------------------------------------------------------
async function checkBackends() {
  try {
    const raw = await fetch(`${API}/health`);
    const info = await raw.json();
    console.log('[paywindow] health', info);
    // Only escalate the explicit case where the API runs on the wrong
    // Midnight network — that's a configuration mismatch that the user
    // CAN fix and pre-flight wouldn't catch.
    if (info.nmkrMidnightApi?.ok &&
        info.nmkrMidnightApi?.network &&
        info.nmkrMidnightApi.network !== NETWORK) {
      console.warn(
        `[paywindow] Midnight API runs on "${info.nmkrMidnightApi.network}" ` +
        `but this paywindow targets "${NETWORK}".`,
      );
    }
  } catch (err) {
    console.warn('[paywindow] health check failed:', err);
  }
}

// ------------------------------------------------------------
// Pre-flight: validate the id against the bridge before doing anything else.
// ------------------------------------------------------------
async function validatePaywindow() {
  if (!RAW_ID && !PROJECT_UID) {
    setTitle('Invalid link');
    setStatus('Missing ?id=… or ?projectuid=… parameter in the URL.', true);
    return;
  }
  try {
    // Step 0 (only on the ?projectuid= path): wait for the wallet
    // connection so we have the buyer's shielded address, then ask
    // NMKR Studio to reserve an NFT specifically for that address.
    // Without the receiver Studio would return some random pool entry
    // that doesn't match the actual buyer.
    if (!RESERVATION_ID && PROJECT_UID) {
      setStatus('Waiting for wallet …');
      await walletReady;
      if (!shieldedAddr) {
        throw new Error('Wallet did not provide a shielded address; cannot reserve NFT.');
      }
      setStatus('Reserving an NFT for your wallet …');
      const resolveUrl = `${API}/reservation-from-project/${encodeURIComponent(PROJECT_UID)}` +
                        `?receiver=${encodeURIComponent(shieldedAddr)}`;
      const r = await fetchJson(resolveUrl);
      RESERVATION_ID = r.reservationid;
      console.log('[paywindow] resolved project UID to reservation', {
        projectUid: PROJECT_UID,
        receiver: shieldedAddr,
        reservationid: RESERVATION_ID,
        paymentAddress: r.paymentAddress,
        expires: r.expires,
        currency: r.currency,
      });
    }

    const info = await fetchJson(`${API}/paywindow/${encodeURIComponent(RESERVATION_ID)}`);
    paywindowOk = info.ok === true;
    paywindowInfo = info;
    $('price').textContent = formatNight(info.totalNightRaw);
    if (info.expires) {
      const parsed = new Date(info.expires);
      if (!isNaN(parsed.getTime())) {
        expiresAt = parsed;
        trace(`reservation expires at ${expiresAt.toISOString()}`);
        startExpiresTimer();
      }
    }
    refreshButton();
  } catch (err) {
    setTitle('Cannot load paywindow');
    // Surface the Studio error message verbatim — e.g. "no more NFTs"
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
  walletPickedProvider = pick;
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
    resolveWalletReady();
  } catch (err) {
    setStatus(`Wallet connection failed: ${err.message ?? err}`, true);
    // Resolve anyway so validatePaywindow can fail with a useful error
    // instead of hanging forever waiting for a wallet that never came.
    resolveWalletReady();
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
  // Refuse if the reservation has already expired.
  if (isExpired()) {
    setStatus('Reservation expired — cannot mint anymore.', true);
    notifyStudio('TimeoutTransaction', { log: getLog() });
    return;
  }

  mintStarted = true;
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

  // Track what's already on-chain so we can pick the right update type
  // when something later fails.
  let nightOnChainTxHash = null;
  let mintedTokenId      = null;
  trace(`mint started: paywindow=${RESERVATION_ID} buyer=${shieldedAddr.slice(0, 35)}… hasPayment=${hasPayment}`);

  try {
    // Step 1: Start
    setStep('start', 'active', 'preparing …');

    // Kick off the mint build on the server now — it can run in parallel
    // to the wallet's NIGHT-tx approval, so we don't waste minutes after
    // the user has signed.
    const mintBuildPromise = fetchJson(`${API}/build-mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: RESERVATION_ID, buyerShieldedAddress: shieldedAddr }),
    });

    setStep('start', 'done', '');

    // Step 2: NIGHT transfer
    if (hasPayment) {
      setStep('night', 'active', 'waiting for wallet approval …');
      // Same call shape as the working dapp-demo Button 6.
      const transferSpecs = recipients.map(r => ({
        kind: 'unshielded',
        type: NIGHT_TOKEN,
        value: BigInt(r.amountRaw),
        recipient: r.address,
      }));
      // Dump exactly what we'll pass to the wallet — so when 1AM throws
      // an unhelpful error we can see whether it's our payload or theirs.
      console.log('[paywindow] makeTransfer specs:',
        transferSpecs.map(s => ({ ...s, value: s.value?.toString?.() })));
      console.log('[paywindow] paywindowInfo.recipients:', paywindowInfo?.recipients);
      if (transferSpecs.length === 0) {
        throw new Error(
          `No NIGHT recipients to send to — paywindowInfo.recipients is ${JSON.stringify(paywindowInfo?.recipients)}. ` +
          `The bridge's /api/paywindow/:id response is missing the recipients field. ` +
          `Check that NMKR Studio's GetMidnightPaywindowDetails response includes 'recipients'.`,
        );
      }
      let transferResult;
      try {
        transferResult = await withWallet(api => api.makeTransfer(transferSpecs));
      } catch (err) {
        console.error('[paywindow] makeTransfer failed', err, { transferSpecs });
        throw err;
      }
      const dappTxId = transferResult?.tx_id ?? transferResult?.txHash ?? null;
      if (transferResult?.tx || transferResult?.transaction) {
        // Wallet didn't auto-submit (rare) — submit ourselves
        await withWallet(api => api.submitTransaction(transferResult.tx ?? transferResult.transaction));
      }
      setStep('night', 'done',
        dappTxId ? `1AM record ${dappTxId.slice(0, 12)}… (the real Sent tx will appear in the explorer)` : 'submitted');

      // Step 3: Confirm on-chain via server polling
      setStep('confirm', 'active', 'scanning chain (up to 2 min)…');
      if (!unshieldedAddr) {
        // Best effort: try to fetch it now if connectWallet didn't get it
        try {
          const u = await withWallet(api => api.getUnshieldedAddress());
          unshieldedAddr = u?.unshieldedAddress ?? u?.address ?? null;
        } catch {}
      }
      if (!unshieldedAddr) throw new Error('Cannot confirm NIGHT tx: wallet did not expose its unshielded address');

      const confirmation = await fetchJson(`${API}/wait-for-night-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: RESERVATION_ID,
          buyerUnshieldedAddress: unshieldedAddr,
          recipients: paywindowInfo?.recipients ?? [],
          maxWaitMs: 120_000,
        }),
      });
      nightOnChainTxHash = confirmation?.txHash ?? null;
      setStep('confirm', 'done',
        nightOnChainTxHash ? `on-chain: ${nightOnChainTxHash.slice(0, 16)}…` : 'confirmed');
      trace(`NIGHT confirmed on-chain: ${nightOnChainTxHash}`);
    }

    // Step 4: Build & submit mint
    setStep('mint', 'active', 'waiting for server build …');
    const built = await mintBuildPromise;
    setStep('mint', 'active', `tx ready (${built.bytes} bytes) — waiting for wallet…`);
    const balanced = await withWallet(api => api.balanceUnsealedTransaction(built.unsealedTxHex));
    const txHex = balanced?.tx ?? balanced?.transaction;
    if (!txHex) throw new Error('Wallet did not return a balanced transaction.');
    setStep('mint', 'active', 'submitting …');
    await withWallet(api => api.submitTransaction(txHex));
    mintedTokenId = built.tokenId ?? null;
    setStep('mint', 'done', `submitted, future tokenId=${mintedTokenId}`);
    trace(`mint submitted: tokenId=${mintedTokenId}`);

    // Step 5: Done — notify Studio of success then reveal.
    setStep('done', 'active', 'decrypting NFT …');
    await notifyStudio('TransactionSuccessfully', {
      mintToken: String(mintedTokenId ?? ''),
      nightTransactionId: nightOnChainTxHash ?? '',
      receiverAddress: shieldedAddr,
    });
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
    trace(`mint failed: ${err?.message ?? err}`);

    // Decide which update type fits the failure point:
    //  - NIGHT already on-chain + mint failed → PartialError (user paid, no NFT)
    //  - NIGHT didn't go through                 → TransactionFailed
    const updateType = nightOnChainTxHash ? 'PartialError' : 'TransactionFailed';
    notifyStudio(updateType, {
      mintToken: String(mintedTokenId ?? ''),
      nightTransactionId: nightOnChainTxHash ?? '',
      receiverAddress: shieldedAddr,
    }).catch(() => {});

    let msg = `Error: ${err.message ?? err}`;
    if (err?.details) {
      const det = Array.isArray(err.details) ? err.details.join('\n') : String(err.details);
      msg += `\n\n${det}`;
    }
    setStatus(msg, true);
    // For PartialError the wallet already paid — re-enable mint would
    // let the user pay again, which is wrong. So we only re-enable on
    // a clean TransactionFailed (NIGHT did not go through).
    if (updateType === 'TransactionFailed') {
      $('mintBtn').disabled = false;
      $('mintBtn').style.display = '';
    }
  }
}

async function revealNft(built) {
  const meta = await fetchJson(`${API}/reveal-metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: RESERVATION_ID }),
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

// If the user closes the tab/window without clicking Mint, release the
// reservation so the NFT goes back to the drop pool. sendBeacon survives
// the unload event. We don't send this once mint has been kicked off —
// any subsequent failure will be reported as TransactionFailed/PartialError
// from the mint flow itself.
window.addEventListener('pagehide', (e) => {
  if (mintStarted || mintFinished) return;
  sendBeaconUpdate('CancelTransaction', { log: getLog() });
});
window.addEventListener('beforeunload', (e) => {
  if (mintStarted || mintFinished) return;
  sendBeaconUpdate('CancelTransaction', { log: getLog() });
});
