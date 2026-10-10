// Batch preflight catches invalid inputs before any member executes. Pi's
// executeTool validation remains the final boundary for every individual call.
export function validateArguments(schema, value, path = '$', root = schema, depth = 0) {
  const fail = message => { throw new Error(`Invalid batch arguments at ${path}: ${message}`); };
  if (depth > 64) fail('schema nesting limit exceeded');
  if (schema === false) fail('value forbidden');
  if (!schema || schema === true) return;
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) fail('external schema reference cannot be preflighted');
    let target = root;
    for (const part of schema.$ref.slice(2).split('/')) target = target?.[part.replaceAll('~1','/').replaceAll('~0','~')];
    if (!target) fail('unknown schema reference');
    validateArguments(target, value, path, root, depth + 1);
  }
  const check = s => { try { validateArguments(s, value, path, root, depth + 1); return true; } catch { return false; } };
  if (schema.anyOf && !schema.anyOf.some(check)) fail('no anyOf alternative matches');
  if (schema.oneOf && schema.oneOf.filter(check).length !== 1) fail('oneOf requires exactly one matching alternative');
  for (const s of schema.allOf ?? []) validateArguments(s, value, path, root, depth + 1);
  if (schema.not && check(schema.not)) fail('forbidden schema matched');
  if (schema.if) validateArguments(check(schema.if) ? schema.then : schema.else, value, path, root, depth + 1);
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) fail('constant mismatch');
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) fail('value is outside enum');
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) fail(`expected ${schema.type}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) fail('above maximum');
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail('below exclusive minimum');
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) fail('above exclusive maximum');
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) fail('string too short');
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) fail('string too long');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('pattern mismatch');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('too many items');
    if (schema.uniqueItems && new Set(value.map(v=>JSON.stringify(v))).size !== value.length) fail('items must be unique');
    value.forEach((item,index)=>validateArguments(schema.prefixItems?.[index] ?? (Array.isArray(schema.items) ? schema.items[index] : schema.items),item,`${path}.${index}`,root,depth+1));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value,key)) fail(`missing ${key}`);
    for (const [key,child] of Object.entries(value)) {
      const property = schema.properties?.[key];
      const patterns = Object.entries(schema.patternProperties ?? {}).filter(([pattern])=>new RegExp(pattern).test(key));
      if (property !== undefined) validateArguments(property,child,`${path}.${key}`,root,depth+1);
      for (const [,s] of patterns) validateArguments(s,child,`${path}.${key}`,root,depth+1);
      if (property === undefined && !patterns.length) {
        if (schema.additionalProperties === false) fail(`unknown property ${key}`);
        if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateArguments(schema.additionalProperties,child,`${path}.${key}`,root,depth+1);
      }
    }
  }
}
