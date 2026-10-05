#!/usr/bin/env node
// Offline SDK integration test: catalog discovery only, no model requests/scans.
// node tests/native-mcp-smoke.mjs SDK_ROOT WEB_UI_ROOT MCP_GATEWAY_ROOT
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [sdkRoot, webRoot, gatewayRoot] = process.argv.slice(2).map(p => path.resolve(p));
assert(sdkRoot && webRoot && gatewayRoot, 'Supply SDK, Web UI and gateway roots');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-pi-mcp-'));
process.env.PI_CODING_AGENT_DIR = temp;
const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')));
const {AGENT_TOOL_CATALOG, applyAgentToolsGating} = await import(pathToFileURL(path.join(webRoot, 'dist/server/tool-manager.js')));
const template=JSON.parse(await fs.readFile(path.join(gatewayRoot,'pi/mcp.json.example'),'utf8'));
const {getMcpToolExposure}=await import(pathToFileURL(path.join(sdkRoot,'dist/core/mcp-servers.js')));
assert.equal(getMcpToolExposure(template.mcpServers.playwright,'browser_close'),'hidden');
assert.equal(getMcpToolExposure(template.mcpServers.playwright,'browser_tabs'),'deferred');
const domains = {system: 'system-tools.mjs', security: 'security-tools.mjs', google: 'google-tools.mjs'};
await fs.writeFile(path.join(temp, 'mcp.json'), JSON.stringify({mcpServers: Object.fromEntries(
  Object.entries(domains).map(([name, file]) => [name, {
    command: process.execPath, args: [path.join(gatewayRoot, 'scripts', file)],
    env: {MCP_WORKSPACE: temp}, exposure: 'deferred', description:template.mcpServers[name].description,
  }])
)}));
await fs.writeFile(path.join(temp, 'settings.json'), JSON.stringify({defaultTools: ['read','bash','edit','write','tool_search']}));
let session;
try {
  const services = await sdk.createAgentSessionServices({cwd: temp, agentDir: temp, resourceLoaderOptions: {
    extensionFactories: [
      {name: 'mcp', builtin: true, replaceable: true, factory: sdk.createMcpExtension()},
      {name: 'tool-search', builtin: true, replaceable: true, factory: sdk.createToolSearchExtension()},
    ],
  }});
  assert.deepEqual(services.diagnostics, []);
  ({session} = await sdk.createAgentSessionFromServices({services, sessionManager: sdk.SessionManager.inMemory(temp)}));
  await session.bindExtensions({});
  const deadline = Date.now() + 15000;
  while (session.getAllTools().filter(t => t.name.startsWith('mcp__')).length < 138 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(session.getAllTools().filter(t => t.name.startsWith('mcp__')).length, 138, 'Every owned catalog must connect');
  const disabled = [...AGENT_TOOL_CATALOG.map(t => t.name), 'powershell','ls','grep','find'];
  applyAgentToolsGating(session, disabled, 'standard');
  assert.deepEqual(session.getActiveToolNames().sort(), ['read','bash','edit','write','tool_search'].sort());
  const search = session.getToolDefinition('tool_search');
  const startup=['read','bash','edit','write','tool_search'];
  const cases=[
    ['security MCP tools for network reconnaissance and mapping','security','get_host_interface_info'],
    ['mDNS subnet discovery','security','discover_mdns_subnets'],
    ['host network state','security','get_host_interface_info'],
    ['comprehensive local network discovery','security','perform_network_discovery'],
    ['passive wireless assessment','security','analyze_wireless_environment'],
    ['network topology','security','analyze_network_topology'],
    ['graphical network map','security','generate_graphical_network_map'],
    ['DNS records','system','network_dns_lookup'],
    ['service version detection','security','port_scan'],
    ['image thumbnail','system','image_resize'],
    ['PCAP conversations','security','pcap_analyze'],
    ['LLDP observation','security','protocol_observe'],
    ['configured routers','system','openwrt_targets'],
    ['Netcat listener','security','listener_start'],
    ['local daily briefing','system','local_daily_briefing'],
    ['how many unread emails','google','gmail_get_unread_count'],
    ['calendar availability','google','calendar_freebusy'],
    ['Drive download binary file','google','drive_download_file'],
    ['Google account authentication','google','auth_status'],
  ];
  cases.push(['read PDF pages','system','pdf_read'],['merge PDF','system','pdf_write'],['office_read','system','office_read'],['edit Word Excel PowerPoint','system','office_edit'],['Office to PDF','system','office_export']);
  for(const [query,domain,name] of cases){
    session.setActiveToolsByName(startup);
    const expected=`mcp__${domain}__${name}`;
    const result=await search.execute('smoke',{query,limit:1});
    assert.deepEqual(result.details.loaded,[expected],query);
    applyAgentToolsGating(session,disabled,'standard');
    assert(session.getActiveToolNames().includes(expected));
    assert.equal(session.getActiveToolNames().length,6,'Settings replay must retain exactly one loaded MCP tool');
    console.log(`${query} -> ${expected}`);
  }
  const owned=session.getAllTools().filter(t=>t.name.startsWith('mcp__'));
  for(const tool of owned){
    session.setActiveToolsByName(startup);
    const result=await search.execute('exact-name',{query:tool.name,limit:1});
    assert.deepEqual(result.details.loaded,[tool.name],`Exact name lookup: ${tool.name}`);
  }
  session.setActiveToolsByName(startup);
  const broad=await search.execute('run-replay',{query:cases[0][0],limit:3});
  assert.deepEqual(broad.details.loaded,[
    'mcp__security__get_host_interface_info',
    'mcp__security__generate_graphical_network_map',
    'mcp__security__analyze_wireless_environment',
  ]);
  // Native discovery excludes already active tools: reuse loaded schemas, search only for missing steps.
  const followup=await search.execute('topology',{query:'analyze_network_topology',limit:1});
  assert.deepEqual(followup.details.loaded,['mcp__security__analyze_network_topology']);
  applyAgentToolsGating(session,disabled,'standard');
  assert.equal(session.getActiveToolNames().filter(t=>t.startsWith('mcp__')).length,4);
  for(const t of session.getAllTools())assert.doesNotMatch(t.name,/mcp__(security__security_|google__google_)/);
  console.log(`Native SDK smoke passed: 138 deferred tools, five startup tools, ${cases.length} intent queries, 138 exact-name lookups, run-query replay and Web UI settings replay.`);

} finally {
  if (session) await session.extensionRunner.emit({type: 'session_shutdown', reason: 'exit'});
  session?.dispose();
  await fs.rm(temp, {recursive: true, force: true});
}
