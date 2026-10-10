import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {upstreamIntegrity,verifyUpstreamIntegrity} from '../scripts/upstream-integrity.mjs';
import {sdkOrigin,VERSIONS} from '../scripts/runtime-versions.mjs';
import {createStableTools} from '../extensions/pi-atomic-tool-results/lib/tools.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('locked clean runtime shares one SDK and installs no source patch adapter',async()=>{
 const packageFile=JSON.parse(await fs.readFile(path.join(root,'runtime/package.json')));
 const lock=JSON.parse(await fs.readFile(path.join(root,'runtime/package-lock.json')));
 const versions=JSON.parse(await fs.readFile(path.join(root,'runtime/versions.json')));
 assert.equal(packageFile.dependencies['@earendil-works/pi-coding-agent'],versions.pi);
 assert.equal(packageFile.dependencies['pi-web-ui'],versions.web);
 assert.equal(lock.packages['node_modules/@earendil-works/pi-coding-agent'].version,versions.pi);
 assert.equal(Object.keys(lock.packages).filter(p=>p.endsWith('/@earendil-works/pi-coding-agent')).length,1,'A second SDK copy can bypass the clean runtime');
 const docker=await fs.readFile(path.join(root,'Dockerfile'),'utf8');
 assert.doesNotMatch(docker,/configure-web-ui-native-mcp|patch-tool-search-default|pi-docker-adapter/);
 assert.match(docker,/chmod -R a-w \/opt\/pi-runtime\/node_modules[\s\S]*USER pi[\s\S]*test-runtime/);
});
test('native service bridge uses only public stock factories and disables duplicate CLI builtins',async()=>{
 const settings=JSON.parse(await fs.readFile(path.join(root,'config/settings.json')));
 assert(settings.extensions.includes('-builtin:mcp'));assert(settings.extensions.includes('-builtin:tool-search'));
 const manifest=JSON.parse(await fs.readFile(path.join(root,'extensions/pi-native-services/package.json')));
 assert(!manifest.dependencies);assert(manifest.peerDependencies['@earendil-works/pi-coding-agent']);
 for(const [file,factory] of [['mcp.js','createMcpExtension'],['tool-search.js','createToolSearchExtension']]){
  const source=await fs.readFile(path.join(root,'extensions/pi-native-services',file),'utf8');
  assert(source.includes("from '@earendil-works/pi-coding-agent'"));assert(source.includes(`${factory}()(pi)`));
 }
});
test('integrity rejects changed, missing and added upstream files',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pi-integrity-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 for(const name of ['@earendil-works/pi-coding-agent','pi-web-ui']){const packageDir=path.join(directory,'node_modules',name);await fs.mkdir(packageDir,{recursive:true});await fs.writeFile(path.join(packageDir,'index.js'),'original');}
 await fs.writeFile(path.join(directory,'upstream-integrity.json'),JSON.stringify(await upstreamIntegrity(directory)));
 assert.equal(await verifyUpstreamIntegrity(directory),2);
 const file=path.join(directory,'node_modules/pi-web-ui/index.js');await fs.writeFile(file,'modified');await assert.rejects(verifyUpstreamIntegrity(directory),/were changed/);
 await fs.writeFile(file,'original');await fs.unlink(file);await assert.rejects(verifyUpstreamIntegrity(directory),/were changed/);
 await fs.writeFile(file,'original');await fs.writeFile(path.join(directory,'node_modules/pi-web-ui/extra.js'),'extra');await assert.rejects(verifyUpstreamIntegrity(directory),/were changed/);
});
test('upstream tool replay cannot declare optional tools or directly execute hidden operations',()=>{
 const handlers=new Map(),tools=new Map(),fixed=['read','bash','edit','write','tool_search','tool_invoke','result_get','result_list'];
 for(const name of [...fixed,'load_tools','mcp__fixture__observe'])tools.set(name,{name,description:name,exposure:name.startsWith('mcp__')?'deferred':'direct',parameters:{type:'object',properties:{}}});
 let active=[...tools.keys()];
 const pi={on:(name,handler)=>handlers.set(name,handler),getAllTools:()=>[...tools.values()],getActiveTools:()=>active,setActiveTools:names=>{active=names;},registerTool:tool=>tools.set(tool.name,tool),appendEntry(){},sendMessage(){}};
 createStableTools(pi,{enabled:true,stableTools:true,fixedProviderTools:true,maxSchemas:1,leaseCapacity:9});
 const loadout=tools.get('tool_invoke').prepareLoadout({declared:[...tools.values()]});
 assert(loadout.hiddenDeclarations.includes('load_tools'));assert(loadout.hiddenDeclarations.includes('mcp__fixture__observe'));
 assert.equal(handlers.get('tool_call')({toolName:'load_tools',input:{}},{}).block,true);
 handlers.get('before_agent_start')({prompt:'Inspect fixture passively'});
 assert.deepEqual(active,fixed);
});

test('runtime origin resolves Pi import-only exports without a CommonJS main',async()=>{
 const webRoot=process.env.PI_WEB_UI_ROOT||'/opt/pi-runtime/node_modules/pi-web-ui';
 const sdkRoot=process.env.PI_SDK_ROOT||'/opt/pi-runtime/node_modules/@earendil-works/pi-coding-agent';
 assert.equal(await fs.realpath(sdkOrigin(webRoot)),await fs.realpath(sdkRoot));
 assert.equal(JSON.parse(await fs.readFile(path.join(sdkRoot,'package.json'))).version,VERSIONS.pi);
});
