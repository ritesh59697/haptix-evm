#!/usr/bin/env node
/**
 * Pay or trade from a Haptix account as one of its agents: a command-line wrapper over
 * the agent SDK (agent-sdk/). Build it first: npm run build --prefix agent-sdk
 *
 * The agent key comes from the extension (Agents → New budget), which shows it once.
 * Within the agent's budget it goes through with the agent's signature alone.
 * When the contract stops it (over the 24h budget or the per-payment limit), this prints
 * a request: paste it into the extension (Agents → paste button) and approve it with
 * both of your keys. The request carries this exact operation and the agent's signature,
 * so the wallet only adds its own two signatures.
 *
 *   set -a; source networks/robinhood-testnet.env; set +a
 *   HAPTIX_AGENT_KEY=0x… HAPTIX_ACCOUNT=0x… BUNDLER_URL=https://… \
 *     node scripts/agent-pay.mjs <to> <amount in ETH>
 *
 *   # A trading agent (also needs SWAP_ROUTER and SWAP_POOL_FEE, which the network file sets):
 *     node scripts/agent-pay.mjs swap <tokenIn> <tokenOut> <amount> <minimum out>
 *
 * Exit codes: 0 done, 3 needs the owner (request printed), 1 refused or failed, 2 usage.
 */
import { formatUnits, getAddress, parseAbi, parseUnits, createPublicClient, http } from 'viem';
import { createHaptixAgent, DEFAULT_NATIVE_CURRENCY, ETH, HaptixAgentError } from '../agent-sdk/dist/index.js';

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k}. See the comment at the top of this file.`);
    process.exit(2);
  }
  return v;
};
const args = process.argv.slice(2);
const isSwap = args[0] === 'swap';
if (isSwap ? args.length !== 5 : args.length !== 2) {
  console.error('Usage: node scripts/agent-pay.mjs <to> <amount in ETH>\n   or: node scripts/agent-pay.mjs swap <tokenIn> <tokenOut> <amount> <minimum out>');
  process.exit(2);
}

// The network files name the chain's native currency; messages use it.
const native = process.env.NATIVE_SYMBOL
  ? { ...DEFAULT_NATIVE_CURRENCY, symbol: process.env.NATIVE_SYMBOL }
  : DEFAULT_NATIVE_CURRENCY;
const agent = createHaptixAgent({
  rpcUrl: need('RPC_URL'),
  bundlerUrl: need('BUNDLER_URL'),
  entryPoint: need('ENTRYPOINT_ADDRESS'),
  account: need('HAPTIX_ACCOUNT'),
  agentKey: need('HAPTIX_AGENT_KEY'),
  chainId: Number(need('CHAIN_ID')),
  nativeCurrency: native,
});
const client = createPublicClient({ transport: http(need('RPC_URL')) });
const erc20 = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const tokenMeta = async (address) => {
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address, abi: erc20, functionName: 'decimals' }),
    client.readContract({ address, abi: erc20, functionName: 'symbol' }),
  ]);
  return { decimals, symbol };
};

let action, asset, unit, symbol, describe;
if (isSwap) {
  const [, inArg, outArg, amountArg, minOutArg] = args;
  const tokenIn = getAddress(inArg);
  const tokenOut = getAddress(outArg);
  const [tin, tout] = await Promise.all([tokenMeta(tokenIn), tokenMeta(tokenOut)]);
  action = {
    kind: 'swap', router: getAddress(need('SWAP_ROUTER')), tokenIn, tokenOut, fee: Number(need('SWAP_POOL_FEE')),
    amountIn: parseUnits(amountArg, tin.decimals), minAmountOut: parseUnits(minOutArg, tout.decimals),
  };
  [asset, unit, symbol] = [tokenIn, tin.decimals, tin.symbol];
  describe = `swapping ${amountArg} ${tin.symbol} for at least ${minOutArg} ${tout.symbol}`;
} else {
  action = { kind: 'pay', to: getAddress(args[0]), amount: parseUnits(args[1], native.decimals) };
  [asset, unit, symbol] = [ETH, native.decimals, native.symbol];
  describe = `paying ${args[1]} ${native.symbol} to ${action.to}`;
}

try {
  const b = await agent.budget(asset);
  const fmt = (v) => formatUnits(v, unit);
  console.log(`Agent ${agent.address} on ${agent.account}`);
  console.log(`  budget: ${fmt(b.spent)} of ${fmt(b.windowCap)} ${symbol} used in this window; up to ${fmt(b.perPayment)} ${symbol} each`);
  console.log(`  ${describe}`);

  const out = await agent.run(action);
  if (out.status === 'done') {
    console.log(`  paid: tx ${out.transactionHash}`);
    process.exit(0);
  }
  console.log(`\nThe contract stopped this (${out.message})`);
  console.log('Paste this into Haptix → Agents → paste button, and approve it with both keys:\n');
  console.log(out.request);
  console.log('\nIt expires if the account sends anything else first (the nonce changes).');
  process.exit(3);
} catch (e) {
  if (e instanceof HaptixAgentError) {
    console.error(`  refused (${e.code}): ${e.message}`);
    process.exit(1);
  }
  throw e;
}
