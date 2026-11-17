// A small ERC-4337 bundler for tests: it simulates each op against the live chain, then
// sends it with handleOps from the deployer. It speaks just enough of the bundler API for
// the extension and scripts/agent-pay.mjs. Test tooling only; never expose it.
import { createServer } from 'node:http';
import { concatHex, decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, toHex } from 'viem';
import { castSend, cfg, entryPointAbi, ethCall, need, payer, revertReason, rpc } from './e2e-account.mjs';

const pad16 = (v) => toHex(BigInt(v), { size: 16 });
const packed = (op) => ({
  sender: getAddress(op.sender),
  nonce: BigInt(op.nonce),
  initCode: op.factory ? concatHex([op.factory, op.factoryData]) : '0x',
  callData: op.callData,
  accountGasLimits: concatHex([pad16(op.verificationGasLimit), pad16(op.callGasLimit)]),
  preVerificationGas: BigInt(op.preVerificationGas),
  gasFees: concatHex([pad16(op.maxPriorityFeePerGas), pad16(op.maxFeePerGas)]),
  paymasterAndData: '0x',
  signature: op.signature ?? '0x',
});

export function startDevBundler() {
  const receipts = new Map();
  const handlers = {
    eth_chainId: async () => toHex(cfg.chainId),
    pimlico_getUserOperationGasPrice: async () => {
      const price = BigInt(await rpc('eth_gasPrice', []));
      const tier = { maxFeePerGas: toHex(price * 2n), maxPriorityFeePerGas: toHex(price) };
      return { slow: tier, standard: tier, fast: tier };
    },
    // Fixed, generous limits: callers scale these up, and unused gas isn't charged.
    eth_estimateUserOperationGas: async () => ({
      preVerificationGas: toHex(cfg.pvg),
      verificationGasLimit: toHex(cfg.vgl / 4n),
      callGasLimit: toHex(BigInt(need('AGENT_E2E_GRANT_CALL_GAS'))),
    }),
    eth_sendUserOperation: async ([op]) => {
      const p = packed(op);
      const data = encodeFunctionData({ abi: entryPointAbi, functionName: 'handleOps', args: [[p], payer] });
      try {
        await rpc('eth_call', [{ from: payer, to: cfg.entryPoint, data }, 'latest']);
      } catch (e) {
        throw new Error(revertReason(e));
      }
      const hash = decodeFunctionResult({
        abi: entryPointAbi, functionName: 'getUserOpHash',
        data: await ethCall(cfg.entryPoint, encodeFunctionData({ abi: entryPointAbi, functionName: 'getUserOpHash', args: [{ ...p, signature: '0x' }] })),
      });
      const r = castSend(cfg.entryPoint, data);
      let success = false;
      for (const log of r.logs) {
        if (getAddress(log.address) !== cfg.entryPoint) continue;
        try {
          const ev = decodeEventLog({ abi: entryPointAbi, data: log.data, topics: log.topics });
          if (ev.eventName === 'UserOperationEvent') success = ev.args.success;
        } catch { /* other events */ }
      }
      receipts.set(hash, { success, receipt: { transactionHash: r.transactionHash } });
      return hash;
    },
    eth_getUserOperationReceipt: async ([hash]) => receipts.get(hash) ?? null,
  };
  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') return res.end();
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const { id, method, params } = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      try {
        if (!handlers[method]) throw new Error(`dev bundler has no ${method}`);
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: await handlers[method](params) }));
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32500, message: e.message } }));
      }
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}/rpc`, close: () => server.close() })));
}
