import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ACTIVE_TOOLS} from '../scripts/verify-runtime-session.mjs';

test('stock bundled CLI uses the external native bridge and fixed model declarations', {timeout:30000},async t=>{
 const sdkRoot=process.env.PI_SDK_ROOT||'/opt/pi-runtime/node_modules/@earendil-works/pi-coding-agent';
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pi-clean-cli-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const agent=path.join(directory,'agent');await fs.mkdir(agent);
 const settings=JSON.parse(await fs.readFile(path.join(root,'config/settings.json')));
 settings.extensions=settings.extensions.map(value=>value==='/opt/pi-extensions/pi-native-services'?(process.env.PI_NATIVE_SERVICES_PATH||path.join(root,'extensions/pi-native-services')):value==='/opt/pi-extensions/pi-atomic-tool-results'?(process.env.PI_ATOMIC_EXTENSION_PATH||path.join(root,'extensions/pi-atomic-tool-results')):value);
 settings.defaultProvider='cli-fixture';settings.defaultModel='cli-fixture';settings.compaction.enabled=false;
 await fs.writeFile(path.join(agent,'settings.json'),JSON.stringify(settings));
 await fs.writeFile(path.join(agent,'mcp.json'),JSON.stringify({autoEnableCodemode:false,mcpServers:{memory:{command:process.execPath,args:[path.join(root,'tests/fixtures/mcp-fixture.mjs'),'memory'],exposure:'deferred'}}}));
 const requests=[];
 const provider=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  const n=requests.length;
  const call=n===1?{name:'tool_search',arguments:{query:'memory search'}}:n===2?{name:'tool_invoke',arguments:{name:'mcp__memory__search_nodes',arguments:{query:'cli-proof'}}}:null;
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:`cli-${n}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}:{role:'assistant',content:'CLI verified.'};
  res.writeHead(200,{'content-type':'text/event-stream'});
  const base={id:`cli-${n}`,object:'chat.completion.chunk',created:1,model:'cli-fixture'};
  res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]})}\n\n`);res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 try {
  await fs.writeFile(path.join(agent,'models.json'),JSON.stringify({providers:{'cli-fixture':{api:'openai-completions',apiKey:'fixture',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,models:[{id:'cli-fixture',name:'CLI fixture',reasoning:false,input:['text'],contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsDeveloperRole:false}}]}}}));
  const meta=JSON.parse(await fs.readFile(path.join(sdkRoot,'package.json')));
  const child=spawn(process.execPath,[path.join(sdkRoot,meta.bin.pi),'--mode','json','--no-session','--provider','cli-fixture','--model','cli-fixture','Verify memory search, execute the discovered operation with cli-proof, then finish.'],{cwd:directory,env:{...process.env,HOME:directory,PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_ATOMIC_RESULTS_FIXED_PROVIDER_TOOLS:'true'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const timeout=setTimeout(()=>child.kill('SIGKILL'),25000);
  let status;try{status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timeout);}
  assert.equal(status,0,stderr+'\n'+stdout.slice(-3000));assert.equal(requests.length,3,stderr+'\n'+stdout.slice(-3000));
  for(const request of requests)assert.deepEqual(request.tools.map(tool=>tool.function.name).sort(),[...ACTIVE_TOOLS].sort());
  assert.equal(JSON.stringify(requests[0].tools),JSON.stringify(requests[2].tools));
  assert(requests[2].messages.some(message=>message.role==='tool' && message.content.includes('cli-proof')),'CLI did not receive the native MCP result');
 } finally {provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
