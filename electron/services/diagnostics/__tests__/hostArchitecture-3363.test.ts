/**
 * BACKLOG-3363 C2: diagnostics carry the four raw inputs behind the
 * Windows-on-ARM decision, not only the derived boolean.
 */
const mockApp: { runningUnderARM64Translation?: unknown } = {};
jest.mock("electron", () => ({ app: mockApp }));

import * as os from "os";
import { getHostArchitecture } from "../hostArchitecture";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;

function setHost(platform: string, arch: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
  delete mockApp.runningUnderARM64Translation;
});

describe("getHostArchitecture (BACKLOG-3363)", () => {
  it("Windows on ARM (x64 under emulation): raw inputs + windows_arm64 true", () => {
    setHost("win32", "x64");
    mockApp.runningUnderARM64Translation = true;
    const h = getHostArchitecture();
    expect(h).toEqual({
      platform: "win32",
      arch: "x64",
      running_under_arm64_translation: true,
      os_machine: os.machine(),
      windows_arm64: true,
    });
  });

  it("property absent: translation recorded as null, windows_arm64 false", () => {
    setHost("win32", "x64");
    const h = getHostArchitecture();
    expect(h.running_under_arm64_translation).toBeNull();
    expect(h.windows_arm64).toBe(false);
  });

  it("Apple Silicon Mac under Rosetta: translation true but windows_arm64 false", () => {
    setHost("darwin", "x64");
    mockApp.runningUnderARM64Translation = true;
    const h = getHostArchitecture();
    expect(h.running_under_arm64_translation).toBe(true);
    expect(h.windows_arm64).toBe(false);
  });
});
