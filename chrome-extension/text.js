/**
 * Keepr — small text helpers shared by the content scripts (extract.js,
 * scan.js). One definition (SR clean-up): loaded first in the manifest's
 * content_scripts; required directly under Node (the tests).
 */
(function (root) {
  "use strict";

  /** Collapse every run of white space (incl. no-break / narrow no-break spaces) to one space; trim. */
  function normalizeSpace(s) {
    return String(s || "").replace(/[\s\u00a0\u202f]+/g, " ").trim();
  }

  var api = { normalizeSpace: normalizeSpace };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KeeprText = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
