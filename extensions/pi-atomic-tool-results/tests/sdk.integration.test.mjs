import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import atomicToolResults from "../index.js";

const sdkRoot = process.env.PI_SDK_ROOT;
if (process.env.PI_REQUIRE_SDK && !sdkRoot) throw new Error("Set PI_SDK_ROOT to the installed @earendil-works/pi-coding-agent directory.");

test("real Pi 1.1: fixed OpenAI/Ollama wire prefix, native discovery, nested validation/permissions, and bounded repair", { skip: !sdkRoot, timeout: 30000 }, async () => {
  const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
  const version = JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"))).version;
  assert.equal(version, "1.1.0", "Run against the pinned deployment runtime");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-sdk-"));
  const requests = [], executed = [], nestedHooks = [], scripts = [];
  let calls = 0;
  const invoke = (name, args = {}) => ({ name: "tool_invoke", arguments: { name, arguments: args } });
  for (let i = 0; i < 12; i++) {
    const name = `mcp__fixture__operation_${i}`;
    scripts.push({ name: "tool_search", arguments: { query: name } });
    scripts.push(invoke(name, { value: `step-${i}` }));
  }
  // A denied target and a schema-invalid call must produce errors without work.
  scripts.push({ name: "tool_search", arguments: { query: "mcp__fixture__blocked" } });
  scripts.push(invoke("mcp__fixture__blocked", { value: "denied" }));
  scripts.push({ name: "tool_search", arguments: { query: "mcp__fixture__operation_0" } });
  scripts.push(invoke("mcp__fixture__operation_0", {}));
  scripts.push({ name: "tool_search", arguments: { query: "mcp__memory__search_nodes" } });
  scripts.push('call:mcp__memory__search_nodes{query:Pi Docker}<tool_call>');
  scripts.push(invoke("mcp__memory__search_nodes", { query: "Pi Docker" }));
  scripts.push({name:'tool_search',arguments:{query:'tool_batch'}});
  scripts.push(invoke('tool_batch',{calls:[{id:'valid',name:'mcp__fixture__operation_0',arguments:{value:'must-not-run'}},{id:'invalid',name:'mcp__fixture__operation_1',arguments:{}}]}));
  scripts.push(invoke('tool_batch',{calls:[{id:'denied',name:'mcp__fixture__blocked',arguments:{value:'denied'}},{id:'dependent',name:'mcp__fixture__operation_0',arguments:{value:'must-not-run'},depends_on:['denied']},{id:'independent',name:'mcp__fixture__operation_1',arguments:{value:'batch-independent'},select:['json.count']}]}));
  scripts.push(invoke('tool_batch',{calls:[{id:'a',name:'mcp__fixture__operation_0',arguments:{value:'batch-a'},select:['json.count']},{id:'b',name:'mcp__fixture__operation_1',arguments:{value:'batch-b'},select:['json.count']}]}));
  scripts.push("Complete audit: all operations have an outcome.");

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(payload);
    const step = scripts.shift();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: `response-${calls}`, object: "chat.completion.chunk", created: 1, model: "fixture" };
    const send = data => res.write(`data: ${JSON.stringify({ ...base, ...data })}\n\n`);
    if (typeof step === "string") {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: step }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    } else if (step) {
      send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ choices: [{ index: 0, delta: { role: "assistant", content: "Unexpected extra request" }, finish_reason: "stop" }] });
    }
    send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    calls++;
    res.end("data: [DONE]\n\n");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  let session;
  try {
    await fs.writeFile(path.join(temp, "models.json"), JSON.stringify({ providers: { fixture: {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture",
      models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: false } }],
    } } }));
    await fs.writeFile(path.join(temp, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash", "edit", "write", "tool_search"], compaction: { enabled: false } }));
    const services = await sdk.createAgentSessionServices({ cwd: temp, agentDir: temp, resourceLoaderOptions: {
      extensionFactories: [
        { name: "tool-search", builtin: true, factory: sdk.createToolSearchExtension() },
        { name: "fixture-tools", factory: pi => {
          for (const name of [...Array.from({ length: 12 }, (_, i) => `mcp__fixture__operation_${i}`), "mcp__fixture__blocked", "mcp__memory__search_nodes"]) {
            const property = name.includes("memory") ? "query" : "value";
            pi.registerTool({ name, label: name, description: `${name} exact fixture operation`, exposure: "deferred",
              parameters: { type: "object", properties: { [property]: { type: "string" } }, required: [property], additionalProperties: false },
              async execute(_id, params) { executed.push({ name, params }); return { content: [{ type: "text", text: JSON.stringify({ count: 0, evidence: `result-${name}`, padding: "x".repeat(5000) }) }], details: {} }; },
            });
          }
          pi.on("tool_call", event => {
            if (event.parentToolCallId) nestedHooks.push(event.toolName);
            if (event.toolName === "mcp__fixture__blocked") return { block: true, reason: "Fixture permission denial" };
          });
        } },
        { name: "atomic-results", factory: atomicToolResults },
      ],
    } });
    assert.deepEqual(services.diagnostics, []);
    ({ session } = await sdk.createAgentSessionFromServices({ services, sessionManager: sdk.SessionManager.inMemory(temp), model: services.modelRuntime.getModel("fixture", "fixture") }));
    await session.bindExtensions({});
    await session.prompt("Run every fixture operation, continue through errors, search Pi Docker memory and finish an audit.");
    assert.equal(scripts.length, 0, "Repair must reach the structured Memory call and final audit");
    assert.equal(requests.length, 36);
    const toolsJson = JSON.stringify(requests[0].tools);
    const immutableSchemas = new Map();
    const systemJson = JSON.stringify(requests[0].messages.filter(m => m.role === "system"));
    for (const p of requests) {
      assert.equal(JSON.stringify(p.tools), toolsJson, "Tool declarations must be identical on every provider request");
      assert.equal(JSON.stringify(p.messages.filter(m => m.role === "system")), systemJson, "Standing prompt must stay identical");
      assert(!p.tools.some(t => t.function.name.startsWith("mcp__")));
      const fullSchemas = p.messages.filter(m => m.role === "tool" && m.content?.includes('"parameters"'));
      // Search result schemas append once and must never mutate in older request
      // prefixes. The schema cache preserves retained historical search messages.
      for (const msg of fullSchemas) {
        const prev = immutableSchemas.get(msg.tool_call_id);
        if (prev !== undefined) assert.equal(msg.content, prev, 'Previous schema mutated in provider cache prefix');
        else immutableSchemas.set(msg.tool_call_id, msg.content);
      }
    }
    assert.equal(executed.length, 16);
    assert(!executed.some(e=>e.params.value==='must-not-run'),'Batch argument preflight and failed dependencies cannot execute');
    assert.equal(executed.filter(e=>String(e.params.value).startsWith('batch-')).length,3);

    assert.equal(executed.filter(e => e.name === "mcp__memory__search_nodes").length, 1, "Text imitation must never execute");
    assert.equal(executed.filter(e => e.name === "mcp__fixture__blocked").length, 0);
    assert(nestedHooks.includes("mcp__fixture__blocked"), "Permission hooks must see the exact target");
    const results = session.messages.filter(m => m.role === "toolResult" && m.toolName === "tool_invoke");
    assert.equal(results.filter(m => m.isError).length, 4, "Permission/schema errors remain failed at the outer boundary");
    assert.match(session.getLastAssistantText(), /Complete audit/);
    assert(!session.getActiveToolNames().some(n => n.startsWith("mcp__")));
    console.log(`Pi ${version}: ${requests.length} real provider requests; 14 distinct deferred schemas; identical tools/system prefix; bounded schema cache with persistent grants; permissions/validation preserved; Memory recovered once.`);
  } finally {
    session?.dispose();
    await new Promise(r => server.close(r));
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("real Pi 1.1: artifact paths survive compaction and bounded DNS evidence remains durable", { skip: !sdkRoot, timeout: 30000 }, async () => {
  const sdk = await import(pathToFileURL(path.join(sdkRoot, "dist/index.js")));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-evidence-"));
  const requests = [], hookErrors = [];
  const observation = "security-workspace/observations/dns.json";
  const samples = [{ status: "response", response_ms: 1.5, authoritative: true, answers: [{ ttl: 0, advertised_address: "192.0.2.20" }] }, { status: "timeout" }];
  const result = { status: "observed", complete: true, results: [{ name: "nas.test", samples }], observation_path: observation, padding: "x".repeat(5000) };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload);
    const n = requests.length;
    let call;
    if (n === 1) call = { name: "tool_search", arguments: { query: "mcp__fixture__dns" } };
    if (n === 2) call = { name: "tool_invoke", arguments: { name: "mcp__fixture__dns", arguments: {} } };
    if (n === 3 || n === 4) {
      const source = payload.messages.find(m => m.role === "tool" && m.content?.includes('"atomic_result"'));
      call = { name: "result_get", arguments: { result_ref: JSON.parse(source.content).atomic_result.ref, selector: n === 3 ? "json.results.0.samples" : "json.observation_path", limit: 2, max_chars: 1024 } };
    }
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `evidence-${n}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: "Evidence recovered; authoritative answer and timeout reported separately." };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `evidence-${n}`, object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let session;
  try {
    const runtime = await sdk.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("fixture", { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }] });
    const services = await sdk.createAgentSessionServices({ cwd: temp, agentDir: temp, modelRuntime: runtime,
      settingsManager: sdk.SettingsManager.inMemory({ defaultTools: ["read", "bash", "edit", "write", "tool_search"], compaction: { enabled: false }, cacheWarming: "off" }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, extensionFactories: [
        { name: "tool-search", factory: sdk.createToolSearchExtension() }, { name: "atomic-results", factory: atomicToolResults },
        { name: "fixture-tools", factory: pi => pi.registerTool({ name: "mcp__fixture__dns", label: "Fixture DNS", description: "mcp__fixture__dns exact DNS samples", exposure: "deferred", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} }; } }) },
      ] },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSessionFromServices({ services, model: runtime.getModel("fixture", "fixture"), sessionManager: sdk.SessionManager.inMemory(temp) }));
    await session.bindExtensions({ onError: error => hookErrors.push(error) });
    await session.prompt("Collect fixture DNS, retrieve its exact samples and artifact path, and finish.");
    assert.deepEqual(hookErrors, []);
    assert.equal(requests.length, 5);
    const compact = requests[2].messages.find(m => m.role === "tool" && m.content?.includes('"atomic_result"')).content;
    assert(compact.length <= 1200);
    assert.equal(JSON.parse(compact).atomic_result.artifacts.observation_path, observation);
    for (const request of requests) {
      assert.equal(JSON.stringify(request.tools), JSON.stringify(requests[0].tools));
      assert.equal(JSON.stringify(request.messages.filter(m => m.role === "system")), JSON.stringify(requests[0].messages.filter(m => m.role === "system")));
      const original = request.messages.find(m => m.role === "tool" && m.content?.includes('"atomic_result"'));
      if (original) assert.equal(original.content, compact, "Ordinary compact evidence must stay immutable across retrievals");
    }
    const hydrated = JSON.parse(requests[3].messages.find(m => m.role === "tool" && m.tool_call_id === "evidence-3").content);
    assert.deepEqual(hydrated.value, samples);
    assert.equal(hydrated.truncated, false);
    assert.deepEqual(JSON.parse(requests[4].messages.find(m => m.role === "tool" && m.tool_call_id === "evidence-3").content).value, samples);
    assert.equal(JSON.parse(requests[4].messages.find(m => m.role === "tool" && m.tool_call_id === "evidence-4").content).value, observation);
    assert.equal(session.getActiveToolNames().length, 8);
  } finally {
    session?.dispose(); await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true });
  }
});

test('real Pi 1.1 records runtime provenance and recovers a premature closing marker once', {skip:!sdkRoot,timeout:15000},async t=>{
 const sdk=await import(pathToFileURL(path.join(sdkRoot,'dist/index.js')));
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'atomic-marker-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));let requests=0,executions=0;
 const server=http.createServer(async(req,res)=>{for await(const c of req){}requests++;const call=requests===1?{name:'tool_search',arguments:{query:'mcp__system__host_snapshot'}}:requests===2?{name:'tool_invoke',arguments:{name:'mcp__system__host_snapshot',arguments:{}}}:null;
 const delta=call?{role:'assistant',tool_calls:[{index:0,id:'marker-'+requests,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}}]}:{role:'assistant',content:'</request>'};const base={id:'marker-'+requests,object:'chat.completion.chunk',created:1,model:'fixture'};res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const runtime=await sdk.ModelRuntime.create({modelsPath:null,refreshOnCreate:false});runtime.registerProvider('fixture',{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsDeveloperRole:false}}]});
 const services=await sdk.createAgentSessionServices({cwd:temp,agentDir:temp,modelRuntime:runtime,settingsManager:sdk.SettingsManager.inMemory({defaultTools:['read','bash','edit','write','tool_search'],compaction:{enabled:false},cacheWarming:'off'}),resourceLoaderOptions:{noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,extensionFactories:[{name:'search',factory:sdk.createToolSearchExtension()},{name:'atomic',factory:atomicToolResults},{name:'fixture',factory:pi=>pi.registerTool({name:'mcp__system__host_snapshot',label:'Host',description:'Host OS CPU memory snapshot',exposure:'deferred',parameters:{type:'object',properties:{}},async execute(){executions++;return {content:[{type:'text',text:'{"hostname":"marker-fixture-host"}'}]};}})}]}});
 const {session}=await sdk.createAgentSessionFromServices({services,model:runtime.getModel('fixture','fixture'),sessionManager:sdk.SessionManager.inMemory(temp)});t.after(()=>session.dispose());const errors=[];await session.bindExtensions({onError:e=>errors.push(e)});await session.prompt('TASK 1 — Assess host infrastructure and report findings');assert.deepEqual(errors,[]);assert.equal(requests,4);assert.equal(executions,1);const final=session.messages.findLast(m=>m.role==='assistant');assert.match(JSON.stringify(final.content),/marker-fixture-host/);assert.doesNotMatch(JSON.stringify(final.content),/<\/request>/);const branch=session.sessionManager.getBranch();const fingerprint=branch.find(e=>e.customType==='pi.atomic-runtime-version');assert.equal(fingerprint.data.atomicVersion,'0.2.3');assert.equal(branch.filter(e=>e.customType==='pi.atomic-empty-settlement-repair').length,1);
});
