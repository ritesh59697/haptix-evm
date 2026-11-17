// Page provider (main world): EIP-1193 provider, announced with EIP-6963.
// It only relays to content.js; every decision is made inside the extension.
(() => {
  if (window.__haptixProvider) return;

  const TO_CONTENT = 'haptix-content';
  const FROM_CONTENT = 'haptix-inpage';
  const target = location.origin === 'null' ? '*' : location.origin;

  // The toolbar logo (src/ui.tsx Logo) in its light colors.
  const ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22"><rect width="22" height="22" rx="5" fill="rgb(23,24,26)"/>' +
    '<path d="M7 6v10M15 6v10M7 11.5c2.5-2 5.5-2 8 0" stroke="rgb(244,244,241)" stroke-width="2" stroke-linecap="round" fill="none"/>' +
    '<circle cx="17.5" cy="4.5" r="2.5" fill="rgb(255,90,31)"/></svg>',
  );
  // crypto.randomUUID only exists on https pages; getRandomValues works everywhere.
  const uuid = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const INFO = Object.freeze({ uuid: uuid(), name: 'Haptix', icon: ICON, rdns: 'xyz.haptixwallet' });

  class ProviderRpcError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const listeners = new Map();
  const pending = new Map();
  let nextId = 0;

  function emit(event, ...args) {
    for (const fn of listeners.get(event) ?? []) {
      try { fn(...args); } catch (e) { console.error('Haptix listener error', e); }
    }
  }

  function send(method, params) {
    const id = `h${++nextId}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ target: TO_CONTENT, id, method, params }, target);
    });
  }

  const provider = {
    isHaptix: true,
    chainId: null,
    selectedAddress: null,
    async request(args) {
      if (!args || typeof args.method !== 'string') throw new ProviderRpcError(-32602, 'request() needs { method, params }');
      const params = Array.isArray(args.params) ? args.params : args.params === undefined ? [] : [args.params];
      // Permissions are just accounts here.
      if (args.method === 'wallet_requestPermissions' || args.method === 'wallet_getPermissions') {
        const accounts = await send(args.method === 'wallet_requestPermissions' ? 'eth_requestAccounts' : 'eth_accounts', []);
        return accounts.length ? [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: accounts }] }] : [];
      }
      const result = await send(args.method, params);
      if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') setAccounts(result);
      return result;
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return provider;
    },
    removeListener(event, fn) {
      listeners.get(event)?.delete(fn);
      return provider;
    },
    // Legacy callers.
    enable() { return provider.request({ method: 'eth_requestAccounts' }); },
    isConnected() { return provider.chainId !== null; },
  };
  provider.off = provider.removeListener;

  function setAccounts(accounts) {
    const next = accounts[0] ?? null;
    if (next === provider.selectedAddress) return;
    provider.selectedAddress = next;
    emit('accountsChanged', accounts);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.target !== FROM_CONTENT) return;
    const { id, result, error, event, data } = e.data;
    if (event === 'accountsChanged') return setAccounts(data ?? []);
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new ProviderRpcError(error.code, error.message));
    else p.resolve(result);
  });

  Object.defineProperty(window, '__haptixProvider', { value: provider });
  // Don't replace another wallet's window.ethereum; EIP-6963 lets the site list both.
  if (!window.ethereum) window.ethereum = provider;

  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: INFO, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  send('eth_chainId', []).then((id) => {
    provider.chainId = id;
    emit('connect', { chainId: id });
  }, () => {});
})();
