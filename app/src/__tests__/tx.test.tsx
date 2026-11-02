import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { instrument, TxProvider, useTx, type TxPhase } from "~/tx";

describe("instrument", () => {
  it("reports each step in the order midnight-js runs them", async () => {
    const phases: TxPhase[] = [];
    const base = {
      proofProvider: { proveTx: vi.fn(async () => "proven") },
      walletProvider: { balanceTx: vi.fn(async () => "balanced"), getCoinPublicKey: () => "cpk", getEncryptionPublicKey: () => "epk" },
      midnightProvider: { submitTx: vi.fn(async () => "txid") },
      other: 1,
    };
    const p = instrument(base as never, (ph) => phases.push(ph)) as unknown as typeof base;
    await p.proofProvider.proveTx();
    await p.walletProvider.balanceTx();
    expect(await p.midnightProvider.submitTx()).toBe("txid");
    expect(phases).toEqual(["proving", "wallet", "sending", "confirming"]);
    expect(p.walletProvider.getCoinPublicKey()).toBe("cpk");
    expect(p.other).toBe(1);
  });
});

describe("TxProvider", () => {
  it("tracks a call through its phases to an error", async () => {
    let fail!: (e: Error) => void;
    let api!: ReturnType<typeof useTx>;
    function Probe() {
      api = useTx();
      return <ul>{api.entries.map((e) => <li key={e.id}>{`${e.label}|${e.state}|${e.phase}|${e.error ?? ""}`}</li>)}</ul>;
    }
    render(<TxProvider><Probe /></TxProvider>);
    let done!: Promise<unknown>;
    act(() => {
      done = api.track("Posting bounty", "T", () => new Promise((_, rej) => (fail = rej))).catch(() => "caught");
    });
    expect(screen.getByText("Posting bounty|running|preparing|")).toBeInTheDocument();
    act(() => api.report("wallet"));
    expect(screen.getByText("Posting bounty|running|wallet|")).toBeInTheDocument();
    await act(async () => {
      fail(new Error("rejected"));
      await done;
    });
    expect(screen.getByText("Posting bounty|failed|wallet|rejected")).toBeInTheDocument();
  });
});
