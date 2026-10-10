import test from "node:test";
import assert from "node:assert/strict";
import atomicToolResults from "../index.js";
import { CUSTOM_TYPE } from "../lib/archive.js";

function fakePi(branch = []) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const appended = [];
  let active = [];
  return {
    handlers, tools, commands, appended,
    api: {
      on(name, fn) { handlers.set(name, fn); },
      appendEntry(customType, data) {
        const entry = { type: "custom", id: `e${branch.length + appended.length + 1}`, customType, data };
        appended.push(entry);
        branch.push(entry);
      },
      registerTool(def) { tools.set(def.name, def); if (["direct", "model-only"].includes(def.exposure ?? "direct")) active.push(def.name); },
      getAllTools() { return [...tools.values()]; },
      getActiveTools() { return active; },
      setActiveTools(names) { active = names; },
      registerCommand(name, def) { commands.set(name, def); },
    },
    ctx: {
      sessionManager: { getBranch: () => branch },
      ui: { notify() {} },
    },
  };
}

test("extension archives a large result and replaces first-use body with deterministic envelope", async () => {
  const f = fakePi();
  atomicToolResults(f.api);
  const hook = f.handlers.get("tool_result");
  const result = await hook({
    type: "tool_result",
    toolCallId: "abc",
    toolName: "mcp__security__big",
    input: {},
    content: [{ type: "text", text: "z".repeat(5000) }],
    details: { x: 1 },
    isError: false,
  }, f.ctx);
  assert.equal(f.appended.length, 1);
  assert.equal(f.appended[0].customType, CUSTOM_TYPE);
  assert.equal(f.appended[0].data.content[0].text.length, 5000);
  assert.match(result.content[0].text, /result:abc/);
  assert.ok(result.content[0].text.length < 2500);
});

test("extension archives a small result but leaves it inline when an envelope would be larger", async () => {
  const f = fakePi();
  atomicToolResults(f.api);
  const hook = f.handlers.get("tool_result");
  const event = {
    type: "tool_result", toolCallId: "small", toolName: "clock", input: {},
    content: [{ type: "text", text: "12:34" }], details: {}, isError: false,
  };
  const patch = await hook(event, f.ctx);
  assert.equal(f.appended.length, 1);
  assert.equal(patch.content[0].text, "12:34");
  assert.equal(patch.details.resultRef, "result:small");
  assert.equal(patch.details.atomicInlineRaw, true);
});

test("result_get and result_list are always direct while archive search remains deferred", () => {
  const f = fakePi();
  atomicToolResults(f.api);
  assert.equal(f.tools.get("result_get").exposure, "direct");
  assert.equal(f.tools.get("result_search").exposure, "deferred");
  assert.equal(f.tools.get("result_list").exposure, "direct");
});

test("result_get reads only archives on the current branch", async () => {
  const branch = [{
    type: "custom", id: "e1", customType: CUSTOM_TYPE,
    data: { version: 1, resultRef: "result:x", toolCallId: "x", toolName: "tool", isError: false, timestamp: 1, sizeBytes: 100, content: [{ type: "text", text: JSON.stringify({ values: [1,2,3] }) }] },
  }];
  const f = fakePi(branch);
  atomicToolResults(f.api);
  const get = f.tools.get("result_get");
  const out = await get.execute("get-1", { result_ref: "result:x", selector: "json.values", offset: 1, limit: 1 }, undefined, undefined, f.ctx);
  const payload = JSON.parse(out.content[0].text);
  assert.deepEqual(payload.value, [2]);
  assert.equal(payload.truncated, true);
});

test("result_get can rehydrate one archived image block for one request", async () => {
  const branch = [{
    type: "custom", id: "img-entry", customType: CUSTOM_TYPE,
    data: {
      version: 1, resultRef: "result:img", toolCallId: "img", toolName: "read_image",
      isError: false, timestamp: 1, sizeBytes: 10000,
      content: [{ type: "image", mimeType: "image/png", data: "QUJD" }],
    },
  }];
  const f = fakePi(branch);
  atomicToolResults(f.api);
  // Build the active-branch index exactly as Pi does at session start.
  await f.handlers.get("session_start")({ type: "session_start", reason: "startup" }, f.ctx);
  const get = f.tools.get("result_get");
  const out = await get.execute("get-img", { result_ref: "result:img", selector: "content.0" }, undefined, undefined, f.ctx);
  assert.equal(out.content.length, 2);
  assert.equal(out.content[1].type, "image");
  assert.equal(out.content[1].mimeType, "image/png");
});

test("nested executeTool result is archived but never compacted for its parent tool", async () => {
  const f = fakePi();
  atomicToolResults(f.api);
  const hook = f.handlers.get("tool_result");
  const event = {
    type: "tool_result",
    toolCallId: "parent/1",
    parentToolCallId: "parent",
    toolName: "mcp__security__nested",
    input: {},
    content: [{ type: "text", text: "N".repeat(6000) }],
    details: {},
    isError: false,
  };
  const patch = await hook(event, f.ctx);
  assert.equal(patch, undefined);
  assert.equal(f.appended.length, 1);
  assert.equal(f.appended[0].data.parentToolCallId, "parent");
  assert.equal(f.appended[0].data.content[0].text.length, 6000);
});

test("ambiguous append failure fails open instead of losing a tool result", async () => {
  const branch = [];
  const f = fakePi(branch);
  f.api.appendEntry = () => { throw new Error("simulated persistence failure"); };
  atomicToolResults(f.api);
  const hook = f.handlers.get("tool_result");
  const event = {
    type: "tool_result", toolCallId: "persist-fail", toolName: "tool", input: {},
    content: [{ type: "text", text: "must survive" }], details: {}, isError: false,
  };
  const patch = await hook(event, f.ctx);
  assert.equal(patch.content[0].text, "must survive");
});

test("end-to-end normal result stays compact while result_get persists a bounded durable slice", async () => {
  const f = fakePi();
  atomicToolResults(f.api);
  await f.handlers.get("session_start")({ type: "session_start", reason: "startup" }, f.ctx);

  const originalEvent = {
    type: "tool_result",
    toolCallId: "e2e-source",
    toolName: "mcp__security__fixture",
    input: {},
    content: [{ type: "text", text: JSON.stringify({ hosts: [{ name: "alpha" }, { name: "beta" }], count: 2, padding: "x".repeat(3000) }) }],
    details: { fixture: true },
    isError: false,
  };
  const persistedPatch = await f.handlers.get("tool_result")(originalEvent, f.ctx);
  assert.equal(f.appended.filter(e=>e.customType===CUSTOM_TYPE).length, 1);
  assert.equal(f.appended.filter(e=>e.customType==='pi.atomic-runtime-version').length, 1);
  assert.match(persistedPatch.content[0].text, /result:e2e-source/);

  const persistedSourceMessage = {
    role: "toolResult",
    toolCallId: originalEvent.toolCallId,
    toolName: originalEvent.toolName,
    content: persistedPatch.content,
    details: persistedPatch.details,
    isError: false,
    timestamp: 1,
  };

  const firstSourceContext = await f.handlers.get("context")({ type: "context", messages: [persistedSourceMessage] }, f.ctx);
  const secondSourceContext = await f.handlers.get("context")({ type: "context", messages: [persistedSourceMessage] }, f.ctx);
  assert.equal(firstSourceContext, undefined);
  assert.equal(secondSourceContext, undefined);
  assert.match(persistedSourceMessage.content[0].text, /result:e2e-source/);
  assert.notEqual(persistedSourceMessage.content[0].text, originalEvent.content[0].text);

  const getTool = f.tools.get("result_get");
  const getResult = await getTool.execute(
    "e2e-get",
    { result_ref: "result:e2e-source", selector: "json.hosts", offset: 0, limit: 1 },
    undefined,
    undefined,
    f.ctx,
  );
  const leasedPatch = await f.handlers.get("tool_result")({
    type: "tool_result",
    toolCallId: "e2e-get",
    toolName: "result_get",
    input: { result_ref: "result:e2e-source", selector: "json.hosts", offset: 0, limit: 1 },
    content: getResult.content,
    details: getResult.details,
    isError: false,
  }, f.ctx);
  assert.equal(leasedPatch.details.atomicDurable,true);

  const persistedGetMessage = {
    role: "toolResult",
    toolCallId: "e2e-get",
    toolName: "result_get",
    content: leasedPatch.content,
    details: leasedPatch.details,
    isError: false,
    timestamp: 2,
  };
  const firstGetContext = await f.handlers.get("context")({ type: "context", messages: [persistedSourceMessage, persistedGetMessage] }, f.ctx);
  assert.match((firstGetContext?.messages ?? [persistedSourceMessage,persistedGetMessage])[1].content[0].text, /alpha/);
  const secondGetContext = await f.handlers.get("context")({ type: "context", messages: [persistedSourceMessage, persistedGetMessage] }, f.ctx);
  assert.match((secondGetContext?.messages ?? [persistedSourceMessage,persistedGetMessage])[1].content[0].text, /alpha/);
  assert.match((secondGetContext?.messages ?? [persistedSourceMessage,persistedGetMessage])[1].content[0].text, /result:e2e-source/);
});



test("result_search and result_list outputs are not leased or recursively archived", async () => {
  const f = fakePi();
  atomicToolResults(f.api);
  const hook = f.handlers.get("tool_result");
  for (const [toolName, callId] of [["result_search", "search-1"], ["result_list", "list-1"]]) {
    const event = {
      type: "tool_result", toolCallId: callId, toolName, input: {},
      content: [{ type: "text", text: `${toolName} bounded output` }], details: {}, isError: false,
    };
    const patch = await hook(event, f.ctx);
    assert.equal(patch, undefined);
  }
  assert.equal(f.appended.length, 0);
});

test("session tree navigation clears transient leases and rebuilds archive visibility from the active branch", async () => {
  const branch = [];
  const f = fakePi(branch);
  atomicToolResults(f.api);
  await f.handlers.get("session_start")({ type: "session_start", reason: "startup" }, f.ctx);

  const event = {
    type: "tool_result",
    toolCallId: "branch-source",
    toolName: "small_tool",
    input: {},
    content: [{ type: "text", text: "branch exact body" }],
    details: {},
    isError: false,
  };
  const patch = await f.handlers.get("tool_result")(event, f.ctx);
  const persisted = [{
    role: "toolResult", toolCallId: event.toolCallId, toolName: event.toolName,
    content: patch.content, details: patch.details, isError: false, timestamp: 1,
  }];

  await f.handlers.get("session_tree")({ type: "session_tree" }, f.ctx);
  const afterTree = await f.handlers.get("context")({ type: "context", messages: persisted }, f.ctx);
  assert.equal(afterTree, undefined);
  assert.equal(persisted[0].content[0].text, "branch exact body");
  assert.equal(persisted[0].details.atomic, true);
  assert.equal(persisted[0].details.atomicInlineRaw, true);
  assert.equal(persisted[0].details.resultRef, "result:branch-source");
});

test("result_get contract tells small models to rehydrate omitted advertised paths and never treat refs as files", () => {
  const f = fakePi();
  atomicToolResults(f.api);
  const tool = f.tools.get("result_get");
  assert.equal(tool.exposure, "direct");
  assert.match(tool.description, /truncated:true/i);
  assert.match(tool.description, /available_paths/i);
  assert.match(tool.description, /do not infer/i);
  assert.match(tool.description, /never a filesystem path/i);
  assert.match(tool.parameters.properties.result_ref.description, /never a filesystem path/i);
  assert.match(tool.parameters.properties.selector.description, /available_paths/i);
});


test("archive browsing hides discovery before limiting, preserves explicit filters and old refs", async () => {
  const branch = [
    {type:'custom',id:'e1',customType:CUSTOM_TYPE,data:{version:1,resultRef:'result:observation',toolCallId:'observation',toolName:'mcp__system__openwrt_status',timestamp:1,sizeBytes:20,content:[{type:'text',text:'router observation'}]}},
    {type:'custom',id:'e2',customType:CUSTOM_TYPE,data:{version:1,resultRef:'result:discovery',toolCallId:'discovery',toolName:'tool_search',timestamp:2,sizeBytes:20,content:[{type:'text',text:'router discovery'}]}},
  ];
  const f = fakePi(branch); atomicToolResults(f.api);
  const run = async (name,params) => JSON.parse((await f.tools.get(name).execute('test',params,undefined,undefined,f.ctx)).content[0].text);
  assert.deepEqual((await run('result_list',{limit:1})).results.map(r=>r.resultRef),['result:observation']);
  assert.deepEqual((await run('result_list',{tool:'tool_search'})).results.map(r=>r.resultRef),['result:discovery']);
  assert.deepEqual((await run('result_list',{tool:'mcp__system__openwrt_status'})).results.map(r=>r.resultRef),['result:observation']);
  assert.deepEqual((await run('result_search',{query:'router',limit:1})).matches.map(r=>r.resultRef),['result:observation']);
  assert.deepEqual((await run('result_search',{query:'router',tool:'tool_search'})).matches.map(r=>r.resultRef),['result:discovery']);
  assert.match(JSON.stringify(await run('result_get',{result_ref:'result:discovery',selector:'content'})),/router discovery/);
  assert.equal(branch.length,2);
});
