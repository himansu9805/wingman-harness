import { ChatOpenAI } from "@langchain/openai";
import { modelRouterMiddleware } from "@langchain/typesafe/middleware";
import { settings } from "../settings";

/**
 * Creates a chat model for OpenAI or any OpenAI-compatible server (Ollama).
 * Both use Chat Completions, so a conversation can switch between them.
 *
 * @param baseUrl The server URL, or "" for OpenAI's default endpoint.
 */
function createChatModel(baseUrl: string, model: string, apiKey: string) {
  return new ChatOpenAI({
    model,
    apiKey,
    useResponsesApi: !baseUrl,
    ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
  });
}

const fastModel = createChatModel(
  settings.FAST_MODEL_BASE_URL,
  settings.FAST_MODEL_NAME,
  settings.FAST_MODEL_API_KEY,
);

export const strongModel = createChatModel(
  settings.STRONG_MODEL_BASE_URL,
  settings.STRONG_MODEL_NAME,
  settings.STRONG_MODEL_API_KEY,
);

/**
 * What the decision model is asked, per route.
 *
 * Tuned for tev1:0.8b. Small wording changes can alter routing, so evaluate
 * representative simple and tool-requiring requests after changing criteria.
 */
export const ROUTE_INSTRUCTIONS = "Which model should handle this request?";
export const ROUTE_CRITERIA = {
  fast: "Simple: chat, maths, definitions, well-known facts, or the user's saved preferences.",
  powerful:
    "Needs tools or work: commands on this computer, the web, current or recent information such as news, schedules, results and latest versions, reminders, code, or multi-step tasks.",
} as const;

/** Picks the model once per turn from the latest human message. */
export const modelRouter = modelRouterMiddleware({
  choices: {
    fast: { model: fastModel, criteria: ROUTE_CRITERIA.fast },
    powerful: { model: strongModel, criteria: ROUTE_CRITERIA.powerful },
  },
  instructions: ROUTE_INSTRUCTIONS,
  classifierOptions: {
    baseUrl: settings.DECISIONS_MODEL_BASE_URL,
    model: settings.DECISIONS_MODEL_NAME,
    apiKey: settings.DECISIONS_MODEL_API_KEY,
    timeout: 15_000,
    maxRetries: 0,
  },
});
