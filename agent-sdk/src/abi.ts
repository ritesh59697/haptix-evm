import { parseAbi, parseAbiItem, parseAbiParameters, toFunctionSelector } from 'viem';

/** The parts of PasskeyAccount an agent reads or calls. */
export const accountAbi = parseAbi([
  'function executeByAgent(address agentKey, address dest, uint256 value, bytes func)',
  'function agentSessions(address) view returns (uint48 validAfter, uint48 validUntil, bool isRegistered, bool revoked, uint256 humanApprovalThreshold, uint256 perTxLimitEth, uint256 perTxLimitToken, uint256 windowSeconds)',
  'function agentWindow(address, address) view returns (uint96 spent, uint48 expiry)',
  'function agentWindowCap(address, address) view returns (uint256)',
  'function agentAllowedTokens(address, address) view returns (bool)',
  'function agentAllowedProtocols(address, address) view returns (bool)',
  'function agentAllowedSelectors(address, address, bytes4) view returns (bool)',
  'function isAllowedRecipient(address) view returns (bool)',
  'function isFrozen() view returns (bool)',
]);

export const entryPointAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function getUserOpHash(PackedUserOperation userOp) view returns (bytes32)',
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);

/** A token's display units, for messages. */
export const erc20MetaAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const userOperationEvent = parseAbiItem(
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
);

/** Uniswap SwapRouter02's exactInputSingle: the swap the account's policy can price. */
export const swapAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);
export const SWAP_SELECTOR = toFunctionSelector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))');

/** Signature body after the 0x01 type byte: the agent alone. */
export const AGENT_SIG = parseAbiParameters('address agentKey, bytes agentSig');
/** Signature body after the 0x02 type byte: the agent plus the owner's passkeys. */
export const ESCALATED_SIG = parseAbiParameters(
  'address agentKey, bytes agentSig, uint256[] ids, (bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s)[] sigs',
);
export const SIG_TYPE_AGENT = '0x01';
