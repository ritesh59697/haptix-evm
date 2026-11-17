/** A JSON-RPC error from a node or bundler, with its code and data kept. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}`);
    this.name = 'RpcError';
  }
}

let nextId = 0;

export type Fetch = typeof fetch;

export async function rpc<T>(fetchFn: Fetch, url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
  });
  if (!res.ok) throw new RpcError(method, `HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string; data?: unknown } };
  if (body.error) throw new RpcError(method, body.error.message ?? 'error', body.error.code, body.error.data);
  return body.result as T;
}
