// Bench-only stub: the parse-copy path (SQLite) is not part of sealing.
exports.FILE_ID_PATTERN = /^[0-9a-f]{40}$/;
exports.selectReadFileRows = () => { throw new Error("not available in the seal benchmark"); };
