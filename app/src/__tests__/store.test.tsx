import { act, render, screen } from "@testing-library/react";
import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { externalStore, observableStore, pollStore, promiseStore, useStore, type Store } from "~/lib/store";
import { useLocalSet } from "~/hooks/use-local-value";

function Show<T>({ store, text }: { store: Store<T>; text: (v: T) => string }) {
  return <span>{text(useStore(store))}</span>;
}

describe("stores", () => {
  it("starts on the first subscriber and stops after the last", () => {
    const stop = vi.fn();
    let set!: (v: number) => void;
    const start = vi.fn((s: (v: number) => void) => ((set = s), stop));
    const store = externalStore(0, start);
    const { unmount } = render(<Show store={store} text={(v) => `v=${v}`} />);
    expect(start).toHaveBeenCalledTimes(1);
    act(() => set(2));
    expect(screen.getByText("v=2")).toBeInTheDocument();
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("runs a promise once and shows its result", async () => {
    const run = vi.fn(async () => "done");
    const store = promiseStore(run);
    render(<Show store={store} text={(v) => v ?? "waiting"} />);
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("follows an observable, then its error", () => {
    const source = new Subject<number>();
    const store = observableStore(source);
    render(<Show store={store} text={(v) => (v.error ? `error ${v.error.message}` : `value ${v.value}`)} />);
    act(() => source.next(7));
    expect(screen.getByText("value 7")).toBeInTheDocument();
    act(() => source.error(new Error("down")));
    expect(screen.getByText("error down")).toBeInTheDocument();
  });

  it("drops poll replies that haven't changed", async () => {
    let n = 1;
    const read = vi.fn(async () => ({ n }));
    const poll = pollStore(read, 60_000, (v) => String(v.n));
    const renders = vi.fn();
    function Probe() {
      renders();
      return <span>{`n=${useStore(poll.store)?.n ?? "-"}`}</span>;
    }
    render(<Probe />);
    expect(await screen.findByText("n=1")).toBeInTheDocument();
    const before = renders.mock.calls.length;
    await act(async () => poll.refresh());
    expect(renders.mock.calls.length).toBe(before);
    n = 2;
    await act(async () => poll.refresh());
    expect(screen.getByText("n=2")).toBeInTheDocument();
  });

  it("shares a localStorage set between components", () => {
    let api!: ReturnType<typeof useLocalSet>;
    function Writer() {
      api = useLocalSet("test:set");
      return null;
    }
    function Reader() {
      return <span>{`size=${useLocalSet("test:set").set.size}`}</span>;
    }
    render(<><Writer /><Reader /></>);
    act(() => api.add("a"));
    expect(screen.getByText("size=1")).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("test:set")!)).toEqual(["a"]);
    act(() => api.remove("a"));
    expect(screen.getByText("size=0")).toBeInTheDocument();
  });
});
