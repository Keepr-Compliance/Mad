/**
 * The capability provider and the throwing stub (BACKLOG-2962).
 *
 * The stub is the item's own stated control: *"a stub implementation that
 * throws on every method compiles and type-checks against every caller."*
 * `tsc` proves the compile half. This proves the throw half, and proves that an
 * uninstalled provider fails loudly rather than degrading silently — which for
 * a secret store would mean writing plaintext.
 */

import {
  SecretStoreUnavailableError,
  UnavailableSecretStore,
  type SecretStore,
} from "../secretStore";
import {
  getSecretStore,
  hostSecretStore,
  installSecretStore,
  resetSecretStore,
} from "../secretStoreProvider";

/** A fake with observable, distinguishable answers. */
function makeFake(tag: string): SecretStore & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isEncryptionAvailable: () => {
      calls.push("isEncryptionAvailable");
      return true;
    },
    encryptString: (plaintext: string) => {
      calls.push(`encryptString:${plaintext}`);
      return Buffer.from(`${tag}:${plaintext}`);
    },
    decryptString: (_encrypted: Buffer) => {
      calls.push("decryptString");
      return `${tag}-decrypted`;
    },
  };
}

describe("UnavailableSecretStore", () => {
  const stub = new UnavailableSecretStore();

  it("throws on isEncryptionAvailable", () => {
    expect(() => stub.isEncryptionAvailable()).toThrow(SecretStoreUnavailableError);
  });

  it("throws on encryptString", () => {
    expect(() => stub.encryptString("secret")).toThrow(SecretStoreUnavailableError);
  });

  it("throws on decryptString", () => {
    expect(() => stub.decryptString(Buffer.alloc(0))).toThrow(SecretStoreUnavailableError);
  });

  it("never returns the plaintext it was given", () => {
    // The failure mode worth naming: a stub that "helpfully" passed the value
    // through would look like a working secret store and store secrets in clear.
    let returned: unknown = "unset";
    try {
      returned = stub.encryptString("a-real-secret");
    } catch {
      returned = "threw";
    }
    expect(returned).toBe("threw");
  });

  it("names the operation and points at the composition root", () => {
    expect(() => stub.encryptString("x")).toThrow(/encryptString/);
    expect(() => stub.encryptString("x")).toThrow(/installNativeCapabilities/);
  });
});

describe("secretStoreProvider", () => {
  afterEach(() => {
    resetSecretStore();
  });

  it("defaults to the throwing stub, so a host that installs nothing fails loudly", () => {
    resetSecretStore();
    expect(() => hostSecretStore.encryptString("x")).toThrow(SecretStoreUnavailableError);
  });

  it("hostSecretStore forwards to whatever is installed", () => {
    const fake = makeFake("fake-a");
    installSecretStore(fake);

    expect(hostSecretStore.encryptString("hello").toString()).toBe("fake-a:hello");
    expect(hostSecretStore.decryptString(Buffer.alloc(0))).toBe("fake-a-decrypted");
    expect(hostSecretStore.isEncryptionAvailable()).toBe(true);
    expect(fake.calls).toEqual(["encryptString:hello", "decryptString", "isEncryptionAvailable"]);
  });

  it("resolves at CALL time, not at bind time", () => {
    // A consumer singleton binds `hostSecretStore` when its module loads, which
    // is usually BEFORE the host's composition root runs. If the forwarder
    // captured the implementation at bind time, every such singleton would be
    // stuck on the uninstalled stub for the life of the process.
    const bound = hostSecretStore; // bound while the stub is still installed
    installSecretStore(makeFake("installed-later"));

    expect(bound.encryptString("x").toString()).toBe("installed-later:x");
  });

  it("a later install replaces an earlier one", () => {
    installSecretStore(makeFake("first"));
    installSecretStore(makeFake("second"));

    expect(getSecretStore().encryptString("x").toString()).toBe("second:x");
  });

  it("resetSecretStore puts the throwing stub back", () => {
    installSecretStore(makeFake("installed"));
    resetSecretStore();

    expect(() => getSecretStore().encryptString("x")).toThrow(SecretStoreUnavailableError);
  });
});
