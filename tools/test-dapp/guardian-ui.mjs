// Headless check of restoring on a new device and the guardian page, against the live
// chain. Virtual authenticators stand in for Touch ID and a security key. Nothing is sent.
//
//   cd extension-app && npm run build && cd .. && node tools/test-dapp/guardian-ui.mjs [account]
//
// [account] defaults to the scripts/chain-e2e.mjs account (read from .haptix-e2e/).
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'extension-app/dist');
const viem = createRequire(join(root, 'extension-app/package.json'))('viem');
const pkg = JSON.parse(readFileSync(join(root, 'extension-app/package.json'), 'utf8'));
const netFile = resolve(root, 'extension-app', process.env.HAPTIX_NETWORK_FILE ?? pkg.scripts.build.match(/HAPTIX_NETWORK_FILE=(\S+)/)[1]);
const net = Object.fromEntries(readFileSync(netFile, 'utf8').split('\n').map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
const shots = process.env.HAPTIX_E2E_SHOTS;

// The chain-e2e account: deployed, and its guardian state is whatever the live chain says.
const e2e = JSON.parse(readFileSync(join(root, '.haptix-e2e', `${net.CHAIN_ID}-${net.FACTORY_ADDRESS.toLowerCase()}.json`), 'utf8'));
const client = viem.createPublicClient({ transport: viem.http(net.RPC_URL) });
const target = process.argv[2] ?? await client.readContract({
  address: net.FACTORY_ADDRESS,
  abi: viem.parseAbi(['struct PublicKey { uint256 x; uint256 y; }', 'function getAddress(PublicKey[] s, uint256 t, bytes32 salt) view returns (address)']),
  functionName: 'getAddress',
  args: [e2e.signers.map((j) => ({ x: BigInt('0x' + Buffer.from(j.x, 'base64url').toString('hex')), y: BigInt('0x' + Buffer.from(j.y, 'base64url').toString('hex')) })), BigInt(e2e.threshold), e2e.salt],
});
const guardianOnChain = await client.readContract({ address: target, abi: viem.parseAbi(['function guardian() view returns (address)']), functionName: 'guardian' });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'haptix-guard-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const chainId = Number(net.CHAIN_ID);

  // A fresh device: no account. The popup hands Restore to the side panel.
  await sw.evaluate((k) => chrome.storage.session.set({ [k]: { name: 'restore' } }), `haptix.panelRoute.${chainId}`);
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 700 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  const cdp = await ctx.newCDPSession(panel);
  await cdp.send('WebAuthn.enable');
  for (const transport of ['internal', 'usb']) {
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  }
  await panel.bringToFront();
  await panel.getByRole('heading', { name: 'Restore an account' }).waitFor();

  await panel.getByPlaceholder('0x…').fill('0x' + '12'.repeat(20));
  await panel.getByRole('button', { name: 'Continue' }).click();
  check('an address with no account is refused', /no account at that address/.test(await panel.getByRole('alert').textContent()));

  await panel.getByPlaceholder('0x…').fill(target);
  await panel.getByRole('button', { name: 'Continue' }).click();
  if (guardianOnChain === viem.zeroAddress) {
    const msg = await panel.getByRole('alert').textContent();
    check('an account without a guardian is refused', /no guardian/.test(msg), msg);
    console.log(`\n(${target} has no guardian on chain, so the rest of the restore can't run against it.)`);
  } else {
    await panel.getByRole('button', { name: /Create with Touch ID/ }).click();
    await panel.getByRole('heading', { name: 'Now a second key' }).waitFor();
    await panel.getByRole('button', { name: 'Security key' }).click();
    await panel.getByRole('heading', { name: 'Send this to your guardian' }).waitFor();
    if (shots) await panel.screenshot({ path: join(shots, 'restore-request.png') });
    const text = (await panel.locator('.break-all').first().textContent()).trim();
    const req = JSON.parse(Buffer.from(text, 'base64url').toString());
    const call = viem.decodeFunctionData({ abi: viem.parseAbi(['struct PublicKey { uint256 x; uint256 y; }', 'function initiateRecovery(PublicKey[] newSigners)']), data: req.initiateData });
    check('request installs the two new keys', call.args[0].length === 2 && call.args[0].every((k, i) => k.x === BigInt(req.keys[i].x)));
    check('request carries the signers hash the contract will store', req.signersHash === viem.keccak256(viem.encodeAbiParameters(viem.parseAbiParameters('(uint256 x, uint256 y)[]'), [call.args[0]])));
    await panel.getByRole('button', { name: 'Check status' }).click();
    await panel.getByText(/hasn't started the recovery yet|in progress|can finish/).waitFor();
    check('status reads the chain', true);

    // The guardian page reads the same request.
    const site = process.env.HAPTIX_GUARDIAN_SITE ?? 'http://haptix-guardian.test';
    await ctx.route(`${site}/**`, (r) => r.fulfill({ contentType: 'text/html', body: readFileSync(join(root, 'tools/guardian/index.html'), 'utf8') }));
    const gp = await ctx.newPage();
    gp.on('pageerror', (e) => console.log('guardian page error:', e.message));
    gp.on('console', (m) => m.type() === 'error' && console.log('guardian page console:', m.text()));
    await gp.goto(`${site}/`);
    await gp.getByLabel('Recovery request').fill(text);
    await gp.getByRole('button', { name: 'Read request' }).click();
    await gp.locator('#sGuardian').filter({ hasText: /0x|none/ }).waitFor();
    check('guardian page shows the on-chain guardian', (await gp.locator('#sGuardian').textContent()).toLowerCase() === guardianOnChain.toLowerCase());
    check('guardian page shows the account', (await gp.locator('#sAccount').textContent()) === viem.getAddress(target));
    if (shots) await gp.screenshot({ path: join(shots, 'guardian-page.png'), fullPage: true });
  }
} finally {
  await ctx.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
