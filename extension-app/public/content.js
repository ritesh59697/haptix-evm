// Content script (isolated world): carries requests from the page's provider (inpage.js)
// to the background worker, and answers back. It adds nothing about the page itself:
// the worker takes the site's origin from Chrome, not from this message.
// Message names match src/dapp/protocol.ts.
(() => {
  const TO_PAGE = 'haptix-inpage';
  const FROM_PAGE = 'haptix-content';
  const target = location.origin === 'null' ? '*' : location.origin;
  /** Requests waiting for the user: worker's request id -> the page's id. */
  const waiting = new Map();

  const toPage = (body) => window.postMessage({ target: TO_PAGE, ...body }, target);

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.target !== FROM_PAGE) return;
    const { id, method, params } = e.data;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'haptix:rpc', method, params });
      if (res && res.pending) waiting.set(res.pending, id);
      else if (res) toPage({ id, result: res.result, error: res.error });
      else toPage({ id, error: { code: -32603, message: 'Haptix did not answer.' } });
    } catch {
      // The extension was reloaded or updated under this page.
      toPage({ id, error: { code: 4900, message: 'Haptix was updated. Reload this page.' } });
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'haptix:result' && waiting.has(msg.id)) {
      const id = waiting.get(msg.id);
      waiting.delete(msg.id);
      toPage({ id, result: msg.result, error: msg.error });
    } else if (msg && msg.type === 'haptix:event') {
      toPage({ event: msg.event, data: msg.data });
    }
  });
})();
