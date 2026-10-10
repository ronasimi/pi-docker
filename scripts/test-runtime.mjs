#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {verifyUpstreamIntegrity} from './upstream-integrity.mjs';

const scripts=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(scripts,'..');
const runtimeRoot=process.env.PI_RUNTIME_ROOT||'/opt/pi-runtime';
const extension=process.env.PI_ATOMIC_EXTENSION_PATH||path.join(repo,'extensions/pi-atomic-tool-results');
const bridge=process.env.PI_NATIVE_SERVICES_PATH||path.join(repo,'extensions/pi-native-services');
const tests=path.join(repo,'tests');
const state=await fs.mkdtemp(path.join(os.tmpdir(),'pi-clean-validation-'));
const env={...process.env,HOME:state,PI_CODING_AGENT_DIR:path.join(state,'agent'),PI_WEB_DATA_DIR:path.join(state,'web'),PI_REQUIRE_SDK:'1',PI_REQUIRE_WEB_UI:'1',PI_WEB_SDK:'bundled',PI_ATOMIC_RESULTS_FIXED_PROVIDER_TOOLS:'true',PI_ATOMIC_EXTENSION_PATH:extension,PI_NATIVE_SERVICES_PATH:bridge};
if(process.argv.includes('--read-only-runtime')) {
  // Emulate the non-root image when validating as root in an API workspace.
  // Stock Web UI auto-patches best-effort and skips these denied file writes.
  env.NODE_OPTIONS=[env.NODE_OPTIONS,'--permission --allow-fs-read=* --allow-fs-write='+os.tmpdir(),'--allow-child-process --allow-worker --allow-addons'].filter(Boolean).join(' ');
}
try {
  await verifyUpstreamIntegrity(runtimeRoot);
  const files=[];
  for(const directory of [path.join(extension,'tests'),tests])for(const name of (await fs.readdir(directory)).sort())if(name.endsWith('.test.mjs'))files.push(path.join(directory,name));
  const child=spawn(process.execPath,['--test','--test-reporter=tap',...files],{env,stdio:'inherit'});
  const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
  await verifyUpstreamIntegrity(runtimeRoot);
  process.exitCode=status;
} finally {await fs.rm(state,{recursive:true,force:true});}
