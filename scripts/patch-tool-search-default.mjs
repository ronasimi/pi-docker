#!/usr/bin/env node
// Narrow, fail-closed Pi 1.0.0 build patch: make omitted tool_search.limit default
// to 1 instead of 8. Explicit caller limits are unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const oldDescription = 'Maximum number of tools to return. Defaults to 8.';
const newDescription = 'Maximum number of tools to return. Defaults to 1.';

function filesUnder(root) {
  const out=[];
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    const file=path.join(root,entry.name);
    if(entry.isDirectory())out.push(...filesUnder(file));
    else if(entry.isFile() && /\.(?:js|mjs)$/.test(entry.name))out.push(file);
  }
  return out;
}

export function patchToolSearchSource(source) {
  if(!/(?:tool_search|tool-search|ToolSearch)/.test(source) && !source.includes(oldDescription)) return {source,descriptionEdits:0,defaultEdits:0};
  let descriptionEdits=0,defaultEdits=0;
  source=source.replaceAll(oldDescription,()=>{descriptionEdits++;return newDescription;});
  const patterns=[
    // Typical compiled implementations: params.limit ?? 8 / args.limit || 8.
    /(\b(?:params|args|input|options)\.limit\s*\?\?\s*)8\b/g,
    /(\b(?:params|args|input|options)\.limit\s*\|\|\s*)8\b/g,
    // Named tool-search constants. Avoid changing unrelated generic limits.
    /(\b(?:DEFAULT_TOOL_SEARCH_LIMIT|TOOL_SEARCH_DEFAULT_LIMIT|DEFAULT_SEARCH_LIMIT|TOOL_SEARCH_LIMIT)\s*=\s*)8\b/g,
    // A DEFAULT_LIMIT constant is accepted only in a source file that contains tool-search markers.
    /(\bDEFAULT_LIMIT\s*=\s*)8\b/g,
    // Factory-local default values sometimes compile to `defaultLimit = 8`.
    /(\bdefaultLimit\s*=\s*)8\b/g,
    /(\bdefaultLimit\s*:\s*)8\b/g,
  ];
  for(const pattern of patterns)source=source.replace(pattern,(_m,prefix)=>{defaultEdits++;return `${prefix}1`;});
  return {source,descriptionEdits,defaultEdits};
}

export function patchSdkRoot(root) {
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  assert.equal(pkg.version,'1.0.0',`Refusing to patch unpinned Pi SDK ${pkg.version} at ${root}`);
  let descriptionEdits=0,defaultEdits=0,changedFiles=0;
  const candidates=[];
  for(const file of filesUnder(path.join(root,'dist'))){
    const before=fs.readFileSync(file,'utf8');
    if(!/(?:tool_search|tool-search|ToolSearch)/.test(before) && !before.includes(oldDescription))continue;
    candidates.push(file);
    const patched=patchToolSearchSource(before);
    descriptionEdits+=patched.descriptionEdits;defaultEdits+=patched.defaultEdits;
    if(patched.source!==before){fs.writeFileSync(file,patched.source);changedFiles++;}
  }
  assert(candidates.length>0,`Could not locate compiled tool-search code under ${root}`);
  assert(descriptionEdits>0,`Could not locate tool_search schema default text under ${root}`);
  assert(defaultEdits>0,`Could not locate tool_search execution default under ${root}; refusing a description-only patch`);
  const remaining=filesUnder(path.join(root,'dist')).filter(file=>fs.readFileSync(file,'utf8').includes(oldDescription));
  assert.deepEqual(remaining,[],`Unpatched tool_search default descriptions remain under ${root}`);
  return {root,changedFiles,descriptionEdits,defaultEdits};
}

function selfTest(){
  const fixture=`const TOOL_SEARCH_DEFAULT_LIMIT = 8;\nconst description = "${oldDescription}";\nfunction execute(params){ return params.limit ?? 8; }\n`;
  const r=patchToolSearchSource(fixture);
  assert.equal(r.descriptionEdits,1);assert.equal(r.defaultEdits,2);
  assert.match(r.source,/TOOL_SEARCH_DEFAULT_LIMIT = 1/);assert.match(r.source,/params\.limit \?\? 1/);assert.match(r.source,/Defaults to 1/);
  // Explicit caller values / unrelated constants must not be rewritten.
  const safe=patchToolSearchSource('const unrelated = 8; const x = params.other ?? 8; // tool_search');
  assert.equal(safe.defaultEdits,0);assert.match(safe.source,/unrelated = 8/);assert.match(safe.source,/params\.other \?\? 8/);
  console.log('tool_search default-limit patch self-test passed.');
}

if(import.meta.url===new URL(`file://${process.argv[1]}`).href){
  if(process.argv.includes('--self-test')){selfTest();process.exit(0);}
  const roots=process.argv.slice(2);
  assert(roots.length>0,'Supply one or more @earendil-works/pi-coding-agent package roots');
  for(const root of roots)console.log(JSON.stringify(patchSdkRoot(path.resolve(root))));
}
