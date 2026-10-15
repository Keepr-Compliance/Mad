// Bench-only stub: the benchmark supplies its own in-memory key; no key store is read or written.
class DataKeyUnavailableError extends Error { constructor(m) { super(m); this.name = "DataKeyUnavailableError"; } }
exports.DataKeyUnavailableError = DataKeyUnavailableError;
exports.getAtRestFiles = () => { throw new DataKeyUnavailableError("bench: no key store"); };
exports.getDataKeyService = () => { throw new DataKeyUnavailableError("bench: no key store"); };
