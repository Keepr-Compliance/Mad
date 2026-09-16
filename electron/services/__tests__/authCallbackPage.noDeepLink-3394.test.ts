/**
 * BACKLOG-3394 — the page the browser lands on after a mailbox connect must not
 * fire a `keepr://` URL.
 *
 * ============================================================================
 * WHY THIS DRIVES A REAL HTTP SERVER RATHER THAN GREPPING THE SOURCE
 * ============================================================================
 *
 * A source grep for `keepr://` proves only that a literal is absent from the
 * file it reads. It cannot see a URL assembled from parts, a second page
 * builder the handler picks instead, or a request path that never reaches the
 * builder at all. What the user's browser receives is the response body on
 * `http://localhost:<port>/callback?code=…`, so that is what is asserted: the
 * service's own `startLocalServer()` is started, a real loopback request is
 * made to it, and the bytes that come back are the subject.
 *
 * Loopback is permitted by the network guard (`tests/net-guard/`); only
 * outbound connections off this machine are blocked.
 *
 * The page is asserted for BOTH providers. Google's comes from a private
 * `_buildSuccessPage()` helper and Microsoft's is an inline string in the
 * request handler — two separately-drifting copies (BACKLOG-3280 will collapse
 * them), so a control that read only one of them would prove nothing about the
 * other. The parity block is what fails when they drift again.
 */

import http from "http";
import googleAuthService from "../googleAuthService";
import microsoftAuthService from "../microsoftAuthService";

jest.mock("../databaseService");
jest.mock("axios");
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

interface LocalServerService {
  startLocalServer(): {
    codePromise: Promise<string>;
    listeningPromise: Promise<number>;
  };
  stopLocalServer(): void;
}

/**
 * Start the service's real callback server, hit it over loopback exactly as the
 * browser does, and return the response body.
 */
async function getServedCallbackPage(
  service: LocalServerService,
): Promise<string> {
  const { codePromise, listeningPromise } = service.startLocalServer();
  const port = await listeningPromise;
  expect(port).toBeGreaterThan(0);

  const body = await new Promise<string>((resolve, reject) => {
    const req = http.get(
      // `localhost`, not a literal address: the server binds with
      // `listen(0, "localhost")`, and on a machine where that resolves to ::1
      // a request to 127.0.0.1 is refused outright.
      //
      // `agent: false` because Node's global agent keeps the socket alive after
      // the response, which holds the event loop open and makes jest warn that
      // it could not exit.
      {
        host: "localhost",
        port,
        path: "/callback?code=test-authorization-code",
        agent: false,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve(data));
      },
    );
    req.on("error", reject);
  });

  // The handler resolves the code promise after writing the page; awaiting it
  // proves the request really reached the success branch and not, say, the
  // "no authorization code received" branch, which would also return 200-ish
  // HTML with no `keepr://` in it and make this control vacuous.
  await expect(codePromise).resolves.toBe("test-authorization-code");

  return body;
}

describe("BACKLOG-3394: the served post-connect page fires no keepr:// URL", () => {
  afterEach(() => {
    googleAuthService.stopLocalServer();
    microsoftAuthService.stopLocalServer();
  });

  describe.each([
    ["Google", () => googleAuthService as unknown as LocalServerService],
    ["Microsoft", () => microsoftAuthService as unknown as LocalServerService],
  ])("%s callback page", (_provider, getService) => {
    it("contains no keepr:// URL anywhere in what the browser receives", async () => {
      const page = await getServedCallbackPage(getService());

      expect(page).not.toContain("keepr://");
      expect(page.toLowerCase()).not.toContain("keepr:");
    });

    it("offers no button that could open the app, and runs no script", async () => {
      const page = await getServedCallbackPage(getService());

      // The button is what fired the deep link. A page with no <button> and no
      // <script> has nothing left that can ask the browser for permission.
      expect(page).not.toContain("<button");
      expect(page).not.toContain("Return to Application");
      expect(page).not.toContain("<script");
      expect(page).not.toContain("window.location.href");
    });

    it("tells the user the tab is finished", async () => {
      const page = await getServedCallbackPage(getService());

      expect(page).toContain("Connected");
      expect(page).toContain("You can close this tab");
    });
  });

  it("serves the same structure and copy for both providers", async () => {
    const googlePage = await getServedCallbackPage(
      googleAuthService as unknown as LocalServerService,
    );
    const microsoftPage = await getServedCallbackPage(
      microsoftAuthService as unknown as LocalServerService,
    );

    // Normalise away the indentation difference between the two copies (one is
    // a top-level template literal, the other is nested inside a handler) and
    // the one word that is legitimately allowed to differ.
    const normalise = (html: string): string =>
      html
        .replace(/\s+/g, " ")
        .replace(/Google|Microsoft/g, "<PROVIDER>")
        .trim();

    expect(normalise(googlePage)).toBe(normalise(microsoftPage));
  });
});
