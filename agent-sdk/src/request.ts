import type { Address, Hex } from 'viem';

/**
 * The user operation fields an approval request carries, as hex strings, in the shape
 * ERC-4337 v0.7 bundlers take. The Haptix wallet adds the owner's two passkey signatures
 * and submits exactly this.
 */
export interface RequestUserOp {
  sender: Address;
  nonce: Hex;
  callData: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  verificationGasLimit: Hex;
  callGasLimit: Hex;
  preVerificationGas: Hex;
}

/**
 * What an agent hands its owner when the contract stops it. Version 1 is the format the
 * Haptix wallet reads (Agents → paste). Keep it byte-compatible.
 */
export interface ApprovalRequest {
  v: 1;
  chainId: number;
  account: Address;
  agent: Address;
  userOp: RequestUserOp;
  /** The agent's signature over the user operation hash. */
  agentSig: Hex;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

function fromBase64url(text: string): Uint8Array {
  const clean = text.trim();
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('Not a Haptix approval request.');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** The text the owner pastes into the wallet. */
export function encodeRequest(request: ApprovalRequest): string {
  return base64url(new TextEncoder().encode(JSON.stringify(request)));
}

export function decodeRequest(text: string): ApprovalRequest {
  let parsed: ApprovalRequest;
  try {
    const t = text.trim();
    parsed = JSON.parse(t.startsWith('{') ? t : new TextDecoder().decode(fromBase64url(t)));
  } catch {
    throw new Error('Not a Haptix approval request.');
  }
  if (parsed.v !== 1) throw new Error(`Unsupported approval request version ${String(parsed.v)}.`);
  return parsed;
}
