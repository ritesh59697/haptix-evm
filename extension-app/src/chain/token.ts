// ERC-20 details read from the token contract itself, for showing what a site asks for.
import { decodeFunctionResult, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { rpc } from './rpc';

const net = __HAPTIX_NETWORK__;

async function read<T>(token: Address, functionName: 'symbol' | 'decimals' | 'name'): Promise<T> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName });
  const out = await rpc<Hex>(net.rpcUrl, 'eth_call', [{ to: token, data }, 'latest']);
  return decodeFunctionResult({ abi: erc20Abi, functionName, data: out }) as T;
}

/** null when the address doesn't answer like an ERC-20. */
export async function tokenInfo(token: Address): Promise<{ symbol: string; decimals: number } | null> {
  try {
    const [symbol, decimals] = await Promise.all([read<string>(token, 'symbol'), read<number>(token, 'decimals')]);
    return { symbol, decimals: Number(decimals) };
  } catch {
    return null;
  }
}

export interface TokenInfo { address: Address; symbol: string; name: string; decimals: number; balance: bigint }

/** The tokens this network's env file lists, with this account's balances. Unreadable ones are skipped. */
export async function walletTokens(account: Address): Promise<TokenInfo[]> {
  const rows = await Promise.all(net.tokens.map(async (address): Promise<TokenInfo | null> => {
    try {
      const [symbol, name, decimals, raw] = await Promise.all([
        read<string>(address, 'symbol'),
        read<string>(address, 'name'),
        read<number>(address, 'decimals'),
        rpc<Hex>(net.rpcUrl, 'eth_call', [{ to: address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [account] }) }, 'latest']),
      ]);
      return { address, symbol, name, decimals: Number(decimals), balance: BigInt(raw) };
    } catch {
      return null;
    }
  }));
  return rows.filter((t): t is TokenInfo => t !== null);
}
