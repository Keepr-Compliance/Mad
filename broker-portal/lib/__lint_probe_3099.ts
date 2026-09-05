// BACKLOG-3099 control 1: deliberate ERROR-severity lint violation (eqeqeq).
// Removed before merge. If you are reading this on a merged commit, file a bug.
export const probeEq = (a: number, b: number): boolean => a == b;
