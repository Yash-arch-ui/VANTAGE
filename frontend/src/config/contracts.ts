import { parseAbi, type Address } from "viem";
import deployments from "../../../contracts/deployments.json";

/**
 * Deployed Monad testnet addresses, read straight from the Foundry deployment
 * artifact so the UI can never drift from what was actually deployed.
 */
export const MOCK_ERC20_ADDRESS = deployments.MockERC20 as Address;
export const AMM_ADDRESS = deployments.AMM as Address;
export const MOCK_CLAIM_ADDRESS = deployments.MockClaim as Address;

/**
 * Kept as parseAbi string arrays, mirroring backend/src/psg/forecast.ts, so the
 * two sides stay diffable by eye. The backend only decodes simulations for
 * AMM and MockClaim — anything else falls back to a raw eth_call — so
 * these are the contracts the demo builds transactions against.
 */
export const ammAbi = parseAbi([
  "error InsufficientOutputAmount(uint256 expected, uint256 actual)",
  "error InvalidLiquidityAmounts()",
  "error Unauthorized()",
  "error ReentrancyDetected()",
  "function getExpectedOutput(uint256 inputAmount, bool inputIsToken) view returns (uint256)",
  "function swap(uint256 minOutput, bool inputIsToken, uint256 inputAmount) payable",
  "function getReserves() view returns (uint256, uint256)",
  "function owner() view returns (address)",
  "function token() view returns (address)",
]);

export const mockClaimAbi = parseAbi([
  "error SlotAlreadyClaimed(uint256 slotId)",
  "error InvalidSlot()",
  "function claim(uint256 slotId)",
  "function isClaimed(uint256 slotId) view returns (bool)",
  "function totalClaimed() view returns (uint256)",
  "function remainingSlots() view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** Block explorer for Monad testnet — used to link out from the ledger. */
export const EXPLORER_TX_URL = (hash: string) => `https://testnet.monadexplorer.com/tx/${hash}`;
export const EXPLORER_ADDRESS_URL = (address: string) =>
  `https://testnet.monadexplorer.com/address/${address}`;
