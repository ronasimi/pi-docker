import assert from 'node:assert/strict';

export async function inspectOllamaRuntime({ baseUrl, model, digest, contextWindow = 32768, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(30000) });
  assert(response.ok, `Ollama running-model inspection failed: HTTP ${response.status}`);
  const data = await response.json();
  assert(Array.isArray(data.models), 'Ollama did not return a running-model catalog');
  const loaded = data.models.find(item => item.name === model || item.model === model);
  assert(loaded, `Cannot verify loaded context: ${model} is absent from Ollama /api/ps`);
  assert.equal(loaded.context_length, contextWindow, `Loaded Ollama context differs for ${model}`);
  if (digest) assert.equal(loaded.digest, digest, 'Loaded alias digest changed during the inference probe');
  const bytes = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { status: 'passed', model, digest: loaded.digest, contextWindow: loaded.context_length,
    sizeBytes: bytes(loaded.size), vramBytes: bytes(loaded.size_vram), checkedAt: new Date().toISOString() };
}
