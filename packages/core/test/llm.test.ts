import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeLLM, openrouterTransport } from "../src/providers/llm";

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter transport", () => {
  it("sends a strict JSON schema request and parses the answer", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ finish_reason: "stop", message: { content: '```json\n{"title":"T","scenes":[{"narration":"Hi","visual":"sky","onScreen":""}]}\n```' } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const llm = new ClaudeLLM("test", openrouterTransport("sk-test", "anthropic/claude-opus-5.5"));
    const script = await llm.writeScript({ prompt: "x", seconds: 10, style: "s", aspect: "9:16" });
    expect(script.title).toBe("T");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("anthropic/claude-opus-5.5");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("surfaces API errors and truncated answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "No credits" } }, { status: 402 })));
    const llm = new ClaudeLLM("test", openrouterTransport("k"));
    await expect(llm.writeScript({ prompt: "x", seconds: 10, style: "s", aspect: "9:16" })).rejects.toThrow(/402: No credits/);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "{" } }] })));
    await expect(llm.writeScript({ prompt: "x", seconds: 10, style: "s", aspect: "9:16" })).rejects.toThrow(/cut off/);
  });
});
