export const isWhiteRabbit = model => /white[-_]?rabbit[-_]?neo|^security-agent(?::|$)/i.test(model?.id ?? '');
const guidance = 'For this WhiteRabbitNeo task, analyze the objective, relevant evidence, assumptions, and proposed tool arguments before acting. Check results before concluding. Give a concise rationale and material uncertainties in the answer. Do not invent a native thinking stream or claim unperformed checks.';

export function installWhiteRabbitReasoning(pi) {
  const enabled = !/^(0|false|no)$/i.test(process.env.PI_WHITERABBIT_REASONING ?? 'true');
  const requested = process.env.PI_WHITERABBIT_THINKING_LEVEL ?? 'medium';
  const level = ['minimal', 'low', 'medium', 'high'].includes(requested) ? requested : 'medium';
  const enforce = model => {
    if (enabled && isWhiteRabbit(model) && model.reasoning && pi.getThinkingLevel() === 'off') pi.setThinkingLevel(level);
  };
  pi.on('session_start', (_event, ctx) => enforce(ctx.model));
  pi.on('model_select', event => enforce(event.model));
  pi.on('before_agent_start', (event, ctx) => {
    enforce(ctx.model);
    if (!enabled || !isWhiteRabbit(ctx.model)) return;
    // V3/Qwen2.5 has no native thinking channel. Prompted analysis is explicit
    // and does not inject unsupported reasoning_effort/think API fields.
    if (ctx.model.compat?.supportsReasoningEffort === false) {
      event.systemPromptOptions.appendSystemPrompt += '\n\n' + guidance;
    }
  });
}
