// The whole wallet through its real screens, from an empty Chrome profile, on the live
// chain: onboarding, sends, sites, signing, token sends, trading agents, freeze, guardian.
// Virtual authenticators stand in for Touch ID and a security key, and a local bundler
// (scripts/lib/dev-bundler.mjs) stands in for Pimlico. It spends a little testnet ETH from
// the deployer. It doesn't replace a run with real passkeys, a real bundler and a second Mac.
//
//   npm run build
//   set -a; source networks/robinhood-testnet.env; set +a
//   DEPLOYER_ACCOUNT=passkey-deployer node tools/test-dapp/full-flow.mjs
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { castSend, need, payer } from '../../scripts/lib/e2e-account.mjs';
import { startDevBundler } from '../../scripts/lib/dev-bundler.mjs';

const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'extension-app/dist');
const viem = createRequire(join(root, 'extension-app/package.json'))('viem');
const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');
const site = process.env.HAPTIX_E2E_SITE ?? 'http://haptix-full.test';
const shots = process.env.HAPTIX_E2E_SHOTS;
const chainId = Number(need('CHAIN_ID'));
const usd = viem.getAddress(need('DEMO_USD_TOKEN'));
const stock = viem.getAddress(need('DEMO_STOCK_TOKEN'));
const client = viem.createPublicClient({ transport: viem.http(need('RPC_URL')) });
const funding = BigInt(need('E2E_SEND_OVER_WEI'));
const limit = BigInt(need('E2E_THRESHOLD_WEI'));
const under = BigInt(need('E2E_SEND_UNDER_WEI'));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const bundler = await startDevBundler();
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'haptix-full-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const stored = (key) => sw.evaluate((k) => chrome.storage.local.get(k).then((v) => v[k]), key);

  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 400, height: 780 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  const cdp = await ctx.newCDPSession(panel);
  await cdp.send('WebAuthn.enable');
  for (const transport of ['internal', 'usb']) {
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport, hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  }
  await panel.bringToFront();
  const shot = (name) => (shots ? panel.screenshot({ path: join(shots, `flow-${name}.png`) }) : null);
  /** Jump to a screen the way the popup hands one to the side panel. */
  const go = async (route) => {
    await sw.evaluate(({ k, route }) => chrome.storage.session.set({ [k]: route }), { k: `haptix.panelRoute.${chainId}`, route });
    await panel.waitForTimeout(400);
  };
  const button = (name) => panel.getByRole('button', { name });
  const heading = (name) => panel.getByRole('heading', { name });
  const LONG = { timeout: 90_000 };

  // --- Onboarding from nothing ---------------------------------------------------
  await button(/Create with Touch ID/).click();
  await heading('Add a second key').waitFor();
  await button(/security key|add|continue/i).last().click();
  await heading('Set your per-send limit').waitFor();
  await panel.locator('#limit').fill(viem.formatEther(limit));
  await button('Create account').click();
  await panel.getByRole('button', { name: /^Send$/ }).waitFor(LONG);
  const acct = await stored(`haptix.account.${chainId}`);
  check('onboarding made an account from two new passkeys', acct?.keys?.length === 2, acct?.address);
  const predicted = await client.readContract({
    address: need('FACTORY_ADDRESS'),
    abi: viem.parseAbi(['struct PublicKey { uint256 x; uint256 y; }', 'function getAddress(PublicKey[] s, uint256 t, bytes32 salt) view returns (address)']),
    functionName: 'getAddress',
    args: [acct.keys.map((k) => ({ x: BigInt(k.x), y: BigInt(k.y) })), limit, acct.salt],
  });
  check('its address is what the factory predicts', predicted === acct.address);
  check('it records the factory that makes it', viem.getAddress(acct.factory) === viem.getAddress(need('FACTORY_ADDRESS')));
  check('the wallet lists the network\'s tokens', (await panel.getByText('Haptix Demo Dollar').count()) === 1);
  await shot('home');

  // --- Fund it and set the bundler ------------------------------------------------
  const fund = castSend(acct.address, '0x', funding);
  check('funded from the deployer', fund.status === '0x1');
  await go({ name: 'security' });
  await panel.locator('#bundler').fill(bundler.url);
  await panel.locator('#bundler').locator('..').getByRole('button', { name: 'Save' }).click();
  await panel.getByText(/Bundler URL saved/).waitFor();
  check('Security saves a working bundler URL', true);

  // --- Sends -----------------------------------------------------------------------
  const balance = () => client.getBalance({ address: acct.address });
  const to = payer;
  const send = async (amountWei, signLabel) => {
    await go({ name: 'review', to, amount: viem.formatEther(amountWei), token: need('NATIVE_SYMBOL') });
    await button(signLabel).click();
    await heading('Sent').waitFor(LONG);
  };
  await send(under, /Send with Touch ID/);
  check('a send under the limit takes one key and creates the account on chain', (await client.getCode({ address: acct.address }))?.length > 2);
  await send(limit, /Sign with both keys/);
  check('a send exactly at the limit takes both keys', true);
  await shot('sent');

  // --- A site ------------------------------------------------------------------------
  await ctx.route(`${site}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  await page.goto(`${site}/`);
  const req = (method, params = []) => page.evaluate(async ([m, p]) => {
    try { return { result: await window.__haptixProvider.request({ method: m, params: p }) }; } catch (e) { return { error: { code: e.code, message: e.message } }; }
  }, [method, params]);
  const answerInPanel = async (host) => {
    await page.waitForTimeout(500);
    await go({ name: 'requests' });
    await panel.bringToFront();
    await panel.getByRole('button', { name: new RegExp(host) }).first().click();
  };
  const siteHost = new URL(site).host;
  const connecting = req('eth_requestAccounts');
  await answerInPanel(siteHost);
  await button('Connect').click();
  check('a site connects', (await connecting).result?.[0] === acct.address);

  const siteSend = req('eth_sendTransaction', [{ from: acct.address, to: payer, value: viem.toHex(under) }]);
  await answerInPanel(siteHost);
  await button(/Approve with Touch ID/).click();
  const sent = await siteSend;
  const receipt = sent.result ? await client.getTransactionReceipt({ hash: sent.result }) : null;
  check('a site\'s send lands and the site gets the hash', receipt?.status === 'success', sent.error ?? sent.result);
  await panel.bringToFront();
  await button('Done').click();

  const text = 'Sign in to haptix-full.test';
  const signing = req('personal_sign', [viem.toHex(text), acct.address]);
  await answerInPanel(siteHost);
  await button(/Sign with Touch ID/).click();
  const sig = await signing;
  check('the deployed account accepts a one-key personal_sign', !!sig.result && await client.verifyMessage({ address: acct.address, message: text, signature: sig.result }), sig.error);

  const typed = {
    domain: { name: 'Haptix Full', version: '1', chainId, verifyingContract: '0x' + '22'.repeat(20) },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }] },
    primaryType: 'Permit',
    message: { owner: acct.address, spender: '0x' + '33'.repeat(20), value: '1' },
  };
  const typing = req('eth_signTypedData_v4', [acct.address, JSON.stringify(typed)]);
  await answerInPanel(siteHost);
  await heading('Sign a token approval?').waitFor();
  await button(/Sign with both keys/).click();
  const tsig = await typing;
  check('a signed approval takes both keys and the account accepts it', !!tsig.result && await client.verifyTypedData({ address: acct.address, ...typed, message: { ...typed.message, value: 1n }, signature: tsig.result }), tsig.error);

  // --- Tokens ------------------------------------------------------------------------
  const erc20 = viem.parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)']);
  const tokens = (a) => client.readContract({ address: a, abi: erc20, functionName: 'balanceOf', args: [acct.address] });
  const trade = BigInt(need('AGENT_TRADE_PAYMENT_WEI'));
  const budget = BigInt(need('AGENT_TRADE_BUDGET_WEI'));
  castSend(usd, viem.encodeFunctionData({ abi: erc20, functionName: 'mint', args: [acct.address, budget * 3n] }));
  await panel.reload();
  await panel.waitForTimeout(800);
  await go({ name: 'review', to, amount: '1', token: 'dUSD' });
  await panel.getByText('Token sends always need both keys.', { exact: false }).waitFor();
  const before = await tokens(usd);
  await button(/Sign with both keys/).click();
  await heading('Sent').waitFor(LONG);
  check('a token send takes both keys and moves the token', before - (await tokens(usd)) === viem.parseEther('1'));

  // --- A trading agent ---------------------------------------------------------------
  await go({ name: 'newBudget' });
  await panel.getByRole('radio', { name: 'Trades tokens' }).click();
  await panel.getByLabel('Agent name').fill('Rebalancer');
  await panel.getByLabel(/Budget per 24h/).fill(viem.formatEther(budget));
  await panel.getByLabel('Most per trade').fill(viem.formatEther(trade));
  await shot('new-budget');
  await button(/Grant with both keys/).click();
  await panel.getByText('has a budget').waitFor(LONG);
  const agentKey = (await panel.locator('.break-all').first().textContent()).trim();
  check('granting shows the agent key once', /^0x[0-9a-f]{64}$/.test(agentKey));
  const stayed = JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null)));
  check('the agent key is not stored anywhere', !stayed.includes(agentKey.slice(2)));
  await button('I saved it').click();

  const agentEnv = { ...process.env, HAPTIX_AGENT_KEY: agentKey, HAPTIX_ACCOUNT: acct.address, BUNDLER_URL: bundler.url };
  // Async: the bundler it talks to runs in this process.
  const agentRun = (...args) => new Promise((ok) => {
    execFile('node', [join(root, 'scripts/agent-pay.mjs'), ...args], { env: agentEnv, encoding: 'utf8' }, (err, stdout, stderr) => {
      ok({ code: err ? err.code : 0, out: `${stdout}${stderr}` });
    });
  });
  const tokenAmount = viem.formatEther(trade);
  const minOut = viem.formatEther(BigInt(need('AGENT_TRADE_MIN_OUT_WEI')));
  const bought = await tokens(stock);
  const runSwap = () => agentRun('swap', usd, stock, tokenAmount, minOut);
  const first = await runSwap();
  check('the agent trades within budget on its own key', first.code === 0 && /paid/.test(first.out), first.out.trim().split('\n').pop());
  check('what it bought is in the account', (await tokens(stock)) > bought);
  const second = await runSwap();
  check('it trades again up to the budget', second.code === 0, second.out.trim().split('\n').pop());
  const over = await runSwap();
  check('past the budget it stops and prints a request', over.code === 3);
  const requestText = over.out.split('\n').filter((l) => /^[A-Za-z0-9_-]{100,}$/.test(l.trim()))[0]?.trim();

  await panel.bringToFront();
  await go({ name: 'agents' });
  await panel.getByText('Rebalancer').waitFor();
  await panel.getByText(/Budget used up/).waitFor();
  check('an open wallet shows what the agent spent outside it', (await panel.getByText(`${Number(viem.formatEther(budget)).toFixed(2)} /`, { exact: false }).count()) >= 1);
  await shot('agents');
  await go({ name: 'agentPaste' });
  await panel.getByLabel('Agent request').fill(requestText ?? '');
  await button('Check request').click();
  await heading(/wants to go past its limits/).waitFor();
  check('the request shows the budget as used and how far over', (await panel.getByText(/over$/).count()) >= 1);
  await shot('agent-request');
  const beforeOver = await tokens(stock);
  await button(/Approve with both keys/).click();
  await heading('Approved and paid').waitFor(LONG);
  check('you approve the over-budget trade with both keys', (await tokens(stock)) > beforeOver);
  await button('Done').click();

  await panel.reload();
  await panel.waitForTimeout(800);
  await go({ name: 'agents' });
  await button('Revoke').click();
  await button(/Revoke with both keys/).click();
  await heading(/can't spend any more/).waitFor(LONG);
  const allowance = await client.readContract({ address: usd, abi: erc20, functionName: 'allowance', args: [acct.address, need('SWAP_ROUTER')] });
  check('revoking also takes back the router approval', allowance === 0n);
  const afterRevoke = await runSwap();
  check('the agent can\'t act after revoke', afterRevoke.code !== 0, afterRevoke.out.trim().split('\n').pop());
  await button('Done').click();

  // --- Freeze, guardian, recovery -----------------------------------------------------
  const account = viem.parseAbi(['struct PublicKey { uint256 x; uint256 y; }', 'function isFrozen() view returns (bool)', 'function guardian() view returns (address)', 'function initiateRecovery(PublicKey[] newSigners)', 'function pendingRecovery() view returns (uint48, bool, bytes32)']);
  const accountRead = (functionName) => client.readContract({ address: acct.address, abi: account, functionName });
  await go({ name: 'freeze' });
  await button(/Freeze with Touch ID/).click();
  await heading('Frozen.').waitFor(LONG);
  check('freezing takes one key', await accountRead('isFrozen'));
  await button('Done').click();
  await panel.reload();
  await panel.waitForTimeout(800);
  await go({ name: 'review', to, amount: viem.formatEther(under / 2n), token: need('NATIVE_SYMBOL') });
  await panel.getByText('Every send needs both keys while frozen.', { exact: false }).waitFor();
  check('while frozen a small send asks for both keys', true);
  await go({ name: 'unfreeze' });
  await button(/Unfreeze with both keys/).click();
  await heading('Unfrozen.').waitFor(LONG);
  check('unfreezing takes both keys', !(await accountRead('isFrozen')));
  await button('Done').click();
  await panel.reload();
  await panel.waitForTimeout(800);

  await go({ name: 'guardian' });
  await panel.getByLabel('Guardian address').fill(payer);
  await button(/Save with both keys/).click();
  await heading('Saved').waitFor(LONG);
  check('setting a guardian takes both keys', viem.getAddress(await accountRead('guardian')) === payer);
  await button('Done').click();

  // The deployer, as guardian, starts a recovery to keys this device doesn't hold.
  const other = [{ x: 1n, y: 2n }, { x: 3n, y: 4n }];
  castSend(acct.address, viem.encodeFunctionData({ abi: account, functionName: 'initiateRecovery', args: [other] }));
  await panel.reload();
  await panel.waitForTimeout(800);
  await go({ name: 'home' });
  await panel.getByText('Your guardian started a recovery').waitFor();
  check('a recovery for other keys raises the alert', true);
  check('Home stops counting the revoked agent', (await panel.getByText('No active agents').count()) === 1);
  check('the wait reads as a real time', !/ 60 min/.test(await panel.locator('body').innerText()));
  await shot('recovery-alert');
  await panel.getByText('Your guardian started a recovery').click();
  await button(/Cancel recovery with Touch ID/).click();
  await heading('Recovery cancelled.').waitFor(LONG);
  check('you cancel a recovery with one key', !(await accountRead('pendingRecovery'))[1]);
  await button('Done').click();

  const activity = await stored(`haptix.activity.${chainId}`);
  check('Activity recorded everything, nothing left pending', activity.length >= 10 && activity.every((a) => a.status !== 'pending'), `${activity.length} entries`);
} catch (e) {
  failures++;
  console.log(`FAIL stopped: ${e.message.split('\n').slice(0, 3).join(' | ')}`);
  const pages = ctx.pages().filter((p) => p.url().includes('sidepanel'));
  if (shots && pages[0]) await pages[0].screenshot({ path: join(shots, 'flow-failed.png') }).catch(() => {});
} finally {
  await ctx.close();
  bundler.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
