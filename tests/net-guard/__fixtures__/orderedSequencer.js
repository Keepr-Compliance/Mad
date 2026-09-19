/**
 * BACKLOG-3284 fixture scaffolding — a deterministic test ORDER for the red-proof.
 *
 * The record-file collision it proves is order-dependent by nature: a consuming file
 * can only delete a record that is ALREADY in the worker's record file, so the file
 * that writes the record has to run FIRST. jest's default sequencer orders by cached
 * duration and then by file size, neither of which is a contract — inheriting it
 * would make the control silently vacuous the day a timing lands in the cache. This
 * one orders by KEEPR_NET_GUARD_FIXTURE_ORDER (comma-separated basenames), so the
 * red-proof states the order it needs.
 *
 * Not a test file: plain `.js` under __fixtures__, selected by no testMatch. Used
 * only via --testSequencer from ../__tests__/netGuard.redproof.test.js.
 */
const Sequencer = require('@jest/test-sequencer').default;

class OrderedSequencer extends Sequencer {
  sort(tests) {
    const order = (process.env.KEEPR_NET_GUARD_FIXTURE_ORDER || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const rank = (t) => {
      const i = order.findIndex((name) => t.path.endsWith(name));
      return i === -1 ? order.length : i;
    };
    return [...tests].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  }
}

module.exports = OrderedSequencer;
