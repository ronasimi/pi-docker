const intEnv = (name, fallback, min, max) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

const boolEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
};

export function loadConfig() {
  // Opt-in for a single isolated Pi CLI process; never set in docker-compose.
  const diagnosticUncapped = boolEnv('PI_ATOMIC_RESULTS_DIAGNOSTIC_UNCAPPED', false);
  return Object.freeze({
    diagnosticUncapped,
    fixedProviderTools: boolEnv("PI_ATOMIC_RESULTS_FIXED_PROVIDER_TOOLS", false),
    // Bypass Pi's lease/schema budget, but retain an independent anti-loop guard.
    discoveryGuard: diagnosticUncapped ? 40 : 5,
    diagnosticDefaultSearchLimit: diagnosticUncapped
      ? intEnv('PI_ATOMIC_RESULTS_DIAGNOSTIC_DEFAULT_SEARCH_LIMIT', 1, 1, 1000)
      : 1,
    enabled: boolEnv("PI_ATOMIC_RESULTS_ENABLED", true),
    stableTools: boolEnv("PI_ATOMIC_RESULTS_STABLE_TOOLS", true),
    // Requires operator opt-in; model prompting alone never enables active LAN probes.
    allowActiveNetworkProbes: boolEnv("PI_ATOMIC_RESULTS_ALLOW_ACTIVE_NETWORK_PROBES", false),
    discoveryRefineLimit: intEnv("PI_ATOMIC_RESULTS_DISCOVERY_REFINE_LIMIT", 2, 1, 3),
    maxSchemas: diagnosticUncapped ? Number.MAX_SAFE_INTEGER : intEnv("PI_ATOMIC_RESULTS_MAX_SCHEMAS", 1, 1, 1),
    leaseCapacity: diagnosticUncapped ? Number.MAX_SAFE_INTEGER : intEnv("PI_ATOMIC_RESULTS_LEASE_CAPACITY", 9, 1, 9),
    repairTextCalls: boolEnv("PI_ATOMIC_RESULTS_REPAIR_TEXT_CALLS", true),
    maxTurnCalls: intEnv("PI_ATOMIC_RESULTS_MAX_TURN_CALLS", 120, 20, 1000),
    schemaCharBudget: intEnv('PI_ATOMIC_RESULTS_SCHEMA_CHAR_BUDGET', 16384, 2048, 65536),
    queueConcurrency: intEnv('PI_ATOMIC_RESULTS_QUEUE_CONCURRENCY', 4, 1, 16),
    queueDeadlineMs: intEnv('PI_ATOMIC_RESULTS_QUEUE_DEADLINE_MS', 120000, 1000, 600000),
    maxBatchChars: intEnv('PI_ATOMIC_RESULTS_MAX_BATCH_CHARS', 12000, 2048, 24000),
    maxBlockedAttempts: intEnv('PI_ATOMIC_RESULTS_MAX_BLOCKED_ATTEMPTS', 10, 3, 40),
    maxRepeatedBlocks: intEnv('PI_ATOMIC_RESULTS_MAX_REPEATED_BLOCKS', 4, 2, 10),
    capabilityMissLimit: intEnv('PI_ATOMIC_RESULTS_CAPABILITY_MISS_LIMIT', 3, 2, 6),
    repeatLimit: intEnv("PI_ATOMIC_RESULTS_REPEAT_LIMIT", 3, 2, 10),
    navigationRetryLimit: intEnv("PI_ATOMIC_RESULTS_NAV_RETRY_LIMIT", 2, 1, 5),
    previewChars: intEnv("PI_ATOMIC_RESULTS_PREVIEW_CHARS", 1200, 128, 12000),
    historicalEnvelopeChars: intEnv("PI_ATOMIC_RESULTS_HISTORICAL_CHARS", 480, 128, 4000),
    maxGetChars: intEnv("PI_ATOMIC_RESULTS_MAX_GET_CHARS", 2048, 512, 8192),
    maxStepGetChars: intEnv("PI_ATOMIC_RESULTS_MAX_STEP_GET_CHARS", 4096, 1024, 12000),
    maxGetItems: intEnv("PI_ATOMIC_RESULTS_MAX_GET_ITEMS", 100, 1, 1000),
    maxSearchResults: intEnv("PI_ATOMIC_RESULTS_MAX_SEARCH_RESULTS", 10, 1, 50),
    storeInput: boolEnv("PI_ATOMIC_RESULTS_STORE_INPUT", true),
  });
}
