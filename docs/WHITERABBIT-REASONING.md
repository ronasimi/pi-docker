# WhiteRabbitNeo reasoning in Pi

The supplied Modelfile uses WhiteRabbitNeo V3 7B, a Qwen2.5-Coder derivative.
This model does **not** have Ollama-native thinking. Setting `reasoning: true`
alone cannot create a thinking channel, and sending an unsupported
`reasoning_effort` can fail or do nothing.

This update enables deliberate analysis in Pi while distinguishing the two cases:

| Ollama model capability | Pi behavior |
|---|---|
| WhiteRabbitNeo / `security-agent:7b`, without `thinking` | Pi thinking level enabled at medium; brief analysis guidance added for the turn; `supportsReasoningEffort: false` prevents unsupported request parameters |
| Matching model advertising `thinking` | Pi thinking level enabled at medium; native `reasoning_effort` enabled |
| Other models | Existing reasoning behavior retained |

The non-native fallback is **prompted analysis**, not a hidden/native thinking
stream. It requests evidence checking and a concise rationale; no fake `<think>`
wrapper, second model call, or change of model weights is introduced. Pi's UI
can display the reasoning setting, but that does not imply native thinking
tokens will appear for V3.

The extension applies on session start, model selection and before each prompt,
including restored chats whose old thinking setting is off. It respects a
non-off level already selected for WhiteRabbitNeo. Defaults:

```dotenv
PI_WHITERABBIT_REASONING=true
PI_WHITERABBIT_THINKING_LEVEL=medium
```

Set the first value to false to opt out of enforcement. This leaves ordinary Pi
manual thinking controls in charge. The model catalog continues to describe the
available reasoning mode.

Discovery uses `/api/show` capabilities and now respects a configured `num_ctx`
before the architecture's maximum context. `security-agent:7b` keeps 16,384
context tokens and 4,096 maximum output tokens. Native capability detection
works for direct WhiteRabbitNeo names and the supplied `security-agent` alias.
The fallback catalog includes the alias, but does not download or create it.

Rebuild Pi, recreate its container and start a new chat:

```bash
docker compose up -d --build --force-recreate pi
docker compose logs --tail=60 pi
docker compose exec -T pi jq '.providers.ollama.models[] | select(.id == "security-agent:7b") | {id,reasoning,compat,contextWindow}' /home/pi/.pi/agent/models.json
```

For V3, expect `reasoning: true`, `supportsReasoningEffort: false`, and a startup
log stating `prompted reasoning; native Ollama thinking unsupported`.

The tests execute real Pi 0.99.1 sessions against a local mock HTTP provider and
inspect the outgoing requests. They verify prompted guidance without an
unsupported parameter, and `reasoning_effort: medium` for a native-capable
fixture. Actual inference on the user's Ollama model is still a deployment check.

Sources: [model card](https://huggingface.co/WhiteRabbitNeo/WhiteRabbitNeo-V3-7B),
[Ollama thinking](https://docs.ollama.com/capabilities/thinking), and the published
Pi 0.99.1 package's extension API and provider implementation.
