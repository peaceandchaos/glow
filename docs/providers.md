# Provider integration

Model ids were checked against the official provider and Gateway model pages on
2026-09-28. Account access and live behavior still require approved provider calls.
The server owns this allowlist. Phone requests cannot supply model URLs or ids.

| Picker      | Upstream id                    | Transport                         | Configured context window |
| ----------- | ------------------------------ | --------------------------------- | ------------------------- |
| Kimi        | `moonshotai/kimi-k3`           | Gateway Chat Completions HTTP/SSE | 1,000,000                 |
| DeepSeek    | `deepseek/deepseek-v4.1-flash` | Gateway Chat Completions HTTP/SSE | 1,000,000                 |
| GPT-6.1 Sol | `gpt-6.1-sol`                  | OpenAI Responses WebSocket        | 1,050,000                 |
| GPT-6 Astra | `gpt-6-astra`                  | OpenAI Responses WebSocket        | 1,050,000                 |
| GPT-6 Luna  | `gpt-6-luna`                   | OpenAI Responses WebSocket        | 1,050,000                 |

Sources: [Kimi](https://vercel.com/ai-gateway/models/kimi-k3),
[DeepSeek](https://vercel.com/ai-gateway/models/deepseek-v4.1-flash),
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

GPT-6 Luna is registered but is not in the default menu, so neither the picker
nor Auto can choose it until `MODEL_MENU` lists it. No live call has used it.

GPT-6.1 Sol is the default GPT; GPT-6 Astra is the strongest and most expensive
option. On 2026-10-01 one Responses WebSocket call and one Responses
HTTP-stream control call ran per model with the server's `response.create` payload
(`store: false`, encrypted reasoning, `context_management` compaction,
`max_output_tokens: 512`). All four calls completed. This shows account access
and transport acceptance for a short request only; long-context compaction is
still unverified live.

The initial application output budget is 32,768 tokens per call. This is a chosen
request budget, not a claim about the models' maximum output. A length-limited
answer is an explicit failure with its partial text retained. Worker duration and
this output budget need live verification together before release.

`ai@7.0.122` and `@ai-sdk/gateway@4.0.100` are used only for Jev evaluation. Both
Jev operations set `maxRetries: 0`. The pinned Gateway adapter passes `abortSignal`
to its HTTP call. A local fixture checks that cancellation reaches that call and
that HTTP 500 does not cause a second evaluation. Billing cessation is unverified.

## Reasoning levels and the model menu

Each registry entry in `packages/server/src/models.ts` lists the reasoning
efforts its provider accepts. A chat can store one level. The server sends it as
`reasoning.effort` on a Responses request and as `reasoning: { effort }` on a
Gateway chat-completions request. With no effort, the request has no effort
field, so the body is the same as before levels existed. Context summaries,
standalone compaction and Jev never send an effort.

| Model               | Accepted efforts                                | Default effort |
| ------------------- | ----------------------------------------------- | -------------- |
| DeepSeek V4.1 Flash | `none`, `low`, `high`, `max`                    | none sent      |
| Kimi K3             | `none`, `low`, `high`, `max`                    | none sent      |
| GPT-6.1 Sol         | `low`, `medium`, `high`, `xhigh`, `max`         | `medium`       |
| GPT-6 Astra         | `low`, `medium`, `high`, `xhigh`, `max`         | `medium`       |
| GPT-6 Luna          | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `medium`       |

GPT-6 Astra does not accept `none`, so the registry does not list it.
Gateway reasoning text is not shown. Sources:
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
[Gateway reasoning](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/reasoning),
and the Gateway endpoint pages under "Gateway hosts". No live call has checked
an effort value yet.

`GET /v1/models` serves the menu to a signed-in phone: the models in order,
their labels, the levels each one offers, each default level, whether the app
sends a reply request over HTTP (Gateway models) or the socket (OpenAI models),
and whether Auto is offered. The first model is the fallback. A stored model the
menu does not offer runs the first model, and a stored level the model does not
offer runs the model's default level. Under Auto, Jev chooses only among the offered models,
and its choice runs at that model's default level.

The `MODEL_MENU` server setting replaces the whole default menu with one JSON
value. The value below is the default menu:

```json
{
  "auto": true,
  "models": [
    {
      "model": "deepseek",
      "levels": ["none", "low", "high", "max"],
      "defaultLevel": null
    },
    {
      "model": "kimi",
      "levels": ["none", "low", "high", "max"],
      "defaultLevel": null
    },
    {
      "model": "gpt-6.1-sol",
      "levels": ["low", "medium", "high", "xhigh", "max"],
      "defaultLevel": "medium"
    },
    {
      "model": "gpt-6-astra",
      "levels": ["low", "medium", "high", "xhigh", "max"],
      "defaultLevel": "medium"
    }
  ]
}
```

Each `model` must be a registry key, listed once. Each `levels` list must be a
subset of the model's accepted efforts. `defaultLevel` is `null` (no effort
sent) or one of the listed levels. An invalid value is logged as
`MODEL_MENU ignored: <reason>`, and the server serves the default menu. A
changed value takes effect on the next deployment.

## Gateway hosts for Kimi and DeepSeek

Every Gateway chat-completions request sends this, with `order` and `only` set
to the same list:

```json
"providerOptions": {
  "gateway": {
    "order": ["<host>", "<host>"],
    "only": ["<host>", "<host>"],
    "disallowPromptTraining": true,
    "inferenceRegion": { "scope": "zone", "geoRegion": "us" }
  }
}
```

The Gateway then tries only these hosts, in this order:

| Model               | Hosts                  |
| ------------------- | ---------------------- |
| DeepSeek V4.1 Flash | `fireworks`, `baseten` |
| Kimi K3             | `bedrock`, `fireworks` |

- DeepSeek runs only on US hosts with zero-retention terms.
- Kimi's hosts are the only US zero-retention hosts whose Kimi K3 endpoint reads
  images. Baseten's Kimi endpoint has no vision tag. Bedrock goes first because
  it lists no quantization. Bedrock costs 10% more in the US zone. Fireworks
  serves fp4, costs 50% more, and is the only one with file input.
- `gatewayHosts` in `packages/server/src/models.ts` owns the lists. Its type
  admits only Gateway models, and `GatewayClient` refuses any other model
  before it sends a request, so a GPT request never reaches the Gateway.
- The request does not send `zeroDataRetention`, because per-request ZDR needs
  a Pro or Enterprise plan. The `only` lists already keep requests on hosts with
  Vercel ZDR agreements.
- `disallowPromptTraining` works on every plan.
- No live request has checked `inferenceRegion` yet. A region the Gateway
  cannot honor fails with HTTP 400 and does not reroute.

Sources, read 4 October 2026:
[DeepSeek V4.1 Flash endpoints](https://ai-gateway.vercel.sh/v1/models/deepseek/deepseek-v4.1-flash/endpoints),
[Kimi K3 endpoints](https://ai-gateway.vercel.sh/v1/models/moonshotai/kimi-k3/endpoints),
[provider filtering and ordering](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering),
[disallow prompt training](https://vercel.com/docs/ai-gateway/security-and-compliance/disallow-prompt-training),
[regional inference](https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference),
[ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr).

## Context methods and provenance

OpenAI uses [Responses compaction](https://developers.openai.com/api/docs/guides/compaction),
`store: false`, and encrypted reasoning inclusion. Each attempt uses its own
socket. No previous-response id is required for recovery. After a regular response,
the saved working window can drop items before its last compaction item. The
standalone `/responses/compact` result is kept as its full canonical window.

Both GPT models send `compact_threshold: 200_000` tokens (set on
2026-10-01). OpenAI bills a request above 272,000 input tokens at its
long-context rate, and the request that crosses the threshold still carries the
new message and any images. OpenAI publishes no recommended value; its
compaction guide uses `200_000` in every example. The server's own
working-context `threshold` stays at 800,000 and is a separate setting. Usage
records should confirm after acceptance that no GPT request exceeded 272,000
input tokens.

Kimi's method is adapted from
[Kimi CLI at `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82`](https://github.com/MoonshotAI/kimi-cli/tree/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82):
`src/kimi_cli/soul/compaction.py`, `src/kimi_cli/config.py`, and its compact prompt.
It compacts the prefix and retains the two most recent working messages. The
threshold follows the published 0.85 ratio and reserved-space rule.

DeepSeek's method is adapted from
[DeepSeek Harness at `4878cdabd87d4041bdaff61d04c966883b9fd07a`](https://github.com/deepseek-ai/deepseek-harness/tree/4878cdabd87d4041bdaff61d04c966883b9fd07a):
its compaction-basic configuration, summarizer, and subsystem documentation.
It uses a 0.8 pressure threshold, a 0.16 retained-tail ratio, and completion
headroom. The summary call replays the prefix followed by the published
compaction instruction. Empty or limited summaries cannot become checkpoints.

The adapted prompts use general chat wording. No coding tools or harness runtime
are imported. Multimodal parts remain in the summary input; hidden reasoning is
excluded from visible summaries. Apache license and NOTICE files for Kimi and
the DeepSeek MIT license are beside the adapted source under
`packages/server/src/compaction/`.

The app uses a conservative UTF-8 byte estimate for text in working-context
pressure. Provider tokenizers are unavailable through the chosen APIs. This may
compact earlier than provider usage would require. It avoids the Kimi
reference's acknowledged multilingual undercount from `characters / 4`.

Providers count an image by its dimensions, not its encoded size, so each image
counts as a fixed 36,000 tokens whatever its length. Sources, checked
2026-10-01:

- OpenAI [images and vision](https://developers.openai.com/api/docs/guides/images-vision):
  `gpt-6-astra` covers an image with 32 px patches. Requests here set no
  `detail`, so `auto` applies, which keeps the original dimensions. The API
  rejects an image above 30,000 patches, and the model multiplier is 1.2, so one
  image costs at most 36,000 tokens. `gpt-6.1-sol` accepts images
  ([model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)) but
  is not in the guide's sizing or multiplier tables. Its image cost is assumed
  to follow the same ceiling; this is unverified.
- DeepSeek [vision](https://api-docs.deepseek.com/guides/vision/): at most
  1,024 tokens per image. The page names `deepseek-flash`; Gateway may route
  `deepseek-v4.1-flash` to another host.
- Kimi [vision](https://platform.kimi.ai/docs/guide/use-kimi-vision-model):
  `kimi-k3` accepts images. Image tokens are computed dynamically and grow with
  resolution; no formula or per-image cap is published. It recommends at most
  4096 × 2160. The 36,000 estimate is unverified for Kimi.
- Both Gateway model pages list image input that counts as input tokens.

The estimate bounds token pressure, not request bytes. Four 3 MB images are
valid in one message, and a context below the 800,000 threshold can hold about 22
images. No Gateway request-body limit is documented; a 2025
[community report](https://community.vercel.com/t/ai-gateway-payload-size/23450)
describes HTTP 413 above 4.5 MB. Actual image token usage and request-size
limits remain part of live verification.

On a provider switch, the server reconstructs only the selected path. It never
sends an OpenAI encrypted item to Gateway. Long original text can be divided into
bounded working pieces and compacted in sequence. This does not edit the visible
archive. Checkpoints include their model and ancestry anchor. An anchor from a
sibling branch is rejected. Incomplete assistant text is excluded from future
model input, while remaining visible on the phone.

All auxiliary compaction calls check Stop before they start and after they return.
There are no automatic paid-call retries. A worker deadline or ambiguous provider
disconnect preserves the partial result and requires explicit Retry.
