import Anthropic from "@anthropic-ai/sdk";
import { HttpError, parseRetryAfter } from "./http.js";
import type { Provider } from "./index.js";
import { withRetry } from "./retry.js";

const MAX_TOKENS = 16000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

export function createAnthropicProvider(
  opts: { model: string; reasoningEffort?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Provider {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Export it in your shell, then run docsync again.");
  }
  if (opts.reasoningEffort && !(EFFORTS as readonly string[]).includes(opts.reasoningEffort)) {
    throw new Error(`reasoningEffort "${opts.reasoningEffort}" isn't valid for Anthropic (use ${EFFORTS.join(", ")}).`);
  }
  // Retries are done by docsync so the user can see them.
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  return {
    async complete(system, user, options) {
      const res = await withRetry(
        async () => {
          try {
            const stream = client.messages.stream({
              model: opts.model,
              max_tokens: MAX_TOKENS,
              system,
              messages: [{ role: "user", content: user }],
              ...(opts.reasoningEffort ? { output_config: { effort: opts.reasoningEffort as Effort } } : {}),
            });
            let chars = 0;
            stream.on("text", (delta) => {
              chars += delta.length;
              options?.onEvent?.({ type: "progress", chars });
            });
            return await stream.finalMessage();
          } catch (err) {
            if (err instanceof Anthropic.APIError && typeof err.status === "number") {
              throw new HttpError(describeApiError(err), err.status, parseRetryAfter(err.headers?.get("retry-after") ?? null));
            }
            throw new Error(describeApiError(err), { cause: err });
          }
        },
        { label: "Anthropic", ...(options?.onEvent ? { onEvent: options.onEvent } : {}) },
      );
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
