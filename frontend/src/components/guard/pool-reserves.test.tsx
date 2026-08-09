import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PoolReserves } from "./pool-reserves";

// The panel is a pure render of the hook's data, so the hook is stubbed and
// each test supplies the exact state it wants to assert against.
const mockUsePoolReserves = vi.fn();
vi.mock("../../hooks/usePoolReserves", () => ({
  usePoolReserves: () => mockUsePoolReserves(),
}));

describe("PoolReserves", () => {
  beforeEach(() => {
    mockUsePoolReserves.mockReset();
  });

  it("degrades to em dashes while reserves are unknown (loading or RPC failure)", () => {
    mockUsePoolReserves.mockReturnValue({ data: null });

    render(<PoolReserves />);

    expect(screen.getByText("Pool reserves")).toBeInTheDocument();
    expect(screen.getByText("Token reserve")).toBeInTheDocument();
    expect(screen.getByText("MON reserve")).toBeInTheDocument();
    // formatToken renders "—" for null, so loading and a dead RPC both show
    // the same calm empty state — no spinner, no error row.
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("shows the pool it is reading from", () => {
    mockUsePoolReserves.mockReturnValue({ data: null });

    render(<PoolReserves />);

    // shortAddress of AMM_ADDRESS from contracts/deployments.json.
    expect(screen.getByText("0x7567…Ca8e")).toBeInTheDocument();
  });

  it("renders live reserves through formatToken", () => {
    // The exact values read off-chain while writing this test: formatToken
    // (toLocaleString with maximumFractionDigits) drops trailing zeros, so
    // whole amounts render without a decimal tail.
    mockUsePoolReserves.mockReturnValue({
      data: {
        tokenReserve: 1713824095087163233028n,
        monReserve: 1633773272313338040n,
      },
    });

    render(<PoolReserves />);

    expect(screen.getByText("1,713.82")).toBeInTheDocument();
    expect(screen.getByText("1.63")).toBeInTheDocument();
  });
});
