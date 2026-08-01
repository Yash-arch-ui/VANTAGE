import { useCallback, useState } from "react";
import { encodeFunctionData, maxUint256, parseEther, type Address, type Hex } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import {
  MOCK_AMM_ADDRESS,
  MOCK_CLAIM_ADDRESS,
  MOCK_ERC20_ADDRESS,
  erc20Abi,
  mockAmmAbi,
  mockClaimAbi,
} from "../config/contracts";
import type { EvaluateRequest } from "../lib/api";

export type PresetId = "swap" | "claim" | "approve";

export type Preset = {
  id: PresetId;
  label: string;
  /** Which of the seven modules this preset is designed to exercise. */
  demonstrates: string;
  target: Address;
  /** Label for the single numeric input the preset takes. */
  inputLabel: string;
  defaultInput: string;
};

export const PRESETS: Preset[] = [
  {
    id: "swap",
    label: "Swap on MockAMM",
    demonstrates: "Output drift and contention — the price you were quoted vs the price you get",
    target: MOCK_AMM_ADDRESS,
    inputLabel: "Input amount (tokens)",
    defaultInput: "1",
  },
  {
    id: "claim",
    label: "Claim a slot",
    demonstrates: "Stale state — the slot someone else took while you were reading the page",
    target: MOCK_CLAIM_ADDRESS,
    inputLabel: "Slot id",
    defaultInput: "1",
  },
  {
    id: "approve",
    label: "Unlimited approval",
    demonstrates: "Approval exposure — granting a contract unbounded access to your tokens",
    target: MOCK_ERC20_ADDRESS,
    inputLabel: "(no input — approves 2^256-1)",
    defaultInput: "0",
  },
];

export type BuiltTx = {
  request: EvaluateRequest;
  /** Human-readable summary of what is about to be evaluated. */
  summary: string;
};

export type BuildError = { message: string };

/**
 * Builds a prepared-but-unsigned transaction for the Guard console.
 *
 * The quoted output for a swap is read live from the pool (getExpectedOutput)
 * rather than invented, which is what makes the drift check meaningful: the
 * backend compares that quote against its own simulation, so a real price move
 * between quote and evaluation shows up as a real number.
 */
export function useTxBuilder() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [isBuilding, setIsBuilding] = useState(false);

  const build = useCallback(
    async (preset: Preset, rawInput: string): Promise<BuiltTx> => {
      if (!address) throw new Error("Connect a wallet first.");
      if (!publicClient) throw new Error("No RPC client available.");

      setIsBuilding(true);
      try {
        // The nonce has to come from the chain, not a counter: a stale nonce is
        // one of the conditions the guard is meant to catch, so feeding it a
        // guess would test nothing.
        const nonce = await publicClient.getTransactionCount({ address });

        let data: Hex;
        let quotedOutput: string | undefined;
        let summary: string;

        switch (preset.id) {
          case "swap": {
            const inputAmount = parseEther(rawInput || "0");
            if (inputAmount <= 0n) throw new Error("Enter an amount greater than zero.");

            // Live quote from the pool — this is the number the user is
            // effectively being shown, and what drift is measured against.
            const expected = (await publicClient.readContract({
              address: MOCK_AMM_ADDRESS,
              abi: mockAmmAbi,
              functionName: "getExpectedOutput",
              args: [inputAmount, true],
            })) as bigint;

            quotedOutput = expected.toString();
            data = encodeFunctionData({
              abi: mockAmmAbi,
              functionName: "swap",
              // minOutput 0 deliberately: the point is to let the swap execute
              // and let Vantage catch a bad price, not to have the AMM's own
              // slippage guard revert it first.
              args: [0n, true, inputAmount],
            });
            summary = `Swap ${rawInput} tokens on MockAMM`;
            break;
          }

          case "claim": {
            const slotId = BigInt(rawInput || "0");
            data = encodeFunctionData({
              abi: mockClaimAbi,
              functionName: "claim",
              args: [slotId],
            });
            summary = `Claim slot ${slotId} on MockClaim`;
            break;
          }

          case "approve": {
            data = encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [MOCK_AMM_ADDRESS, maxUint256],
            });
            summary = "Approve MockAMM for an unlimited token allowance";
            break;
          }
        }

        return {
          request: {
            tx: {
              from: address,
              to: preset.target,
              data,
              value: "0",
              nonce,
            },
            quotedOutput,
          },
          summary,
        };
      } finally {
        setIsBuilding(false);
      }
    },
    [address, publicClient],
  );

  return { build, isBuilding };
}
