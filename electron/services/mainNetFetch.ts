/**
 * Main-process HTTP transport over Electron `net.fetch` (BACKLOG-3768, 3799).
 *
 * Node's TLS (undici, node-fetch, axios's http adapter, `https`) trusts only
 * Node's bundled CA list. Packaged Electron does not read NODE_EXTRA_CA_CERTS,
 * so on a PC whose antivirus or corporate proxy re-signs TLS with a root that
 * lives in the OS store (AVG/Avast Web Shield, measured on the founder's PC,
 * BACKLOG-3799 pm_comments 9fbd4880) every Node-TLS call fails with
 * "unable to verify the first certificate". `net.fetch` uses Chromium's
 * network stack, which trusts the OS certificate store and honours the system
 * proxy. Certificate validation stays ON.
 *
 * This module is the ONE transport every main-process client uses:
 *  - supabase-js            -> `supabaseNetFetch` (adds Supabase reporting)
 *  - axios (all importers)  -> `axiosNetFetch`, installed as the default
 *                              adapter's fetch by `installMainNetAxios`
 *  - googleapis / gaxios    -> `gaxiosNetFetch`, via OAuth2 `transporterOptions`
 *  - plain downloads        -> `mainNetFetch`
 *
 * Contract (from the 3768 SR ruling, unchanged):
 *  - Outside Electron (jest): `globalThis.fetch`, keyed on
 *    `process.versions.electron`, read per call. Inside Electron a missing
 *    `net.fetch` THROWS; it never falls back to Node's TLS.
 *  - Awaits `app.whenReady()` before `net.fetch`.
 *  - `credentials: "omit"` and `cache: "no-store"` are applied LAST.
 *  - The Response is rebuilt as a plain `Response` (no Electron-internal own
 *    property carrying raw headers / Set-Cookie).
 *
 * @module services/mainNetFetch
 */

import axios from "axios";
import { app, net } from "electron";

function isRequestObject(input: unknown): input is Request {
  return (
    typeof input === "object" &&
    input !== null &&
    !(input instanceof URL) &&
    typeof (input as Request).url === "string" &&
    typeof (input as Request).method === "string"
  );
}

/**
 * A `Request` object is flattened to url + init so the transport only ever
 * sees a string URL (Electron's net.fetch and undici's Request are different
 * classes; nothing relies on them being interchangeable).
 */
async function flattenInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ url: string; init: RequestInit }> {
  if (typeof input === "string") return { url: input, init: { ...init } };
  if (input instanceof URL) return { url: input.href, init: { ...init } };
  if (isRequestObject(input)) {
    const method = input.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && input.body !== null;
    const body = hasBody ? new Uint8Array(await input.arrayBuffer()) : undefined;
    return {
      url: input.url,
      init: {
        method,
        headers: input.headers,
        body,
        signal: input.signal,
        redirect: input.redirect,
        ...init,
      },
    };
  }
  return { url: String(input), init: { ...init } };
}

async function transport(url: string, init: RequestInit): Promise<Response> {
  if (!process.versions.electron) {
    // Not running in Electron (jest): Node's fetch.
    return globalThis.fetch(url, init);
  }
  if (!net || typeof net.fetch !== "function") {
    throw new Error("Electron net.fetch is unavailable in the main process");
  }
  if (!app.isReady()) {
    await app.whenReady();
  }
  return net.fetch(url, init);
}

/**
 * Fetch from the main process over Chromium's network stack.
 * Rejections are the transport's own error objects, unchanged.
 */
export async function mainNetFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const flat = await flattenInput(input, init);
  const raw = await transport(flat.url, {
    ...flat.init,
    credentials: "omit",
    cache: "no-store",
  });
  return new Response(raw.body, {
    status: raw.status,
    statusText: raw.statusText,
    headers: raw.headers,
  });
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

/**
 * The `fetch` axios's fetch adapter calls. A transport rejection is rethrown
 * as `TypeError("fetch failed", { cause })` — undici's shape — so axios maps
 * it to `AxiosError` code `ERR_NETWORK` with the original error as `cause`,
 * exactly as it did over Node's fetch. HTTP errors still arrive as responses,
 * so `error.response.status` / `error.response.data` are unchanged.
 */
export async function axiosNetFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await mainNetFetch(input, init);
  } catch (err) {
    if (isAbort(err)) throw err;
    throw Object.assign(new TypeError("fetch failed"), { cause: err });
  }
}

/**
 * Point the default axios instance at `axiosNetFetch` (main process only).
 * Every `axios.get/post/request` and every instance created afterwards uses
 * it. Called once from main bootstrap; idempotent.
 */
export function installMainNetAxios(instance: typeof axios = axios): void {
  instance.defaults.adapter = "fetch";
  instance.defaults.env = {
    ...(instance.defaults.env ?? {}),
    fetch: axiosNetFetch,
  };
}

interface GaxiosLikeOptions {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: unknown;
  signal?: AbortSignal | null;
}

async function toBody(body: unknown): Promise<BodyInit | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return body as BodyInit;
  }
  if (body instanceof URLSearchParams) return body.toString();
  // Node Readable (gaxios multipart): collect it. Request bodies here are
  // small (token forms, JSON); Keepr never uploads through googleapis.
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }
  return body as BodyInit;
}

/**
 * The `fetchImplementation` handed to gaxios (googleapis / google-auth-library)
 * via `transporterOptions`. gaxios calls `fetchImpl(url, opts)` with its whole
 * options bag; only the fetch fields are forwarded.
 */
export async function gaxiosNetFetch(
  url: string | URL,
  opts: GaxiosLikeOptions = {},
): Promise<Response> {
  return mainNetFetch(url instanceof URL ? url.href : url, {
    method: opts.method,
    headers: opts.headers as HeadersInit | undefined,
    body: await toBody(opts.body),
    signal: opts.signal ?? undefined,
    redirect: "follow",
  });
}
