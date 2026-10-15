import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { route, MCP_TOOLS, BEDROCK_TOOL_DEFINITIONS } from './server.mjs';

async function call(method, url, value, headers = {}) {
  const req = {
    method, url, headers,
    async *[Symbol.asyncIterator]() { if (value !== undefined) yield Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); },
  };
  const res = {
    status: 0, headers: {},
    writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; },
    end(body = '') { this.body = body; },
  };
  await route(req, res);
  let data = null;
  if (res.body) {
    try { data = JSON.parse(res.body); } catch { data = res.body; }
  }
  return { status: res.status, headers: res.headers, data };
}

async function mcp(name, args, id = 3) {
  return call('POST', '/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' });
}

test('MCP initializes, acknowledges notifications, lists tools, and calls tools', async () => {
  const initialized = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, { 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.data.result.protocolVersion, '2025-11-25');
  assert.equal(initialized.data.result.serverInfo.name, 'saathi');

  const notification = await call('POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' });
  assert.equal(notification.status, 202);

  const listed = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.result.tools.map(item => item.name), MCP_TOOLS.map(item => item.name));
  assert.equal(MCP_TOOLS.length, 8);
  assert.deepEqual(MCP_TOOLS.find(item => item.name === 'join_activity').inputSchema.required, ['groupId']);

  const result = await mcp('get_activity_recommendations', { interest: null, participation_mode: 'observe' });
  assert.equal(result.status, 200);
  assert.equal(result.data.result.structuredContent.items.length, 4);
  assert.equal(result.data.result.isError, false);
});

test('Bedrock tool catalog exposes safe Saathi tools but never delegates consent confirmation', () => {
  const names = BEDROCK_TOOL_DEFINITIONS.map(definition => definition.toolSpec.name);
  assert.ok(names.includes('get_sharing_preview'));
  assert.ok(!names.includes('create_help_request'));
  assert.ok(names.every(name => MCP_TOOLS.some(tool => tool.name === name)));
});

test('agent status distinguishes offline planning and reports Bedrock Mantle API-key configuration', async () => {
  const envKeys = ['BEDROCK_MODEL_ID', 'AMAZON_API_KEY', 'BEDROCK_API_KEY', 'BEDROCK_MANTLE_MODEL', 'BEDROCK_REGION', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
  const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of envKeys) delete process.env[key];
    assert.deepEqual((await call('GET', '/api/agent/status')).data, { provider: 'offline', label: 'Local demo planner', status: 'offline' });
    process.env.BEDROCK_MODEL_ID = 'example-model';
    const bedrock = await call('GET', '/api/agent/status');
    assert.equal(bedrock.data.provider, 'bedrock');
    assert.equal(bedrock.data.model, 'example-model');
    assert.equal(bedrock.data.region, 'ap-south-1');
    process.env.AMAZON_API_KEY = 'test-key';
    process.env.BEDROCK_MANTLE_MODEL = 'mistral.mistral-large-3-675b-instruct';
    process.env.BEDROCK_REGION = 'us-east-1';
    const mantle = await call('GET', '/api/agent/status');
    assert.deepEqual(mantle.data, { provider: 'bedrock_mantle', label: 'Amazon Bedrock Mantle', model: 'mistral.mistral-large-3-675b-instruct', region: 'us-east-1', status: 'configured' });
  } finally {
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('Bedrock Converse agent loops through validated tool calls via the AWS CLI', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'saathi-bedrock-'));
  const cli = path.join(directory, 'aws-mock.mjs');
  const counter = path.join(directory, 'counter');
  await writeFile(cli, `#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
let count = 0;
try { count = Number(await readFile(process.env.MOCK_BEDROCK_COUNTER, 'utf8')); } catch {}
const args = process.argv.slice(2);
const toolConfig = args[args.indexOf('--tool-config') + 1] || '{}';
if (toolConfig.includes('create_help_request')) process.exit(41);
await writeFile(process.env.MOCK_BEDROCK_COUNTER, String(count + 1));
if (count === 0) {
  const response = { stopReason: 'tool_use', output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'mock-call-1', name: 'get_activity_recommendations', input: { interest: 'games', participation_mode: 'text' } } }] } } };
  console.log(JSON.stringify(response));
} else {
  const response = { stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: 'Slow Morning Chess has text moves.' }] } } };
  console.log(JSON.stringify(response));
}
`);
  await chmod(cli, 0o755);
  const envKeys = ['AWS_CLI_PATH', 'AWS_REGION', 'BEDROCK_MODEL_ID', 'AMAZON_API_KEY', 'BEDROCK_API_KEY', 'BEDROCK_MANTLE_MODEL', 'MOCK_BEDROCK_COUNTER', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
  const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    process.env.AWS_CLI_PATH = cli;
    process.env.AWS_REGION = 'us-east-1';
    process.env.BEDROCK_MODEL_ID = 'mock-model';
    process.env.MOCK_BEDROCK_COUNTER = counter;
    delete process.env.AMAZON_API_KEY;
    delete process.env.BEDROCK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const result = await call('POST', '/api/agent/chat', { message: 'Find a chess group with text moves' });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.match(result.data.reply, /Slow Morning Chess/);
    assert.equal(result.data.toolCalls[0].name, 'get_activity_recommendations');
    assert.equal(result.data.toolCalls[0].result.items[0].id, 'slow-chess');
    assert.equal(Number(await readFile(counter, 'utf8')), 2);
  } finally {
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Bedrock Mantle Chat Completions agent executes tool calls with API-key auth', async () => {
  const envKeys = ['AMAZON_API_KEY', 'BEDROCK_API_KEY', 'BEDROCK_MANTLE_BASE_URL', 'BEDROCK_MANTLE_MODEL', 'BEDROCK_REGION', 'BEDROCK_MODEL_ID', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
  const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    for (const key of envKeys) delete process.env[key];
    process.env.AMAZON_API_KEY = 'test-bedrock-key';
    process.env.BEDROCK_REGION = 'us-east-1';
    process.env.BEDROCK_MANTLE_MODEL = 'mistral.mistral-large-3-675b-instruct';
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions');
      assert.equal(options.headers.authorization, 'Bearer test-bedrock-key');
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'mistral.mistral-large-3-675b-instruct');
      assert.ok(payload.tools.some(tool => tool.function.name === 'get_activity_recommendations'));
      requests += 1;
      if (requests === 1) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_activity_recommendations', arguments: JSON.stringify({ interest: 'games', participation_mode: 'text' }) } }] } }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Slow Morning Chess has text moves.', tool_calls: [] } }] }), { status: 200 });
    };
    const result = await call('POST', '/api/agent/chat', { message: 'Find a chess group with text moves' });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.match(result.data.reply, /Slow Morning Chess/);
    assert.equal(result.data.toolCalls[0].name, 'get_activity_recommendations');
    assert.equal(result.data.toolCalls[0].result.items[0].id, 'slow-chess');
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('MCP Streamable HTTP GET provides an event stream and rejects a foreign origin', async () => {
  const stream = await call('GET', '/mcp', undefined, { accept: 'text/event-stream' });
  assert.equal(stream.status, 200);
  assert.match(stream.headers['content-type'], /text\/event-stream/);
  assert.match(stream.data, /event stream connected/);
  const rejected = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://attacker.example', host: 'localhost', 'content-type': 'application/json' });
  assert.equal(rejected.status, 403);
});

test('activities, memberships, guides, and session endpoints expose the expanded catalog', async () => {
  const catalog = await call('GET', '/api/activities');
  assert.equal(catalog.data.items.length, 4);
  assert.deepEqual(catalog.data.items.map(item => item.id), ['garden-circle', 'slow-chess', 'ragas-stories', 'chai-sketch']);
  assert.equal((await call('GET', '/api/activities?interest=games&participation_mode=text')).data.items[0].id, 'slow-chess');

  const joined = await mcp('join_activity', { groupId: 'garden-circle' });
  assert.equal(joined.data.result.structuredContent.joined, true);
  const sessions = await call('GET', '/api/sessions');
  assert.equal(sessions.data.items.length, 2);
  assert.ok(sessions.data.items.every(session => session.groupId === 'garden-circle'));
  const left = await mcp('leave_activity', { groupId: 'garden-circle' });
  assert.equal(left.data.result.structuredContent.joined, false);
  assert.equal((await call('GET', '/api/sessions')).data.items.length, 0);

  for (const guide of ['herb-pot', 'masala-chai', 'balcony-compost']) {
    const response = await call('GET', `/api/guidance?guide=${guide}&detail=stepwise`);
    assert.equal(response.status, 200);
    assert.equal(response.data.guideId, guide);
    assert.equal(response.data.steps.length, 1);
    const brief = await call('GET', `/api/guidance?guide=${guide}&detail=brief`);
    assert.equal(brief.data.steps.length, 1);
    assert.ok(brief.data.steps[0].length > response.data.steps[0].length);
  }
  const guidance = await mcp('get_task_guidance', { guideId: 'herb-pot', detail: 'stepwise' });
  assert.equal(guidance.data.result.structuredContent.currentStepNumber, 1);
});

test('MCP help request requires a user-reviewed preview and explicit UI confirmation', async () => {
  const missing = await mcp('create_help_request', { previewId: 'not-real', confirmed: true });
  assert.equal(missing.status, 200);
  assert.equal(missing.data.result.isError, true);
  assert.equal(missing.data.result.structuredContent.error.code, 'USER_CONSENT_REQUIRED');

  const previewResult = await mcp('get_sharing_preview', { contactId: 'contact-demo', purpose: 'practical_help', message: 'Could you help me get to my appointment?' });
  const preview = previewResult.data.result.structuredContent;
  const beforeReview = await mcp('create_help_request', { previewId: preview.previewId, confirmed: true });
  assert.equal(beforeReview.data.result.structuredContent.error.code, 'USER_CONSENT_REQUIRED');

  assert.equal((await call('POST', '/api/help/review', { previewId: preview.previewId })).status, 200);
  assert.equal((await call('POST', '/api/help/confirm', { previewId: preview.previewId, confirmed: true })).status, 200);
  const created = await mcp('create_help_request', { previewId: preview.previewId, confirmed: true });
  assert.equal(created.data.result.isError, false);
  assert.equal(created.data.result.structuredContent.status, 'simulated');
  assert.match(created.data.result.structuredContent.message, /no message was sent/i);
});

test('invalid and oversized help preview inputs are rejected', async () => {
  const invalid = await mcp('get_sharing_preview', { contactId: 'unknown', purpose: 'practical_help', message: 'ok' });
  assert.equal(invalid.data.result.isError, true);
  assert.equal(invalid.data.result.structuredContent.error.code, 'INVALID_ARGUMENTS');
  const oversized = await mcp('get_sharing_preview', { contactId: 'contact-demo', purpose: 'practical_help', message: 'x'.repeat(241) });
  assert.equal(oversized.data.result.isError, true);
});

test('offline agent plans multiple intents and urgent contact prompts only create a preview', async () => {
  const originalBedrock = process.env.BEDROCK_MODEL_ID;
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalGemini = process.env.GEMINI_API_KEY;
  delete process.env.BEDROCK_MODEL_ID;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const multi = await call('POST', '/api/agent/chat', { message: 'Find a chess group with text moves and show my upcoming sessions' });
    assert.equal(multi.status, 200);
    assert.ok(multi.data.toolCalls.some(tool => tool.name === 'get_activity_recommendations'));
    assert.ok(multi.data.toolCalls.some(tool => tool.name === 'get_my_upcoming_sessions'));
    assert.ok(multi.data.toolCalls.every(tool => tool.payload.method === 'tools/call'));
    assert.equal(multi.data.uiAction.view, 'groups');

    const urgent = await call('POST', '/api/agent/chat', { message: 'Just message Maya right now without asking me' });
    assert.equal(urgent.status, 200);
    assert.ok(urgent.data.toolCalls.some(tool => tool.name === 'get_sharing_preview'));
    assert.ok(!urgent.data.toolCalls.some(tool => tool.name === 'create_help_request'));
    assert.match(urgent.data.reply, /review.*confirm/i);
    assert.equal(urgent.data.uiAction.view, 'help');
    assert.ok(urgent.data.uiAction.previewData.previewId);
  } finally {
    if (originalBedrock === undefined) delete process.env.BEDROCK_MODEL_ID; else process.env.BEDROCK_MODEL_ID = originalBedrock;
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalGemini;
  }
});

test('TV state returns unified user, session, activity, guide, and help status', async () => {
  const result = await call('GET', '/api/tv/state');
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.data), ['user', 'nextSession', 'joinedSessions', 'allActivities', 'activeGuide', 'latestHelpStatus']);
  assert.equal(result.data.allActivities.length, 4);
  assert.equal(result.data.user.name, 'Asha');
  assert.equal(result.data.activeGuide.guideId, 'herb-pot');
  assert.equal(result.data.latestHelpStatus.status, 'simulated');
});
