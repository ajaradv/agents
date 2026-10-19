# Free model lanes

`dashboard/lib/free-models.ts` (vault research note `fleet/plans/research/free-model-lanes`).

- **Lanes:** OpenRouter's zero-price models (1000 free requests a day for this
  account, 20 a minute; resets midnight UTC) and Google AI Studio's free tier
  (per-model rate limits; resets midnight Pacific; no credits, nothing expires).
- **Registry:** once a day the node lists free models, reads OpenRouter
  endpoint uptime, and runs one synthetic capability check per model (a JSON
  answer scored by code). Results: `free_models` in the metrics database, and
  Health → Usage → Free models.
- **Quota:** OpenRouter's own counter (`GET /api/v1/key`,
  `free_model_daily_requests`); Gemini calls counted by us (`free_calls`) and
  capped per model per day (`FLEET_GEMINI_DAILY_CAP`, default 200; the real
  limits are in AI Studio).
- **Calls:** `freeComplete(prompt, { purpose, needs, maxTokens, paidFallback })`
  tries up to three free models that passed today's check and fit `needs`
  (tools, images, minimum context), most reliable first, then the paid
  fallback (`FLEET_FREE_FALLBACK`, default `deepseek/deepseek-v4-flash` via
  OpenRouter; `paidFallback: null` for none). Every call is counted.
- **Privacy line:** non-sensitive text only. Never repo code, vault notes,
  chats, or secrets: Gemini's free tier may use prompts for training and human
  review, and many free OpenRouter providers log prompts. OpenRouter calls send
  `provider: { data_collection: "deny" }`, so only providers that keep prompts
  private serve them (which rules out most free NVIDIA and Poolside models).

## The public helper

Officers have `ask_public(question, text?)` (extensions/fleet.ts →
`POST /api/fleet/public` → `dashboard/lib/public-helper.ts`): a quick answer
from a free model with no tools and no file access, returned in the same call
(three free attempts of 25 s at most, then the paid fallback). For general
knowledge, drafting, and rewording or summarising public text the officer
pastes in. The node refuses text that looks private (keys, tokens, credential
assignments, local file paths, 1Password references, pastes over 12,000
characters) and logs the refusal. Each answer is a turn for `<officer>-public`
in the metrics database (model, time, cost: 0 when free) and a line on the
fleet ship's log.
