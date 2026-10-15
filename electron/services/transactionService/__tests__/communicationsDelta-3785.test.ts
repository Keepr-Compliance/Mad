/**
 * @jest-environment node
 *
 * BACKLOG-3785 — computeCommunicationsDelta: rows not held are `added`, held
 * ids absent from the fresh read are `removedIds`, nothing else.
 */
import { computeCommunicationsDelta } from "../communicationsDelta";

describe("computeCommunicationsDelta (BACKLOG-3785)", () => {
  it("returns only unheld rows and only vanished ids", () => {
    const fresh = [{ id: "a" }, { id: "b" }, { id: "d" }];
    const delta = computeCommunicationsDelta(fresh, ["a", "b", "c"]);
    expect(delta.added).toEqual([{ id: "d" }]);
    expect(delta.removedIds).toEqual(["c"]);
    expect(delta.total).toBe(3);
  });

  it("is empty when the caller already holds exactly the fresh set", () => {
    const delta = computeCommunicationsDelta([{ id: "a" }, { id: "b" }], ["b", "a"]);
    expect(delta).toEqual({ added: [], removedIds: [], total: 2 });
  });

  it("with nothing held, everything is added", () => {
    const delta = computeCommunicationsDelta([{ id: "a" }], []);
    expect(delta.added).toEqual([{ id: "a" }]);
    expect(delta.removedIds).toEqual([]);
  });
});
