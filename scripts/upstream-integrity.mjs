#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isMain} from './config-common.mjs';

export async function upstreamIntegrity(runtimeRoot) {
  const result={version:1,files:{}};
  for(const name of ['@earendil-works/pi-coding-agent','pi-web-ui']) {
    const root=path.join(runtimeRoot,'node_modules',name);
    async function walk(directory) {
      for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
        if(entry.name==='node_modules')continue;
        const file=path.join(directory,entry.name);
        if(entry.isDirectory())await walk(file);
        else if(entry.isFile())result.files[path.relative(runtimeRoot,file)]=createHash('sha256').update(await fs.readFile(file)).digest('hex');
        else throw new Error('Unexpected upstream symlink: '+file);
      }
    }
    await walk(root);
  }
  return result;
}
export async function verifyUpstreamIntegrity(runtimeRoot) {
  const expected=JSON.parse(await fs.readFile(path.join(runtimeRoot,'upstream-integrity.json'),'utf8'));
  const actual=await upstreamIntegrity(runtimeRoot);
  const differences=[...new Set([...Object.keys(expected.files),...Object.keys(actual.files)])].filter(file=>expected.files[file]!==actual.files[file]);
  if(differences.length)throw new Error('Installed upstream packages were changed: '+differences.slice(0,8).join(', '));
  return Object.keys(actual.files).length;
}
if(isMain(import.meta.url)) {
  const runtimeRoot=path.resolve(process.argv[2]||'/opt/pi-runtime');
  if(process.argv.includes('--record')) {
    await fs.writeFile(path.join(runtimeRoot,'upstream-integrity.json'),JSON.stringify(await upstreamIntegrity(runtimeRoot))+'\n');
    console.log('Recorded clean upstream package integrity');
  } else console.log(`Verified ${await verifyUpstreamIntegrity(runtimeRoot)} unmodified upstream files`);
}
