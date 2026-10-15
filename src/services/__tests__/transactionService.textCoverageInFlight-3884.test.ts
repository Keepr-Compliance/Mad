/**
 * BACKLOG-3884 — the Texts tab mounts TextCoverageNotice in two branches and remounts
 * it on loading flips; on the PC each ask cost ~3.5 s of main. One ask per question
 * is in flight at a time.
 */
import { transactionService } from "../transactionService";

describe("transactionService.getTextCoverage in-flight dedupe (BACKLOG-3884)", () => {
  const resolvers: Array<(v: unknown) => void> = [];
  beforeEach(() => {
    resolvers.length = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.api.transactions as any).getTextCoverage = jest.fn(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
  });

  it("concurrent asks for the same deal share one request; a later ask makes a new one", async () => {
    const get = window.api.transactions.getTextCoverage as jest.Mock;
    const answer = { success: true, auditStartISO: null, gaps: [] };
    const a = transactionService.getTextCoverage("t1", "u1", "iphone");
    const b = transactionService.getTextCoverage("t1", "u1", "iphone");
    const other = transactionService.getTextCoverage("t2", "u1", "iphone");
    expect(get.mock.calls.map((c) => c[0])).toEqual(["t1", "t2"]);
    resolvers.forEach((r) => r(answer));
    await expect(a).resolves.toEqual(answer);
    await expect(b).resolves.toEqual(answer);
    await expect(other).resolves.toEqual(answer);
    // Settled: the next ask is a new request.
    const c = transactionService.getTextCoverage("t1", "u1", "iphone");
    expect(get).toHaveBeenCalledTimes(3);
    resolvers[2](answer);
    await c;
  });
});
