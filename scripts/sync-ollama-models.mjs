import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434').replace(/\/$/, '');
const outputPath = process.env.PI_MODELS_FILE || '/home/pi/.pi/agent/models.json';
const overridesPath = process.env.PI_MODELS_OVERRIDES || '/etc/pi/models-overrides.json';
const contextCap = Math.max(2048, Number(process.env.PI_OLLAMA_CONTEXT_CAP || 65536));
const maxTokensDefault = Math.max(256, Number(process.env.PI_OLLAMA_MAX_TOKENS || 4096));
const retrySeconds = Math.max(0, Number(process.env.PI_OLLAMA_DISCOVERY_RETRY_SECONDS || 30));
const hideAliasSources = !['0', 'false', 'no'].includes(String(process.env.PI_OLLAMA_HIDE_ALIAS_SOURCES || 'true').toLowerCase());

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`);
  }
  return response.json();
}

async function getTagsWithRetry() {
  const deadline = Date.now() + retrySeconds * 1000;
  let lastError;
  do {
    try {
      return await fetchJson(`${baseUrl}/api/tags`);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await sleep(1500);
    }
  } while (true);
  throw lastError;
}

async function loadOverrides() {
  try {
    return JSON.parse(await fs.readFile(overridesPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function findContextLength(model, show) {
  const direct = Number(model?.details?.context_length || show?.details?.context_length || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;

  for (const [key, value] of Object.entries(show?.model_info || {})) {
    if (key.endsWith('.context_length') || key === 'context_length') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 32768;
}

async function enrich(model) {
  let show = {};
  if (!Array.isArray(model?.capabilities) || !model?.details?.context_length) {
    try {
      show = await fetchJson(`${baseUrl}/api/show`, {
        method: 'POST',
        body: JSON.stringify({ model: model.name }),
      });
    } catch (error) {
      console.error(`[pi] Warning: could not inspect ${model.name}: ${error.message}`);
    }
  }

  const capabilities = Array.isArray(model?.capabilities)
    ? model.capabilities
    : (Array.isArray(show?.capabilities) ? show.capabilities : []);

  const nativeContext = findContextLength(model, show);
  const contextWindow = model.name.endsWith('-64k')
    ? Math.min(65536, contextCap)
    : Math.min(nativeContext, contextCap);

  const input = ['text'];
  if (capabilities.includes('vision')) input.push('image');

  return {
    id: model.name,
    name: model.name,
    reasoning: capabilities.includes('thinking'),
    input,
    contextWindow,
    maxTokens: Math.min(maxTokensDefault, Math.max(256, contextWindow - 256)),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

async function main() {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const overrides = await loadOverrides();

  let tags;
  try {
    tags = await getTagsWithRetry();
  } catch (error) {
    try {
      await fs.access(outputPath);
      console.error(`[pi] Ollama discovery failed (${error.message}); keeping existing ${outputPath}`);
      return;
    } catch {
      throw new Error(`Ollama discovery failed and no existing models.json is available: ${error.message}`);
    }
  }

  const tagModels = (tags.models || []).filter(model => model?.name);
  const names = new Set(tagModels.map(model => model.name));
  const visibleTagModels = hideAliasSources
    ? tagModels.filter(model => !names.has(`${model.name}-64k`))
    : tagModels;

  const discovered = [];
  for (const model of visibleTagModels) {
    const detected = await enrich(model);
    const override = overrides?.models?.[model.name] || overrides?.[model.name] || {};
    discovered.push({ ...detected, ...override, id: model.name });
  }

  discovered.sort((a, b) => {
    const aAlias = a.id.endsWith('-64k') ? 0 : 1;
    const bAlias = b.id.endsWith('-64k') ? 0 : 1;
    return aAlias - bAlias || a.id.localeCompare(b.id);
  });
  if (discovered.length === 0) {
    throw new Error('Ollama returned no installed models');
  }

  const config = {
    providers: {
      ollama: {
        baseUrl: `${baseUrl}/v1`,
        api: 'openai-completions',
        apiKey: 'ollama',
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
        },
        models: discovered,
      },
    },
  };

  const tmp = `${outputPath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, outputPath);

  console.error(`[pi] Discovered ${discovered.length} Ollama model(s):`);
  for (const model of discovered) {
    console.error(`[pi]   ${model.id} ctx=${model.contextWindow} reasoning=${model.reasoning} input=${model.input.join(',')}`);
  }
}

main().catch(error => {
  console.error(`[pi] Model discovery failed: ${error.stack || error.message}`);
  process.exit(1);
});
