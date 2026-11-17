import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The chain the UI shows comes from one networks/*.env file, the same files the
// contract scripts use. Pick it with HAPTIX_NETWORK_FILE (package.json sets the default).
function readNetwork() {
  const file = process.env.HAPTIX_NETWORK_FILE;
  if (!file) throw new Error('Set HAPTIX_NETWORK_FILE, for example ../networks/robinhood-testnet.env');
  const env: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, file), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const k of ['NETWORK_NAME', 'CHAIN_ID', 'NATIVE_SYMBOL', 'RPC_URL', 'EXPLORER_URL', 'ENTRYPOINT_ADDRESS', 'FACTORY_ADDRESS']) {
    if (!env[k]) throw new Error(`${file} has no ${k}`);
  }
  return {
    name: env.NETWORK_NAME,
    chainId: Number(env.CHAIN_ID),
    nativeSymbol: env.NATIVE_SYMBOL,
    rpcUrl: env.RPC_URL,
    explorerUrl: env.EXPLORER_URL,
    entryPoint: env.ENTRYPOINT_ADDRESS,
    factory: env.FACTORY_ADDRESS,
    // Optional: tokens the wallet shows and the router agents may trade through.
    tokens: (env.WALLET_TOKENS ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    swapRouter: env.SWAP_ROUTER || null,
  };
}

export default defineConfig({
  plugins: [react()],
  base: './',
  define: { __HAPTIX_NETWORK__: JSON.stringify(readNetwork()) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'index.html'),
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        background: resolve(__dirname, 'src/background.ts'),
      },
      // manifest.json names the worker file, so it can't carry a hash.
      output: { entryFileNames: (c) => (c.name === 'background' ? '[name].js' : 'assets/[name]-[hash].js') },
    },
  },
});
