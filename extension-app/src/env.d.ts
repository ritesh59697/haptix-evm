/// <reference types="vite/client" />

/** Set at build time from networks/*.env (see vite.config.ts). */
declare const __HAPTIX_NETWORK__: {
  name: string;
  /** For tight spots in the UI; same as name unless the network file sets one. */
  shortName: string;
  chainId: number;
  nativeSymbol: string;
  rpcUrl: string;
  explorerUrl: string;
  entryPoint: `0x${string}`;
  factory: `0x${string}`;
  tokens: `0x${string}`[];
  swapRouter: `0x${string}` | null;
  defaultBundlerUrl: string | null;
};
