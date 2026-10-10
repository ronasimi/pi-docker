import { selectArchiveValue, boundValue } from './retrieve.js';
import { classifyOutcome } from './outcome.js';
import { redact } from './redact.js';
export const BATCH_SCHEMA = {type:'object',additionalProperties:false,required:['calls'],properties:{calls:{type:'array',minItems:1,maxItems:16,items:{type:'object',additionalProperties:false,required:['id','name','arguments'],properties:{id:{type:'string',minLength:1,maxLength:128},name:{type:'string',minLength:1,maxLength:256},arguments:{type:'object',additionalProperties:true},depends_on:{type:'array',items:{type:'string',maxLength:256}},select:{type:'array',maxItems:12,items:{type:'string',maxLength:256}}}}}}};
export async function executeBatch(calls, invoke, {maxChars = 12000} = {}) {
  const nodes = new Map(calls.map(c => [c.id, c]));
  if (nodes.size !== calls.length) throw new Error('Duplicate batch id');
  const visited = new Set(), visiting = new Set();
  function check(id) {
    if (visiting.has(id)) throw new Error('Dependency cycle');
    if (visited.has(id)) return;
    const call = nodes.get(id);
    if (!call) throw new Error('Unknown dependency');
    if (['tool_batch', 'tool_invoke'].includes(call.name)) throw new Error('Nested batch/wrapper forbidden');
    visiting.add(id);
    for (const dependency of call.depends_on ?? []) check(dependency);
    visiting.delete(id); visited.add(id);
  }
  calls.forEach(c => check(c.id));
  const jobs = new Map();
  const perCall = Math.max(32, Math.floor(maxChars / calls.length) - 400);
  function run(id) {
    if (jobs.has(id)) return jobs.get(id);
    const call = nodes.get(id);
    const job = (async () => {
      const dependencies = await Promise.all((call.depends_on ?? []).map(run));
      if (dependencies.some(d => d.status !== 'ok')) return {id, status:'dependency_failed'};
      try {
        const result = redact(await invoke(call));
        const ref = result.details?.atomicInvocation?.ref;
        const outcome = classifyOutcome({...result, isError:result.isError || result.details?.atomicInvocation?.isError});
        if (!outcome.usable) return {id, status:outcome.execution === 'failed' ? 'failed' : 'unavailable',
          result_ref:ref, error:boundValue(result.content, {maxChars:perCall, limit:2})};
        const selectors = call.select?.length ? call.select : [selectArchiveValue(result, 'json') === undefined ? 'content' : 'json'];
        const selections = selectors.map(selector => {
          const value = selectArchiveValue(result, selector);
          return value === undefined ? {selector, ok:false, error:'Selector not found'} :
            {selector, ok:true, ...boundValue(value, {maxChars:Math.max(1, Math.floor(perCall / selectors.length) - 100), limit:50})};
        });
        return {id, status:'ok', result_ref:ref, reused:result.details?.atomicInvocation?.reused === true, selections};
      } catch (error) {
        return {id, status:'failed', error:String(redact(error.message ?? error)).slice(0, perCall)};
      }
    })();
    jobs.set(id, job); return job;
  }
  const results = await Promise.all(calls.map(c => run(c.id)));
  // Bound the whole response including JSON metadata, not each value separately.
  while (JSON.stringify({results}).length > maxChars) {
    const row = [...results].reverse().find(r => r.selections?.length || r.error);
    if (!row) throw new Error('Batch metadata exceeds response budget; use fewer calls or shorter IDs');
    if (row.selections?.length) row.selections.pop();
    else delete row.error;
    row.projectionOmitted = true;
  }
  return results;
}
