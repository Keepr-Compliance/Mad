/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 (SR P1 optional) — the session-change registry that replaces
 * sessionHandlers importing the Google Messages handlers.
 *
 * Mutations that turn this red: the unsubscribe not removing the listener; one
 * throwing listener stopping the others.
 */
import { emitSessionChanged, onSessionChanged, resetSessionListenersForTests } from "../authEvents";

afterEach(() => resetSessionListenersForTests());

describe("authEvents", () => {
  it("every listener hears each change until it unsubscribes", () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = onSessionChanged((c) => void a.push(`${c.kind}:${c.userId}`));
    onSessionChanged((c) => void b.push(`${c.kind}:${c.userId}`));
    emitSessionChanged({ kind: "saved", userId: "u-1" });
    offA();
    emitSessionChanged({ kind: "cleared", userId: null });
    expect(a).toEqual(["saved:u-1"]);
    expect(b).toEqual(["saved:u-1", "cleared:null"]);
  });

  it("a throwing listener does not stop the next one", () => {
    const heard: string[] = [];
    onSessionChanged(() => {
      throw new Error("bug");
    });
    onSessionChanged((c) => void heard.push(c.kind));
    expect(() => emitSessionChanged({ kind: "cleared", userId: null })).not.toThrow();
    expect(heard).toEqual(["cleared"]);
  });
});
