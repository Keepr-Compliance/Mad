/**
 * BACKLOG-3832 — a contact list that has never been read is LOADING, not empty.
 *
 * The new-transaction wizard and Add Contacts load lazily (`autoLoad*: false`,
 * `triggerLazyLoad` from an effect). Both halves used to report `loading: false`
 * until that effect ran, so the first paint of the picker was
 * `ContactSearchList`'s "No contacts available". Every frame is recorded here,
 * because a test that only looks after `render` returns sees the state the
 * effect already fixed.
 */
import React, { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { useContactDirectory } from "./useContactDirectory";

const USER_ID = "user-3832";

interface Frame {
  contactsLoading: boolean;
  externalContactsLoading: boolean;
  contacts: number;
  external: number;
  error: string | null;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Probe({
  frames,
  trigger,
  onApi,
}: {
  frames: Frame[];
  trigger: boolean;
  onApi?: (api: ReturnType<typeof useContactDirectory>) => void;
}) {
  const dir = useContactDirectory({
    userId: USER_ID,
    autoLoadSaved: false,
    autoLoadExternal: false,
  });
  frames.push({
    contactsLoading: dir.contactsLoading,
    externalContactsLoading: dir.externalContactsLoading,
    contacts: dir.contacts.length,
    external: dir.externalContacts.length,
    error: dir.contactsError,
  });
  onApi?.(dir);
  const { triggerLazyLoad } = dir;
  useEffect(() => {
    if (trigger) triggerLazyLoad();
  }, [trigger, triggerLazyLoad]);
  return null;
}

let getAll: jest.Mock;
let getAvailable: jest.Mock;

beforeEach(() => {
  getAll = jest.fn();
  getAvailable = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).api = {
    contacts: { getAll, getAvailable, getSortedByActivity: jest.fn() },
  };
});

describe("BACKLOG-3832 useContactDirectory: never empty before the first read ends", () => {
  it("before the lazy load is triggered, both halves read as loading", () => {
    const frames: Frame[] = [];
    render(<Probe frames={frames} trigger={false} />);
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f.contactsLoading).toBe(true);
      expect(f.externalContactsLoading).toBe(true);
    }
    expect(getAll).not.toHaveBeenCalled();
  });

  it("the step's first paint is loading; an empty answer then reads as loaded-and-empty", async () => {
    const saved = deferred<{ success: boolean; contacts: unknown[] }>();
    const external = deferred<{ success: boolean; contacts: unknown[] }>();
    getAll.mockReturnValue(saved.promise);
    getAvailable.mockReturnValue(external.promise);
    const frames: Frame[] = [];
    render(<Probe frames={frames} trigger={true} />);

    // Every frame before either read answers is loading — including the first,
    // painted before the trigger effect ran.
    expect(frames.every((f) => f.contactsLoading && f.externalContactsLoading)).toBe(true);

    await act(async () => {
      saved.resolve({ success: true, contacts: [] });
      external.resolve({ success: true, contacts: [] });
      await Promise.resolve();
    });
    const last = frames[frames.length - 1];
    expect(last).toEqual({ contactsLoading: false, externalContactsLoading: false, contacts: 0, external: 0, error: null });
  });

  it("loaded with rows: the rows, not loading", async () => {
    getAll.mockResolvedValue({ success: true, contacts: [{ id: "c1", user_id: USER_ID, display_name: "Bianca Okafor" }] });
    getAvailable.mockResolvedValue({ success: true, contacts: [] });
    const frames: Frame[] = [];
    await act(async () => {
      render(<Probe frames={frames} trigger={true} />);
    });
    const last = frames[frames.length - 1];
    expect(last.contactsLoading).toBe(false);
    expect(last.contacts).toBe(1);
  });

  it("a failed read ends loading with an error, never as an empty list", async () => {
    getAll.mockRejectedValue(new Error("database is locked"));
    getAvailable.mockResolvedValue({ success: false });
    const frames: Frame[] = [];
    await act(async () => {
      render(<Probe frames={frames} trigger={true} />);
    });
    const last = frames[frames.length - 1];
    expect(last.contactsLoading).toBe(false);
    expect(last.error).toBe("database is locked");
    // The address book's failed read (null) also ends loading — no endless spinner.
    expect(last.externalContactsLoading).toBe(false);
  });
});
