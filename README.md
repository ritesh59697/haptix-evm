# Haptix

Haptix lets a developer give an AI agent real spending power without giving it the user's wallet.

The user's account is an ERC-4337 smart account controlled by two passkeys. An agent gets its own key and a budget. The account contract enforces that budget on every operation:

- the agent spends within its 24-hour budget on its own;
- it can only call the contracts, functions and tokens it was granted;
- trade proceeds can only come back to the user's account.

Past the budget, the contract stops the agent. The user can approve that one operation with both passkeys. Revoking an agent takes one action.

**Building an agent?** [`agent-sdk/`](agent-sdk) gives it the budget in a few lines: read what's left, pay, swap, and get an approval request for anything bigger.

It runs on Robinhood Chain testnet and Arbitrum Sepolia. It verifies passkeys natively through the P-256 precompile (RIP-7212), so there is no server key and no off-chain signer service.

> **Status: testnet, unaudited.** See [Limits](#limits) before relying on anything here.

## Who signs what

The contract decides how many keys an operation needs. The wallet only mirrors it.

| Operation | Needs |
|---|---|
| Send ETH below the per-send limit | One passkey |
| Send ETH at or above the limit | Both passkeys |
| Token transfer | Both passkeys, unless the owner set a limit for that token and the amount is below it |
| Any other contract call, or an approval | Both passkeys |
| Change the account itself (signers, limits, agents, guardian) | Both passkeys |
| Agent operation within its budget and grant | The agent's key |
| Agent operation past its budget | The agent's key and both passkeys |
| Freeze | One passkey |
| Unfreeze | Both passkeys |
| Anything while frozen | Both passkeys. Agents can't spend. |
| Sign a `personal_sign` message (ERC-1271) | One passkey, and only while not frozen |
| Sign any other message, including typed data | Both passkeys |
| Start a recovery | The guardian, after both passkeys set one. It can't freeze. |
| Cancel a recovery | One passkey |
| Finish a recovery | Anyone, after the wait (at least 24 hours), and not while frozen |

Batches are priced on their total per asset, so splitting a large send into small ones doesn't avoid the second key. With both keys, the owner can also set a rolling cap on one-key spending and a list of allowed recipients; a send to anyone else then needs both keys.

## What's here

| Path | What it is |
|---|---|
| [`src/PasskeyAccount.sol`](src/PasskeyAccount.sol) | The account: `validateUserOp`, agent sessions (`grantAgentSession`, `executeByAgent`), freeze, guardian recovery and ERC-1271 |
| [`src/WebAuthn.sol`](src/WebAuthn.sol) | WebAuthn assertion verification through the P-256 precompile, requiring user verification and low-s |
| [`src/SpendPolicy.sol`](src/SpendPolicy.sol), [`src/SpendWindow.sol`](src/SpendWindow.sol) | Decoding what a call does, and the rolling 24-hour windows per asset |
| [`src/PasskeyAccountFactory.sol`](src/PasskeyAccountFactory.sol) | Deterministic accounts (ERC-1167 clones). The address is known before deployment. |
| [`test/`](test) | 256 Foundry tests: policy, agent red-team cases, recovery, ERC-1271, ERC-7562 rules, real WebAuthn vectors |
| [`extension-app/`](extension-app) | The Chrome extension (React, MV3) |
| [`extension-app/src/chain/`](extension-app/src/chain) | All chain logic: account, agents, guardian, tokens |
| [`extension-app/public/inpage.js`](extension-app/public/inpage.js) | EIP-1193 provider, announced over EIP-6963 |
| [`networks/`](networks) | One `.env` per chain. Every address and limit comes from here; nothing is built into the code. |
| [`agent-sdk/`](agent-sdk) | TypeScript SDK for agent builders: budgets, payments, swaps, approval requests |
| [`scripts/`](scripts) | Live end-to-end runs against a testnet, plus [`agent-pay.mjs`](scripts/agent-pay.mjs), a command-line agent built on the SDK |
| [`tools/test-dapp/`](tools/test-dapp) | Headless browser suites that drive the real extension with virtual passkeys |
| [`tools/guardian/`](tools/guardian/index.html) | A single-file page a guardian uses to start or finish a recovery |
| [`script/`](script) | Foundry deploy scripts, and a testnet-only demo DEX |

The extension covers:

- onboarding with Touch ID plus a second key;
- sends, and connecting to sites;
- message and typed-data signing;
- agent budgets for payments and trades;
- freeze, guardian, and restoring on a new device.

## Run it

You need [Foundry](https://getfoundry.sh) and Node 22.

```bash
git clone --recurse-submodules https://github.com/ritesh59697/haptix-evm
cd haptix-evm
forge test
npm ci --prefix agent-sdk && npm run test:agent-sdk
```

Build the extension and run the headless suite. It loads the extension in Chromium with virtual passkeys, reads the live testnet and sends nothing:

```bash
npm ci && npm ci --prefix extension-app
npx playwright install chromium
npm run test:e2e
```

To try it by hand, load `extension-app/dist` as an unpacked extension in `chrome://extensions`. Then set a bundler URL for Robinhood Chain testnet under Security; any ERC-4337 v0.7 bundler works. Passkeys are real, and the account is a real testnet account.

### Live runs

These send real testnet transactions and act as their own bundler. Gas comes from a funded Foundry keystore account, named in `DEPLOYER_ACCOUNT`. Load a network first:

```bash
set -a; source networks/robinhood-testnet.env; set +a
export DEPLOYER_ACCOUNT=<keystore name>
```

| Command | Checks |
|---|---|
| `node scripts/chain-e2e.mjs` (run first; the others reuse its account) | Under the limit with one key; over the limit rejected with one key, accepted with two |
| `node scripts/agent-e2e.mjs` | Grant, two payments within budget, past-budget rejected, approved with both keys, revoke |
| `node scripts/agent-trade-e2e.mjs` | The same for trades through the demo router, plus a trade whose proceeds go elsewhere (rejected) |
| `node scripts/guardian-e2e.mjs` | Set guardian, freeze, unfreeze, start recovery, early finish refused, cancel |
| `node scripts/signature-e2e.mjs` | ERC-1271: which messages one key may sign |
| `npm run build:agent-sdk && node scripts/agent-sdk-e2e.mjs` | The agent SDK: pays, stops at limits, a request approved by the owner, swaps, frozen and revoked refusals |
| `npm run test:e2e:full` | 33 checks through the real extension screens, with a local bundler |

Each script lists its environment variables at the top.

## Deployments

**Robinhood Chain testnet** (chain 46630)

| | Address |
|---|---|
| Factory | [`0xCd12906D03812f85a845F5f28705d0F353375980`](https://explorer.testnet.chain.robinhood.com/address/0xCd12906D03812f85a845F5f28705d0F353375980) |
| Account implementation | [`0x49b50C52dF57cB40bfDb73cF6296c065203Cb007`](https://explorer.testnet.chain.robinhood.com/address/0x49b50C52dF57cB40bfDb73cF6296c065203Cb007) |
| Demo DEX router (testnet only) | [`0xccCfD00E0A882f586b84D37029656705715b0921`](https://explorer.testnet.chain.robinhood.com/address/0xccCfD00E0A882f586b84D37029656705715b0921) |
| Demo tokens dUSD, dSTK (worthless) | [`0x7014…503D`](https://explorer.testnet.chain.robinhood.com/address/0x70145655EAc4d51Ac4F6339167fFf5B0BD49503D), [`0xA1e7…6840`](https://explorer.testnet.chain.robinhood.com/address/0xA1e7395f6812921B31Cb799Dc939F16ac9C06840) |

**Arbitrum Sepolia** (chain 421614)

| | Address |
|---|---|
| Factory | [`0xb29eDc6A27C24c0579Bd42Fe4f86ad36F36d33DA`](https://sepolia.arbiscan.io/address/0xb29eDc6A27C24c0579Bd42Fe4f86ad36F36d33DA) |
| Account implementation | [`0x34Aeb3A39fd1838D1C897F879EAB0a258507802c`](https://sepolia.arbiscan.io/address/0x34Aeb3A39fd1838D1C897F879EAB0a258507802c) |

The EntryPoint is the canonical v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`.

## Receipts

All on Robinhood Chain testnet unless noted.

**Real passkeys, through the extension and a hosted bundler** (2026-11-05):
- [Account created, and 0.0005 ETH sent with Touch ID alone](https://explorer.testnet.chain.robinhood.com/tx/0xee4c69691251647bb703c9dfcb4913a508376a2cd9a3803a3621fb398e4142d6).
- [0.0015 ETH, over the 0.001 limit, signed with Touch ID and a phone passkey](https://explorer.testnet.chain.robinhood.com/tx/0x2a59df18193f0cd03645f2723e27522d19f5e9130526aa7b945d781122063e63).

**Spend limit, current factory** (`chain-e2e.mjs`, 2026-11-09):
- [Under the limit, one key](https://explorer.testnet.chain.robinhood.com/tx/0x33b958b7a92f62e443ffb2fa58a77923cdc8b0bf9c0a03ac13e9c4245a47d6e1).
- Over the limit with one key: rejected (`AA24`).
- [The same operation with two keys](https://explorer.testnet.chain.robinhood.com/tx/0x021bcb812ae4b2445beb1db59826311b058b1f2c40888e5feeddbb1734a53934).
- On Arbitrum Sepolia: [one key](https://sepolia.arbiscan.io/tx/0xa00aea7336d98643a0843413ca2ced06c6aef8daadbc2ba88a8e37b33d0fae7c) and [two keys](https://sepolia.arbiscan.io/tx/0x0b8e818a7bfec163aeccf8fa95cd28bbffe03c41fd4dba164fcdfcd855265754).

**Agent payments** (`agent-e2e.mjs`, 2026-11-07):
- [Grant](https://explorer.testnet.chain.robinhood.com/tx/0x228fcbfcbf693920b5de2e0b17ca86d6b3c81349aaa69b3210445b5f1c230893).
- Payments within budget: [1](https://explorer.testnet.chain.robinhood.com/tx/0x90b79e7711d175ae4b108af62ad49de75e3d4f92f38f88920f55625c5976cf90), [2](https://explorer.testnet.chain.robinhood.com/tx/0x83d52b659dcb618fa343c7cc4572b5f7d1e99defff1e84c85dc5d8bbff03cf42).
- Past budget: rejected. [The same payment with both keys added](https://explorer.testnet.chain.robinhood.com/tx/0x84c1f68fe7a39696e9434f7c8a89970166119b3c54a98d913f4639960d403715).
- [Revoke](https://explorer.testnet.chain.robinhood.com/tx/0xcf305063df90ff0a768c1878c305f8272bbd207052f64b73b14e13b021b16a10). After it, a payment was rejected.

**Agent trades, against the demo router** (`agent-trade-e2e.mjs`, 2026-11-09):
- [Grant and approve](https://explorer.testnet.chain.robinhood.com/tx/0x70e86b05c5914d2492023161db62fc7c0161e41ba0794c02c35deabe34fafb76).
- Trades: [1](https://explorer.testnet.chain.robinhood.com/tx/0x0b800e5467f9f84ce311ffb97c90de06ca62b9e0c327b7c9844f264e63f1c5b8), [2](https://explorer.testnet.chain.robinhood.com/tx/0xa71b0055e7e1c4bc7ea4d48fa01741625155ec081a2d705d1494dfc3b988a8a3).
- [Over budget, with both keys](https://explorer.testnet.chain.robinhood.com/tx/0x6fd4f10ad3e9a324da4f0101aab598d9010773ead3098bf7cad054e2d43a197d).
- [Revoke](https://explorer.testnet.chain.robinhood.com/tx/0x73cc6add1bacd072517f6f8b5db58bf9ef83fb5eccba9502c796a662616d287e).

**Agent SDK** (`agent-sdk-e2e.mjs`, 2026-11-17, current factory):
- [Payment within budget, agent key only](https://explorer.testnet.chain.robinhood.com/tx/0x5092be81c0faa8e7e22c99f299d31cd9bebfbdb62233190209095e0abac5d6b0).
- [An over-limit request, approved by the owner with both passkeys](https://explorer.testnet.chain.robinhood.com/tx/0x2ade34e78f399adbe469ca20a5e80a8fae9c21be650b8f9a8a3aee04e980cc48). The other request on the same nonce was then reported superseded.
- [Swap within budget](https://explorer.testnet.chain.robinhood.com/tx/0xeab041edb37d1e0ea988eb1f870b3696f519e01d824f499420e9edafc2bc770e).

**Freeze and guardian** (`guardian-e2e.mjs`, 2026-11-07):
- [Set guardian](https://explorer.testnet.chain.robinhood.com/tx/0x322cdbfd1176f57c35b9976cbacef4181d87d5372b255a3a56d30caf559bf868).
- [Freeze with one key](https://explorer.testnet.chain.robinhood.com/tx/0xe4ceff22b73ccd555de1743c9ab0817efb31810b65551b48d9ba13c8e5d35f67), and [unfreeze with both](https://explorer.testnet.chain.robinhood.com/tx/0x190aca8d159587f4c667551d3e0eb0442832a54207b5aedc2b36f3b7aef6e38e).
- [Guardian starts recovery](https://explorer.testnet.chain.robinhood.com/tx/0x4d30cd44db7345169e4839fb9864b6f2eadc1e3a3e07cf010711801d513230b7). An early finish was refused.
- [Owner cancels with one key](https://explorer.testnet.chain.robinhood.com/tx/0x4ecfa2e326c1eaf8789bd3cb635e790452e2fc79152cde663cb45d3e84f42352).

The spend-limit, trade and agent SDK receipts come from an account made by the current factory. The real-passkey sends, agent payments and guardian receipts come from accounts made by the earlier factory, `0x60319237…146d`. The 2026-11-09 redeploy changed only how signed messages are checked (ERC-1271). Accounts from the earlier factory keep the old one-key rule for signed messages, and the wallet warns about it. The scripts use software P-256 keys that produce real WebAuthn assertions, so the contract runs the same verification path as for Touch ID.

## Limits

- **No external audit.**
- **Accounts can't be upgraded.** They are ERC-1167 clones with no admin key. A fix means a new factory, and users moving to a new account.
- **Two keys can't be proven to be on two devices.** Passkey providers don't attest where a key lives, and two keys that sync through one password manager are both on every device it syncs to. The wallet detects synced keys at setup and warns. A security key avoids it.
- **One key can sign a `personal_sign` message.** A site that treats such a message as authorization gets one-key security.
- **Real-passkey testing is partial.** Real Touch ID and phone passkeys were used for sends (above). The agent, guardian, signing and site screens have been tested with virtual passkeys and a local bundler only.
- **Trading uses a demo router.** No Uniswap deployment is documented on Robinhood Chain testnet, so trades run against [`script/demo/DemoDex.sol`](script/demo/DemoDex.sol) at a fixed price.
- **No gas sponsorship yet.** The account pays its own gas.
- **The agent SDK isn't on npm** and has run only through a local test bundler, not a hosted one.

## License

[MIT](LICENSE)
