// Headless check of the extension's site bridge: EIP-6963 discovery, connect approval,
// read calls, refusals, a transaction request reaching the approval screen and being
// rejected, and message signing with a virtual passkey, verified against the chain
// (ERC-1271 through ERC-6492, since the test account is never deployed). Nothing is sent.
//
//   cd extension-app && npm run build && cd .. && node tools/test-dapp/e2e.mjs
//
// The wallet account is a stand-in written to the extension's storage; set
// HAPTIX_E2E_ACCOUNT to use a real address (its balance is read from the chain).
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'extension-app/dist');
const site = process.env.HAPTIX_E2E_SITE ?? 'http://haptix-e2e.test';
const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
// The same networks/*.env file the build used (extension-app/package.json names it).
const pkg = JSON.parse(readFileSync(join(root, 'extension-app/package.json'), 'utf8'));
const netFile = resolve(root, 'extension-app', process.env.HAPTIX_NETWORK_FILE ?? pkg.scripts.build.match(/HAPTIX_NETWORK_FILE=(\S+)/)[1]);
const netEnv = Object.fromEntries(
  readFileSync(netFile, 'utf8').split('\n').map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const viem = createRequire(join(root, 'extension-app/package.json'))('viem');
const account = process.env.HAPTIX_E2E_ACCOUNT ?? '0x' + '11'.repeat(20);
// Set HAPTIX_E2E_SHOTS to a folder to save screenshots of the approval screens.
const shots = process.env.HAPTIX_E2E_SHOTS;
const shot = (p, name) => (shots ? p.screenshot({ path: join(shots, `${name}.png`) }) : null);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'haptix-e2e-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check('extension loads with a worker', !!extId, { extId, name: manifest.name });

  await ctx.route(`${site}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  await page.goto(`${site}/`);
  const req = (method, params = []) =>
    page.evaluate(async ([method, params]) => {
      try {
        return { result: await window.__haptixProvider.request({ method, params }) };
      } catch (e) {
        return { error: { code: e.code, message: e.message } };
      }
    }, [method, params]);

  const announced = await page.evaluate(() => new Promise((ok) => {
    window.addEventListener('eip6963:announceProvider', (e) => ok(e.detail.info), { once: true });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }));
  check('announces itself over EIP-6963', announced.name === 'Haptix', announced.rdns);

  // The chain comes from the build's networks/*.env; storage keys are scoped by it.
  const chainId = await req('eth_chainId');
  check('eth_chainId answers', /^0x[0-9a-f]+$/.test(chainId.result ?? ''), chainId);
  const network = { chainId: Number(BigInt(chainId.result)) };
  await sw.evaluate(async ({ chainId, address }) => {
    await chrome.storage.local.set({
      [`haptix.account.${chainId}`]: { address, salt: '0x' + '00'.repeat(32), thresholdWei: '1000000000000000', keys: [], createdAt: Date.now() },
    });
  }, { chainId: network.chainId, address: account });
  check('eth_accounts is empty before connecting', (await req('eth_accounts')).result?.length === 0);
  const block = await req('eth_blockNumber');
  check('reads go to the chain RPC', /^0x[0-9a-f]+$/.test(block.result ?? ''), block);
  const sign = await req('personal_sign', ['0x68656c6c6f', account]);
  check('signing before connecting fails with 4100', sign.error?.code === 4100, sign.error);
  const sw1 = await req('wallet_switchEthereumChain', [{ chainId: '0x1' }]);
  check('switching to another chain fails with 4902', sw1.error?.code === 4902, sw1.error);
  const send0 = await req('eth_sendTransaction', [{ to: account, value: '0x1' }]);
  check('a transaction before connecting fails with 4100', send0.error?.code === 4100, send0.error);

  // Connect: the request waits for the wallet.
  const connecting = req('eth_requestAccounts');
  const popupUrl = `chrome-extension://${extId}/index.html`;
  const queued = async () => sw.evaluate((k) => chrome.storage.session.get(k).then((v) => v[k] ?? []), `haptix.dappRequests.${network.chainId}`);
  await page.waitForTimeout(500);
  const q1 = await queued();
  check('connect request is queued with the real origin', q1.length === 1 && q1[0].origin === site, q1.map((r) => r.origin));

  let popup = await ctx.newPage();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(popupUrl);
  await popup.getByRole('heading', { name: /Connect to/ }).waitFor();
  await shot(popup, 'connect');
  check('popup opens on the connect request', true);
  await popup.getByRole('button', { name: 'Connect', exact: true }).click();
  const connected = await connecting;
  check('approving returns the account to the site', connected.result?.[0]?.toLowerCase() === account.toLowerCase(), connected);
  check('eth_accounts now has the account', (await req('eth_accounts')).result?.[0]?.toLowerCase() === account.toLowerCase());
  check('queue is empty after the decision', (await queued()).length === 0);

  // A transaction request shows what it does and can be rejected.
  const sending = req('eth_sendTransaction', [{ from: account, to: account, value: '0x5af3107a4000', data: '0x' }]);
  await page.waitForTimeout(500);
  popup = await ctx.newPage();
  await popup.goto(popupUrl);
  await popup.getByRole('heading', { name: /^Send / }).waitFor();
  const title = await popup.getByRole('heading').first().textContent();
  check('transaction screen decodes the send', /0\.0001/.test(title ?? ''), title);
  await popup.getByRole('button', { name: 'Reject' }).click();
  const rejected = await sending;
  check('rejecting returns 4001 to the site', rejected.error?.code === 4001, rejected.error);

  // An unlimited approval is flagged and needs both keys.
  const approving = req('eth_sendTransaction', [{ to: account, data: '0x095ea7b3' + account.slice(2).padStart(64, '0') + 'f'.repeat(64) }]);
  await page.waitForTimeout(500);
  popup = await ctx.newPage();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(popupUrl);
  await popup.getByText('Unlimited').waitFor();
  await shot(popup, 'approve-unlimited');
  const bothKeys = await popup.getByText('Needs both keys').count();
  check('unlimited approval shows "Unlimited" and needs both keys', bothKeys === 1);
  await popup.getByRole('button', { name: 'Reject' }).click();
  check('rejected approval returns 4001', (await approving).error?.code === 4001);

  // --- Signing with a virtual passkey -------------------------------------
  // A P-256 key made here, enrolled as the account's Touch ID key, and handed to a
  // virtual authenticator on each wallet page.
  const makeKey = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const hex = (b64) => '0x' + Buffer.from(b64, 'base64url').toString('hex');
    const credId = randomBytes(16);
    return {
      pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      credIdB64: credId.toString('base64'),
      stored: { credId: credId.toString('base64url'), x: hex(jwk.x), y: hex(jwk.y), kind: 'touchid', label: 'Touch ID', synced: false, transports: ['internal'] },
    };
  };
  const k1 = makeKey();
  const k2raw = makeKey();
  const k2 = { ...k2raw, stored: { ...k2raw.stored, kind: 'security-key', label: 'Security key', transports: ['internal'] } };
  const client = viem.createPublicClient({ transport: viem.http(netEnv.RPC_URL) });
  const factoryAbi = viem.parseAbi([
    'struct PublicKey { uint256 x; uint256 y; }',
    'function getAddress(PublicKey[] initialSigners, uint256 threshold, bytes32 salt) view returns (address)',
  ]);
  const salt = '0x' + randomBytes(32).toString('hex');
  const thresholdWei = '1000000000000000';
  const signer = await client.readContract({
    address: netEnv.FACTORY_ADDRESS, abi: factoryAbi, functionName: 'getAddress',
    args: [[k1.stored, k2.stored].map((k) => ({ x: BigInt(k.x), y: BigInt(k.y) })), BigInt(thresholdWei), salt],
  });
  await sw.evaluate(async ({ chainId, acct }) => {
    await chrome.storage.local.set({ [`haptix.account.${chainId}`]: acct });
  }, { chainId: network.chainId, acct: { address: signer, salt, thresholdWei, keys: [k1.stored, k2.stored], createdAt: Date.now() } });

  const walletPage = async (name, url = popupUrl) => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 360, height: 600 });
    await p.goto(url);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    for (const k of [k1, k2]) {
      await cdp.send('WebAuthn.addCredential', {
        authenticatorId,
        credential: { credentialId: k.credIdB64, isResidentCredential: false, rpId: `chrome-extension://${extId}`, privateKey: k.pkcs8, signCount: 0 },
      });
    }
    await p.getByRole('heading', { name }).waitFor();
    await p.bringToFront(); // WebAuthn only runs in the focused page
    return p;
  };

  const text = 'Sign in to haptix-e2e.test';
  const signing = req('personal_sign', [viem.toHex(text), signer]);
  await page.waitForTimeout(500);
  popup = await walletPage(/Sign this message/);
  check('sign screen shows the message as text', (await popup.getByText(text).count()) === 1);
  await shot(popup, 'sign-message');
  await popup.getByRole('button', { name: /Sign with Touch ID/ }).click();
  const sig = await signing;
  check('personal_sign returns an ERC-6492 signature', sig.result?.endsWith('6492'.repeat(16)), sig.error ?? sig.result?.slice(-12));
  if (sig.result) {
    const ok = await client.verifyMessage({ address: signer, message: text, signature: sig.result });
    check('the chain accepts the personal_sign signature', ok);
  }

  const typedData = {
    domain: { name: 'Haptix E2E', version: '1', chainId: network.chainId, verifyingContract: '0x' + '22'.repeat(20) },
    types: { Login: [{ name: 'user', type: 'address' }, { name: 'nonce', type: 'uint256' }] },
    primaryType: 'Login',
    message: { user: signer, nonce: '7' },
  };
  const typing = req('eth_signTypedData_v4', [signer, JSON.stringify({ ...typedData, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...typedData.types } })]);
  await page.waitForTimeout(500);
  popup = await walletPage(/Sign this message/);
  check('typed data hands off to the side panel for both keys', (await popup.getByRole('button', { name: /Sign in side panel/ }).count()) === 1);
  await popup.close();
  popup = await walletPage(/Sign this message/, `chrome-extension://${extId}/sidepanel.html`);
  await popup.getByRole('button', { name: /Sign with both keys/ }).click();
  const tsig = await typing;
  if (tsig.result) {
    const ok = await client.verifyTypedData({ address: signer, ...typedData, message: { ...typedData.message, nonce: 7n }, signature: tsig.result });
    check('the chain accepts the typed-data signature', ok);
  } else check('typed-data signing returns a signature', false, tsig.error);

  const wrongChain = await req('eth_signTypedData_v4', [signer, JSON.stringify({ ...typedData, domain: { ...typedData.domain, chainId: 1 } })]);
  check('typed data for another chain is refused', wrongChain.error?.code === -32602, wrongChain.error);

  const permitting = req('eth_signTypedData_v4', [signer, JSON.stringify({
    domain: typedData.domain,
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit',
    message: { owner: signer, spender: '0x' + '33'.repeat(20), value: '1', nonce: '0', deadline: '1' },
  })]);
  await page.waitForTimeout(500);
  popup = await walletPage(/Sign a token approval/);
  check('a permit is flagged and needs both keys', (await popup.getByText(/needs both keys/).count()) === 1);
  await shot(popup, 'sign-permit');
  await popup.getByRole('button', { name: 'Reject' }).click();
  check('rejected permit returns 4001', (await permitting).error?.code === 4001);
  check('eth_sign stays unsupported', (await req('eth_sign', [signer, '0x' + '00'.repeat(32)])).error?.code === 4200);

  // Disconnecting from Security hides the account again.
  await sw.evaluate((k) => chrome.storage.local.set({ [k]: {} }), `haptix.sites.${network.chainId}`);
  check('after disconnect eth_accounts is empty', (await req('eth_accounts')).result?.length === 0);
} finally {
  await ctx.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
