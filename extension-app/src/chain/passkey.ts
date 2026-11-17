// WebAuthn passkeys, shaped for WebAuthn.sol. The checks this mirrors were tested
// live in tools/passkey-extension-test (Touch ID and phone, Robinhood testnet precompile).
import { bytesToHex, type Hex } from 'viem';

// Order of the P-256 curve. A property of the curve, used for the low-s rule.
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export type KeyKind = 'touchid' | 'security-key' | 'phone';

export interface StoredKey {
  credId: string; // base64url
  x: Hex;
  y: Hex;
  kind: KeyKind;
  label: string;
  /** Backup-eligible flag from the authenticator: the key can sync to other devices. */
  synced: boolean;
  transports: string[];
}

export interface Assertion {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: bigint;
  s: bigint;
}

export const b64url = (u8: Uint8Array) => {
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromB64url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

const rpId = () => location.hostname; // the extension ID inside the extension

const labels: Record<KeyKind, string> = { touchid: 'Touch ID', 'security-key': 'Security key', phone: 'Phone' };

/** Create a passkey and return what the account contract needs to know about it. */
export async function createKey(kind: KeyKind, exclude: StoredKey[] = []): Promise<StoredKey> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Haptix', id: rpId() },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `Haptix ${labels[kind]}`, displayName: `Haptix wallet (${labels[kind]})` },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 = P-256, the curve the chain verifies
      authenticatorSelection: {
        authenticatorAttachment: kind === 'touchid' ? 'platform' : 'cross-platform',
        residentKey: kind === 'security-key' ? 'discouraged' : 'required',
        userVerification: 'required',
      },
      // Steer Chrome's dialog straight to the right authenticator.
      ...(kind === 'phone' ? { hints: ['hybrid'] } : kind === 'security-key' ? { hints: ['security-key'] } : {}),
      excludeCredentials: exclude.map((k) => ({ type: 'public-key' as const, id: fromB64url(k.credId) })),
      attestation: 'none',
      timeout: 120000,
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created.');
  const res = cred.response as AuthenticatorAttestationResponse;
  const spki = new Uint8Array(res.getPublicKey()!);
  const point = spki.slice(-65);
  if (point[0] !== 0x04) throw new Error('The authenticator returned a key that is not P-256.');
  const authData = new Uint8Array(res.getAuthenticatorData());
  return {
    credId: cred.id,
    x: bytesToHex(point.slice(1, 33)),
    y: bytesToHex(point.slice(33, 65)),
    kind,
    label: labels[kind],
    synced: (authData[32] & 0x08) !== 0, // BE flag
    transports: res.getTransports?.() ?? [],
  };
}

function parseDer(der: Uint8Array) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('signature is not DER');
  i += der[i] & 0x80 ? (der[i] & 0x7f) + 1 : 1;
  if (der[i++] !== 0x02) throw new Error('DER: missing r');
  const rLen = der[i++];
  const r = BigInt(bytesToHex(der.slice(i, i + rLen)));
  i += rLen;
  if (der[i++] !== 0x02) throw new Error('DER: missing s');
  const sLen = der[i++];
  const s = BigInt(bytesToHex(der.slice(i, i + sLen)));
  return { r, s };
}

/** Sign a 32-byte challenge (the userOp hash) with one specific passkey. */
export async function sign(key: StoredKey, challenge: Hex): Promise<Assertion> {
  const a = (await navigator.credentials.get({
    publicKey: {
      challenge: Uint8Array.from(challenge.slice(2).match(/.{2}/g)!, (b) => parseInt(b, 16)),
      rpId: rpId(),
      allowCredentials: [{ type: 'public-key', id: fromB64url(key.credId), transports: key.transports as AuthenticatorTransport[] }],
      userVerification: 'required',
      timeout: 120000,
    },
  })) as PublicKeyCredential | null;
  if (!a) throw new Error('No signature was returned.');
  const res = a.response as AuthenticatorAssertionResponse;
  const cdBytes = new Uint8Array(res.clientDataJSON);
  const clientDataJSON = new TextDecoder().decode(cdBytes);
  // The contract takes byte offsets into clientDataJSON.
  const byteIndex = (needle: string) => {
    const at = clientDataJSON.indexOf(needle);
    if (at < 0) throw new Error(`clientDataJSON has no ${needle}`);
    return BigInt(new TextEncoder().encode(clientDataJSON.slice(0, at)).length);
  };
  let { r, s } = parseDer(new Uint8Array(res.signature));
  if (s > P256_N / 2n) s = P256_N - s; // WebAuthn.sol only accepts low-s
  return {
    authenticatorData: bytesToHex(new Uint8Array(res.authenticatorData)),
    clientDataJSON,
    challengeIndex: byteIndex('"challenge":"'),
    typeIndex: byteIndex('"type":"'),
    r,
    s,
  };
}
