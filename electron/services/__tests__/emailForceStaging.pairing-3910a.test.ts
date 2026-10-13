/**
 * @jest-environment node
 *
 * BACKLOG-3910a — `pairStagedWithProtected`, the pure pairing step of the
 * force swap, driven directly.
 *
 * SR slice-1 review (pm_comments 10c57d40): same account + same provider id is
 * one identity by `idx_emails_account_external`, so it must pair even when the
 * Message-ID differs — an unpaired copy would hit that index on insert and roll
 * the whole re-cache back. Across accounts the Message-ID must agree.
 */

import { pairStagedWithProtected } from "../emailForceStaging";
import type { ProtectedLiveEmail } from "../db/emailForceSetSql";
import type { StagedEmailIdentity } from "../db/emailStagingSql";

const kept = (over: Partial<ProtectedLiveEmail> = {}): ProtectedLiveEmail => ({
  id: "live-1",
  external_id: "ext-1",
  message_id_header: "<old@example.com>",
  account_id: "acct-outlook",
  source: "outlook",
  thread_id: "thread-1",
  created_at: "2026-01-01 00:00:00",
  frozen: 0,
  ...over,
});

const staged = (over: Partial<StagedEmailIdentity> = {}): StagedEmailIdentity => ({
  id: "staged-1",
  external_id: "ext-1",
  message_id_header: "<new@example.com>",
  account_id: "acct-outlook",
  source: "outlook",
  thread_id: "thread-1",
  ...over,
});

describe("pairStagedWithProtected (BACKLOG-3910a)", () => {
  /**
   * MUTATION: require equal Message-IDs within the same account too (drop the
   * `sameAccount ||` term) -> unpaired, red.
   */
  it("pairs same account + same provider id even when the Message-ID differs", () => {
    const result = pairStagedWithProtected([staged()], [kept()]);

    expect(result.open.map((p) => [p.kept.id, p.staged.id])).toEqual([["live-1", "staged-1"]]);
    expect(result.frozen).toEqual([]);
    expect(result.unpaired).toEqual([]);
  });

  /** The contrast: across accounts a differing Message-ID refuses the pair. */
  it("does not pair across accounts when the Message-IDs differ", () => {
    const result = pairStagedWithProtected(
      [staged({ account_id: "acct-other" })],
      [kept()],
    );

    expect(result.open).toEqual([]);
    expect(result.unpaired.map((k) => k.id)).toEqual(["live-1"]);
  });
});
