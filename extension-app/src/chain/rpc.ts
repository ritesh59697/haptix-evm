// Minimal JSON-RPC client for the chain node and the ERC-4337 bundler.
let nextId = 0;

export class RpcError extends Error {
  constructor(method: string, message: string, public code?: number, public data?: unknown) {
    super(`${method}: ${message}`);
    this.name = 'RpcError';
  }
}

export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new RpcError(method, `the server rejected the API key (HTTP ${res.status}). Check the Bundler URL in Security.`, res.status);
  }
  if (!res.ok) throw new RpcError(method, `HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new RpcError(method, body.error.message ?? 'unknown error', body.error.code, body.error.data);
  return body.result as T;
}
