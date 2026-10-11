// Bench-only shim: simple-plist's UMD wrapper cannot be bundled. Binary or XML plists.
const bplist = require("bplist-parser");
const plist = require("plist");
module.exports = {
  parse(buf) {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
    if (b.subarray(0, 6).toString("ascii") === "bplist") return bplist.parseBuffer(b)[0];
    return plist.parse(b.toString("utf8"));
  },
};
