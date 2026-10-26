import Anthropic from "@anthropic-ai/sdk";
import type { Provider } from "./index.js";

const MAX_TOKENS = 16000;

export function createAnthropicProvider(
  opts: { model: string },
  env: NodeJS.ProcessEnv = process.env,
): Provider {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Export it in your shell, then run docsync again.");
  }
  const client = new Anthropic({ apiKey });

  return {
    async complete(system, user) {
      let res: Anthropic.Message;
      try {
        res = await client.messages.create({
          model: opts.model,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: "user", content: user }],
        });
      } catch (err) {
        throw new Error(describeApiError(err), { cause: err });
      }
      if (res.stop_reason === "refusal") {
        throw new Error("The model declined this request (refusal).");
      }
      if (res.stop_reason === "max_tokens") {
        throw new Error("The model's reply was cut off (max_tokens reached).");
      }
      return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    },
  };
}

function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit (429). Try again shortly.";
  if (err instanceof Anthropic.NotFoundError) return "Anthropic API returned 404. Check the model name in docsync.config.json.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check your network connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}
