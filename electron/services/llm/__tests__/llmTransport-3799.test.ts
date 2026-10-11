/**
 * BACKLOG-3799: the Anthropic and OpenAI SDK clients use mainNetFetch
 * (Chromium network stack), not the SDKs' default Node fetch.
 */
const mockAnthropic = jest.fn();
const mockOpenAI = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: mockAnthropic }));
jest.mock("openai", () => ({ __esModule: true, default: mockOpenAI }));

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
