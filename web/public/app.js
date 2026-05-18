// ============================================================
// NMKR Paywindow client
// - Liest ?id=... aus der URL
// - Verbindet 1AM automatisch (window.midnight.<id>.connect)
// - Mint-Button: build-mint -> balanceUnsealedTransaction -> submitTransaction
// - Reveal nach Erfolg: Image + Name; danach Metadaten on demand
// ============================================================

const NETWORK = 'preview';
const API = '/api';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const PAYWINDOW_ID = params.get('id');

const setStatus = (msg) => { $('status').textContent = msg; };
const setTitle  = (msg) => { $('title').textContent = msg; };

let connectedApi = null;
let shieldedAddr = null;

function findProviders() {
  const root = window.midnight;
  if (!root) return [];
  return Object.entries(root)
    .filter(([_, api]) => typeof api?.connect === 'function')
    .map(([key, api]) => ({ key, api, name: api.name, rdns: api.rdns }));
}

async function autoConnect() {
  if (!PAYWINDOW_ID) {
    setTitle('Fehler');
    setStatus('Kein ?id=… in der URL.');
    return;
  }

  let providers = findProviders();
  for (let i = 0; i < 8 && providers.length === 0; i++) {
    await new Promise(r => setTimeout(r, 350));
    providers = findProviders();
  }
  if (providers.length === 0) {
    setStatus('Keine Midnight-Wallet im Browser gefunden.');
    return;
  }

  const pick = providers.find(p => /1am|midnight/i.test(p.name + p.rdns)) ?? providers[0];
  setStatus(`verbinde mit ${pick.name} …`);
  try {
    connectedApi = await pick.api.connect(NETWORK);
    const s = await connectedApi.getShieldedAddresses();
    shieldedAddr = s.shieldedAddress;
    setStatus('bereit zum Minten');
    $('mintBtn').disabled = false;
  } catch (err) {
    setStatus(`Wallet-Verbindung fehlgeschlagen: ${err.message ?? err}`);
  }
}

async function mint() {
  $('mintBtn').disabled = true;
  setStatus('baue Mint-Tx auf dem Server …');
  try {
    const r = await fetch(`${API}/build-mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: PAYWINDOW_ID, buyerShieldedAddress: shieldedAddr }),
    });
    const built = await r.json();
    if (!r.ok) throw new Error(built.error || `HTTP ${r.status}`);

    setStatus('Wallet bestaetigen — Tx wird balanciert …');
    const balanced = await connectedApi.balanceUnsealedTransaction(built.unsealedTxHex);
    const txHex = balanced?.tx ?? balanced?.transaction;
    if (!txHex) throw new Error('Wallet hat keine tx zurueckgegeben');

    setStatus('Wallet bestaetigen — submitte Tx …');
    await connectedApi.submitTransaction(txHex);

    setStatus('Mint erfolgreich — entschluesselt NFT …');
    await revealNft(built);
  } catch (err) {
    setStatus(`Fehler: ${err.message ?? err}`);
    $('mintBtn').disabled = false;
  }
}

async function revealNft(built) {
  const r = await fetch(`${API}/reveal-metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PAYWINDOW_ID }),
  });
  const meta = await r.json();
  if (!r.ok) throw new Error(meta.error || `HTTP ${r.status}`);

  $('nftImage').src = meta.image;
  $('nftImage').alt = meta.name;
  $('nftName').textContent = meta.name;
  $('nftTokenId').textContent = built.tokenId ?? '?';
  $('nftContract').textContent = (built.contractAddress || '').slice(0, 20) + '…';
  $('nftMeta').textContent = JSON.stringify({
    uri: meta.uri,
    mediaType: meta.mediaType,
    description: meta.description,
    attributes: meta.attributes,
  }, null, 2);

  $('mintBtn').style.display = 'none';
  setStatus('');
  $('reveal').classList.add('show');
}

$('mintBtn').addEventListener('click', mint);
$('showMetaBtn').addEventListener('click', () => {
  const el = $('nftMeta');
  el.classList.toggle('show');
  $('showMetaBtn').textContent = el.classList.contains('show') ? 'Metadaten verbergen' : 'Metadaten anzeigen';
});

window.addEventListener('DOMContentLoaded', autoConnect);
