/**
 * BACKLOG-3953 C10: the runtime list of required iPhone tool files and the Store
 * packaging list (BACKLOG-3927, manifest `store.files`) are the same set.
 *
 * If the Store build stops shipping a file the runtime still requires, every Store user
 * is told their antivirus removed it. If the runtime stops requiring a file the Store
 * still ships, nothing breaks, but the lists have drifted and one of them is wrong.
 */
import fs from "fs";
import path from "path";
import { REQUIRED_IPHONE_TOOL_FILES } from "../libimobiledeviceService";

const MANIFEST = path.join(__dirname, "../../../resources/pinned/libimobiledevice.manifest.json");

describe("BACKLOG-3953: runtime required files == Store packaging list", () => {
  it("REQUIRED_IPHONE_TOOL_FILES equals manifest store.files", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as { store?: { files?: string[] } };
    const storeFiles = manifest.store?.files ?? [];
    expect(storeFiles.length).toBeGreaterThan(0);
    expect([...REQUIRED_IPHONE_TOOL_FILES].sort()).toEqual([...storeFiles].sort());
  });

  it("every required file is in the dev tools folder git tracks (dev builds see no block)", () => {
    const dir = path.join(__dirname, "../../../resources/win/libimobiledevice");
    for (const name of REQUIRED_IPHONE_TOOL_FILES) {
      expect(fs.statSync(path.join(dir, name)).size).toBeGreaterThan(0);
    }
  });
});
