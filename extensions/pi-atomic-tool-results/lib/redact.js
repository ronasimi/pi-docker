// Redact before persistence, projection or diagnostics. Never redact tool schemas.
const sensitive = /^(?:key|psk|sae_password|wep_key\d*|wpa_psk|passphrase|password|passwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie|set-cookie|private[_-]?key|client_secret|auth[_-]?token|session[_-]?token|credentials)$/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && typeof value.path === 'string' && sensitive.test(value.path.split('.').at(-1)) && Object.hasOwn(value, 'value')) return {...Object.fromEntries(Object.entries(value).filter(([k])=>k!=='value').map(([k,v])=>[k,redact(v)])),value:'[redacted]'};
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, sensitive.test(k.split('.').at(-1)) ? '[redacted]' : redact(v)]));
  if (typeof value !== 'string') return value;
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(redact(parsed)); } catch {}
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+\/_=.-]+/gi, '$1 [redacted]')
    .replace(/((?:[\w@\[\].-]+\.)?(?:key|psk|sae_password|wep_key\d*|wpa_psk|passphrase|password|passwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|cookie|client_secret)\s*(?:=|:)\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n]+)/gi, '$1[redacted]')
    .replace(/(\boption\s+(?:key|psk|sae_password|wep_key\d*|wpa_psk|passphrase|password|secret|token)\s+)(?:"[^"\n]*"|'[^'\n]*'|[^\s\n]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
}
