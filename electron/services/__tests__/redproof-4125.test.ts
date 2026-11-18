// BACKLOG-4125 red-proof (a), THROWAWAY BRANCH ONLY: fails on macOS, passes elsewhere.
const onMac = process.platform === "darwin";

it("BACKLOG-4125 red-proof (a): fails on macOS only", () => {
  expect(onMac ? 1 : 2).toBe(2);
});
