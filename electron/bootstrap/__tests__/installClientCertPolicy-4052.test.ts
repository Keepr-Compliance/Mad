/**
 * BACKLOG-4052: a client-certificate request from no window gets no
 * certificate. Mutation: drop preventDefault -> red.
 */
const mockOn = jest.fn();
jest.mock("electron", () => ({ app: { on: (...a: unknown[]) => mockOn(...a) } }));

import { handleSelectClientCertificate } from "../installClientCertPolicy";

describe("installClientCertPolicy", () => {
  it("registers on select-client-certificate", () => {
    expect(mockOn).toHaveBeenCalledWith("select-client-certificate", expect.any(Function));
  });

  it("no webContents: default prevented, callback with no certificate", () => {
    const event = { preventDefault: jest.fn() };
    const cb = jest.fn();
    handleSelectClientCertificate(event, null, cb);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]).toEqual([]);
  });

  it("a window's request keeps Electron's default", () => {
    const event = { preventDefault: jest.fn() };
    const cb = jest.fn();
    handleSelectClientCertificate(event, {}, cb);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
  });

  it("the registered listener applies the same rule", () => {
    const listener = mockOn.mock.calls.find((c) => c[0] === "select-client-certificate")?.[1];
    const event = { preventDefault: jest.fn() };
    const cb = jest.fn();
    listener(event, null, "https://x", [], cb);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith();
  });
});
