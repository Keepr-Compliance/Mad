/**
 * BACKLOG-4120 PR3 — which attachment a cleanup question is about.
 * Synthetic names only.
 */
import { isPdfAttachment, pickQuestionAttachmentId, streetTokens } from "../questionAttachment";

const ADDRESS = "4120 canarytest lane, testville, zz 00000";

describe("PDF by type, or by name when the type says nothing", () => {
  it.each([
    ["application/pdf", "offer", true],
    ["APPLICATION/PDF", "offer.bin", true],
    ["application/octet-stream", "offer.pdf", true],
    ["application/octet-stream", "offer.PDF ", true],
    ["", "offer.pdf", true],
    [null, "offer.pdf", true],
    ["application/octet-stream", "offer.zip", false],
    ["image/jpeg", "photo.pdf", false],
    ["text/html", "page.pdf", false],
    [null, "photo.jpg", false],
  ])("%s + %s -> %s", (mimeType, filename, expected) => {
    expect(isPdfAttachment({ mimeType: mimeType as string | null, filename: filename as string })).toBe(expected);
  });
});

describe("the one", () => {
  it("a generic-type PDF is found; a jpg that sorts first is not picked", () => {
    expect(
      pickQuestionAttachmentId(
        [{ attachments: [{ id: "jpg", filename: "Aa.jpg", mimeType: "image/jpeg" }, { id: "pdf", filename: "Offer.pdf", mimeType: "application/octet-stream" }] }],
        ADDRESS,
      ),
    ).toBe("pdf");
  });

  it("the newest message with a PDF decides; inside it a name with the street wins; else the first", () => {
    const newest = { attachments: [{ id: "n-photo", filename: "photo.jpg", mimeType: "image/jpeg" }] };
    const middle = {
      attachments: [
        { id: "m-first", filename: "Agreement.pdf", mimeType: "application/pdf" },
        { id: "m-named", filename: "Canarytest_counter.pdf", mimeType: "application/pdf" },
      ],
    };
    const older = { attachments: [{ id: "o-named", filename: "4120 offer.pdf", mimeType: "application/pdf" }] };
    expect(pickQuestionAttachmentId([newest, middle, older], ADDRESS)).toBe("m-named");
    expect(pickQuestionAttachmentId([newest, middle, older], null)).toBe("m-first");
    expect(pickQuestionAttachmentId([newest], ADDRESS)).toBeNull();
  });

  it("street tokens: the number and the 3+-letter words of the street line", () => {
    expect(streetTokens(ADDRESS)).toEqual(["4120", "canarytest", "lane"]);
    expect(streetTokens("")).toEqual([]);
  });
});
