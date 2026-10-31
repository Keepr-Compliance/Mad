/**
 * BACKLOG-3799: the Anthropic and OpenAI SDK clients use mainNetFetch
 * (Chromium network stack), not the SDKs' default Node fetch.
 */
const mockAnthropic = jest.fn();
const mockOpenAI = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: mockAnthropic }));
jest.mock("openai", () => ({ __esModule: true, default: mockOpenAI }));

import fs from "fs";
import path from "path";
import ts from "typescript";
import { mainNetFetch } from "../../mainNetFetch";
import { AnthropicService } from "../anthropicService";
import { OpenAIService } from "../openAIService";

describe("LLM SDK transport", () => {
  it("Anthropic client is given mainNetFetch", () => {
    new AnthropicService().initialize("k");
    expect(mockAnthropic.mock.calls[0][0].fetch).toBe(mainNetFetch);
  });
  it("OpenAI client is given mainNetFetch", () => {
    new OpenAIService().initialize("k");
    expect(mockOpenAI.mock.calls[0][0].fetch).toBe(mainNetFetch);
  });
});

// BACKLOG-4052: the API-key check builds its own client; it must use
// mainNetFetch too. Mutation: drop the fetch option from either → red.
describe("validateApiKey transport (4052)", () => {
  it("Anthropic validateApiKey client is given mainNetFetch", async () => {
    await new AnthropicService().validateApiKey("k").catch(() => undefined);
    expect(mockAnthropic.mock.calls.at(-1)?.[0].fetch).toBe(mainNetFetch);
  });
  it("OpenAI validateApiKey client is given mainNetFetch", async () => {
    await new OpenAIService().validateApiKey("k").catch(() => undefined);
    expect(mockOpenAI.mock.calls.at(-1)?.[0].fetch).toBe(mainNetFetch);
  });
  it("class guard: every new Anthropic(/new OpenAI( in electron/ passes a fetch option", () => {
    const root = path.resolve(__dirname, "../../..");
    const bad: string[] = [];
    let seen = 0;
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!["node_modules", "__tests__", "__mocks__"].includes(e.name)) walk(p);
          continue;
        }
        if (!/\.ts$/.test(e.name) || /\.test\.ts$|\.d\.ts$/.test(e.name)) continue;
        const sf = ts.createSourceFile(p, fs.readFileSync(p, "utf8"), ts.ScriptTarget.Latest, true);
        const visit = (n: ts.Node): void => {
          if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ["Anthropic", "OpenAI"].includes(n.expression.text)) {
            seen++;
            const a = n.arguments?.[0];
            const ok = !!a && ts.isObjectLiteralExpression(a) && a.properties.some((pr) => !!pr.name && ts.isIdentifier(pr.name) && pr.name.text === "fetch");
            if (!ok) bad.push(`${path.relative(root, p)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    };
    walk(root);
    expect(seen).toBeGreaterThanOrEqual(4);
    expect(bad).toEqual([]);
  });
});
