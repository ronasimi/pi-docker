import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installWhiteRabbitReasoning, isWhiteRabbit } from '../reasoning.mjs';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../../scripts/sync-ollama-models.mjs',import.meta.url));

test('WhiteRabbit reasoning applies on restore, selection and preflight without changing other models', () => {
  const callbacks = new Map(); let level = 'off';
  const pi = { on:(name,fn)=>callbacks.set(name,fn), getThinkingLevel:()=>level, setThinkingLevel:value=>{level=value;} };
  installWhiteRabbitReasoning(pi);
  const white={id:'security-agent:7b',reasoning:true,compat:{supportsReasoningEffort:false}};
  callbacks.get('session_start')({}, {model:white}); assert.equal(level,'medium');
  level='off'; callbacks.get('model_select')({model:white}); assert.equal(level,'medium');
  level='off'; const event={systemPromptOptions:{appendSystemPrompt:'existing policy'}};
  callbacks.get('before_agent_start')(event,{model:white}); assert.equal(level,'medium'); assert.match(event.systemPromptOptions.appendSystemPrompt,/Analyze|analyze/);
  level='off'; callbacks.get('model_select')({model:{id:'gemma',reasoning:true}}); assert.equal(level,'off');
  assert.ok(isWhiteRabbit({id:'hf.co/bartowski/WhiteRabbitNeo_WhiteRabbitNeo-V3-7B-GGUF:Q4_K_M'}));
});

test('catalog discovery distinguishes prompted WhiteRabbit from native thinking and uses configured context', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-discovery-'));
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    res.setHeader('content-type','application/json');
    if(req.url==='/api/tags') return res.end(JSON.stringify({models:[{name:'security-agent:7b'},{name:'whiterabbitneo-native:7b'},{name:'gemma4:test'}]}));
    const name=JSON.parse(body).model;
    res.end(JSON.stringify({capabilities:name==='security-agent:7b'?['completion','tools']:['completion','thinking'],parameters:'num_ctx 16384',model_info:{'qwen2.context_length':32768}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const env={...process.env,OLLAMA_BASE_URL:`http://127.0.0.1:${server.address().port}`,PI_MODELS_FILE:path.join(dir,'models.json'),PI_MODELS_OVERRIDES:path.join(dir,'none.json'),PI_OLLAMA_DISCOVERY_RETRY_SECONDS:'0'};
  try {
    await exec(process.execPath,[script],{env});
    let models=JSON.parse(await fs.readFile(env.PI_MODELS_FILE)).providers.ollama.models;
    const white=models.find(m=>m.id==='security-agent:7b'); assert.equal(white.reasoning,true); assert.equal(white.compat.supportsReasoningEffort,false);assert.equal(white.contextWindow,16384);
    assert.equal(models.find(m=>m.id==='whiterabbitneo-native:7b').compat.supportsReasoningEffort,true);
    await new Promise(r=>server.close(r));
    white.reasoning=false;delete white.compat;
    await fs.writeFile(env.PI_MODELS_FILE,JSON.stringify({providers:{ollama:{models}}}));
    await exec(process.execPath,[script],{env});
    models=JSON.parse(await fs.readFile(env.PI_MODELS_FILE)).providers.ollama.models;
    assert.equal(models.find(m=>m.id==='security-agent:7b').reasoning,true);
    assert.equal(models.find(m=>m.id==='security-agent:7b').compat.supportsReasoningEffort,false);
  } finally { server.close();await fs.rm(dir,{recursive:true,force:true}); }
});

test('real Pi requests omit unsupported reasoning_effort but enable it for native-capable WhiteRabbit', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-reasoning-'));
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);requests.push(request);
    res.writeHead(200,{'content-type':'text/event-stream'});
    const base={id:'reasoning-test',object:'chat.completion.chunk',created:1,model:request.model};
    res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'4'},finish_reason:null}]})+'\n\n');
    res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let session;
  try {
    await fs.writeFile(path.join(dir,'models.json'),JSON.stringify({providers:{mock:{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'mock',models:[
      {id:'security-agent:7b',contextWindow:16384,maxTokens:512,reasoning:true,input:['text'],compat:{supportsReasoningEffort:false}},
      {id:'whiterabbitneo-native:7b',contextWindow:16384,maxTokens:512,reasoning:true,input:['text'],compat:{supportsReasoningEffort:true}},
    ]}}}));
    const reasoningPath=fileURLToPath(new URL('../reasoning.mjs',import.meta.url));
    await fs.writeFile(path.join(dir,'reasoning.ts'),`export { installWhiteRabbitReasoning as default } from ${JSON.stringify(reasoningPath)};`);
    const settingsManager=SettingsManager.inMemory({defaultProvider:'mock',defaultModel:'security-agent:7b',defaultThinkingLevel:'off',extensions:['-builtin:mcp','-builtin:codemode','-builtin:tool-search','-builtin:llama.cpp'],retry:{enabled:false},compaction:{enabled:false}});
    const resourceLoader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,additionalExtensionPaths:[path.join(dir,'reasoning.ts')]});
    await resourceLoader.reload();assert.deepEqual(resourceLoader.getExtensions().errors,[]);
    const created=await createAgentSession({cwd:dir,agentDir:dir,settingsManager,resourceLoader,sessionManager:SessionManager.inMemory(dir)});
    session=created.session;const errors=[];await session.bindExtensions({mode:'print',onError:e=>errors.push(e)});
    await session.prompt('What is 2 + 2?');
    assert.equal(session.thinkingLevel,'medium'); assert.ok(!('reasoning_effort' in requests[0]));
    assert.match(JSON.stringify(requests[0].messages),/For this WhiteRabbitNeo task/);
    const native={...session.model,id:'whiterabbitneo-native:7b',compat:{supportsReasoningEffort:true}};
    await session.setModel(native);await session.prompt('What is 2 + 2?');
    assert.equal(requests.at(-1).reasoning_effort,'medium');
    assert.doesNotMatch(JSON.stringify(requests.at(-1).messages[0]),/For this WhiteRabbitNeo task/);
    assert.deepEqual(errors,[]);
  } finally { session?.dispose();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true}); }
});
