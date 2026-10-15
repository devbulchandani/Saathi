import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const MCP_VERSION = '2025-11-25';
const user = { id: 'demo-person', name: 'Asha' };
let preferences = { interests: ['gardening'], detail: 'stepwise', captions: true, textSize: 'large' };
const activities = [
  { id: 'garden-circle', title: 'Garden Circle', description: 'Planting herbs & balcony greens', recurrence: 'Sundays 4:00 PM', nextAt: '2026-10-18T16:00:00+05:30', tags: ['gardening', 'captions', 'observe-ok'], participation_modes: ['speak', 'choose', 'observe'], access: ['Captions', 'Written steps', 'Observing is welcome'], host: 'Saathi community host', joined: false },
  { id: 'slow-chess', title: 'Slow Morning Chess', description: 'Untimed friendly tactics', recurrence: 'Tuesdays 10:30 AM', nextAt: '2026-10-20T10:30:00+05:30', tags: ['games', 'no-timer', 'text-moves'], participation_modes: ['speak', 'choose', 'text', 'observe'], access: ['No timer', 'Moves shown in text', 'Take a break at any time'], host: 'Saathi community host', joined: false },
  { id: 'ragas-stories', title: 'Old Film Songs & Stories', description: 'Listening & trivia circle', recurrence: 'Thursdays 6:00 PM', nextAt: '2026-10-22T18:00:00+05:30', tags: ['music', 'captions', 'audio-described'], participation_modes: ['speak', 'choose', 'observe'], access: ['Captions', 'Audio-described notes', 'Listen or join the conversation'], host: 'Saathi community host', joined: false },
  { id: 'chai-sketch', title: 'Postcard Sketching', description: 'Simple everyday drawing', recurrence: 'Saturdays 11:00 AM', nextAt: '2026-10-17T11:00:00+05:30', tags: ['art', 'stepwise', 'observe-ok'], participation_modes: ['speak', 'choose', 'text', 'observe'], access: ['Step-by-step prompts', 'Observing is welcome', 'No timed rounds'], host: 'Saathi community host', joined: false },
];
const sessions = activities.flatMap(activity => [0, 1].map(week => ({
  id: `${activity.id}-session-${week + 1}`,
  groupId: activity.id,
  title: activity.title,
  topic: activity.description,
  startsAt: new Date(new Date(activity.nextAt).getTime() + week * 7 * 24 * 60 * 60 * 1000).toISOString(),
  recurrence: activity.recurrence,
  access: activity.access,
  joined: false,
})));
const guides = {
  'herb-pot': {
    title: 'A simple herb pot',
    steps: ['Choose a pot with drainage.', 'Add potting mix, leaving a little room at the top.', 'Place the herb gently and cover its roots.', 'Water lightly and place it where it gets suitable light.'],
  },
  'masala-chai': {
    title: 'Making masala chai',
    steps: ['Gather tea, milk or an alternative, water, and spices you enjoy.', 'Warm water with the spices in a small pot.', 'Add tea and let it steep to your preferred strength.', 'Add milk, warm gently, then strain into a cup.'],
  },
  'balcony-compost': {
    title: 'Starting a small balcony compost pot',
    steps: ['Choose a ventilated container that fits your space.', 'Add a dry layer such as torn paper or dry leaves.', 'Add a small amount of suitable fruit or vegetable scraps.', 'Cover scraps with dry material and check the pot occasionally.'],
  },
};
const contacts = [{ id: 'contact-demo', name: 'Maya (demo contact)' }];
const previews = new Map();
const helpRequests = new Map();
const agentSessions = new Map();
const MAX_AGENT_SESSIONS = 32;
const MAX_AGENT_TURNS = 8;
const AGENT_SESSION_IDLE_MS = 30 * 60 * 1000;
const currentStep = new Map([['herb-pot', 0]]);
let activeGuide = { guideId: 'herb-pot', detail: 'stepwise' };
let previewCounter = 0;
let requestCounter = 0;
let rpcCounter = 0;

function pruneAgentSessions(now = Date.now()) {
  for (const [id, session] of agentSessions) if (now - session.lastActivityAt > AGENT_SESSION_IDLE_MS) agentSessions.delete(id);
  while (agentSessions.size > MAX_AGENT_SESSIONS) agentSessions.delete(agentSessions.keys().next().value);
}
const agentSessionPruner = setInterval(() => pruneAgentSessions(), 60_000);
agentSessionPruner.unref?.();
function validAgentSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,80}$/.test(value);
}
function createAgentSession(id = randomUUID()) {
  pruneAgentSessions();
  const session = { id, turns: [], lastActivityAt: Date.now() };
  agentSessions.delete(id);
  agentSessions.set(id, session);
  pruneAgentSessions();
  return session;
}
function getAgentSession(id) {
  pruneAgentSessions();
  if (!validAgentSessionId(id)) return null;
  const session = agentSessions.get(id);
  if (session) { session.lastActivityAt = Date.now(); agentSessions.delete(id); agentSessions.set(id, session); }
  return session || null;
}
function summarizeAgentTools(calls = []) {
  const summaries = [];
  for (const call of calls) {
    const result = call.result || {};
    if (call.name === 'get_activity_recommendations') summaries.push({ tool: call.name, note: result.note, items: (result.items || []).slice(0, 4).map(item => ({ id: item.id, title: item.title, description: item.description, recurrence: item.recurrence, tags: item.tags, matchReasons: item.matchReasons })) });
    else if (call.name === 'get_task_guidance') summaries.push({ tool: call.name, guideId: result.guideId, title: result.title, detail: result.detail, currentStepNumber: result.currentStepNumber });
    else if (call.name === 'join_activity' || call.name === 'leave_activity') summaries.push({ tool: call.name, groupId: result.groupId, joined: result.joined, message: result.message });
    else if (call.name === 'get_my_upcoming_sessions') summaries.push({ tool: call.name, items: (result.items || []).slice(0, 8).map(item => ({ groupId: item.groupId, title: item.title, startsAt: item.startsAt, recurrence: item.recurrence })) });
  }
  return summaries.length ? JSON.stringify(summaries).slice(0, 1_200) : '';
}
function rememberAgentTurn(session, userText, assistantText, toolCalls = []) {
  const previewOnly = toolCalls.some(call => call.name === 'get_sharing_preview');
  session.turns.push({
    user: previewOnly ? '[A contact-sharing preview was requested; its message text is not retained in chat memory.]' : userText,
    assistant: previewOnly ? 'A sharing preview was prepared. Its exact recipient and message are not retained in chat memory.' : assistantText,
    context: summarizeAgentTools(toolCalls),
  });
  session.turns = session.turns.slice(-MAX_AGENT_TURNS);
  session.lastActivityAt = Date.now();
}
function getAgentHistory(session) {
  return session.turns.flatMap(turn => [
    { role: 'user', content: turn.user },
    { role: 'assistant', content: turn.context ? `${turn.assistant}\n\nVerified Saathi results for follow-up context: ${turn.context}` : turn.assistant },
  ]);
}

const emptySchema = { type: 'object', properties: {}, required: [], additionalProperties: false };
export const MCP_TOOLS = [
  { name: 'get_my_preferences', description: 'Read the demo user preferences. Does not change anything.', inputSchema: emptySchema },
  { name: 'get_activity_recommendations', description: 'Find seeded recurring clubs. An explicit interest filters results; when interest is null, rank all clubs using the user’s saved interests and caption preference. Use each item’s matchReasons to explain the ranking; preferences never hide clubs. Filter by participation mode only when the user asks.', inputSchema: { type: 'object', properties: { interest: { type: ['string', 'null'], description: 'Optional explicit interest filter. When null, rank all compatible clubs using saved preferences without hiding clubs.' }, participation_mode: { type: ['string', 'null'], description: 'Optional user-requested mode: speak, choose, text, or observe.' } }, required: ['interest', 'participation_mode'], additionalProperties: false } },
  { name: 'join_activity', description: 'Join the selected recurring club after the user asks to join it. Requires the activity group id.', inputSchema: { type: 'object', properties: { groupId: { type: 'string', minLength: 1 } }, required: ['groupId'], additionalProperties: false } },
  { name: 'leave_activity', description: 'Leave the selected recurring club after the user asks to leave it.', inputSchema: { type: 'object', properties: { groupId: { type: 'string', minLength: 1 } }, required: ['groupId'], additionalProperties: false } },
  { name: 'get_my_upcoming_sessions', description: 'List the user’s upcoming sessions in joined clubs.', inputSchema: emptySchema },
  { name: 'get_task_guidance', description: 'Read one of the curated, non-medical learning guides. Detail must be stepwise or brief.', inputSchema: { type: 'object', properties: { guideId: { type: 'string', enum: Object.keys(guides) }, detail: { type: 'string', enum: ['stepwise', 'brief'] } }, required: ['guideId', 'detail'], additionalProperties: false } },
  { name: 'get_sharing_preview', description: 'Prepare the exact recipient and message for the user to review. This never sends or confirms a message.', inputSchema: { type: 'object', properties: { contactId: { type: 'string', enum: ['contact-demo'] }, purpose: { type: 'string', enum: ['practical_help'] }, message: { type: 'string', minLength: 4, maxLength: 240 } }, required: ['contactId', 'purpose', 'message'], additionalProperties: false } },
  { name: 'create_help_request', description: 'Create a simulated help request only after the user reviewed the matching preview and explicitly confirmed in the Saathi UI. Does not contact a person or service.', inputSchema: { type: 'object', properties: { previewId: { type: 'string', minLength: 1 }, confirmed: { type: 'boolean', const: true } }, required: ['previewId', 'confirmed'], additionalProperties: false } },
];

const toolMap = new Map(MCP_TOOLS.map(tool => [tool.name, tool]));
const GUIDE_NOTE = 'General learning guidance only. Choose what works for you; Saathi cannot observe or verify a physical task.';
const AGENT_SYSTEM_PROMPT = 'You are Saathi, a privacy-first activity and task guide. Use tools for facts and actions. When recommending clubs, use returned matchReasons to explain ranking, say that all clubs remain available, and never imply an unasked filter or a guaranteed fit. Never invent delivery or completed physical actions. For any request to contact Maya, prepare a sharing preview only. Never call create_help_request; that action requires a separate user-reviewed and explicitly confirmed UI step. Never disclose the user’s history or preferences to a contact.';

function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify(value));
}
function empty(res, status, extraHeaders = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}
function error(status, code, message) { return { status, value: { error: { code, message } } }; }
function matchesSchema(schema, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'arguments must be an object';
  for (const required of schema.required || []) if (!(required in value)) return `missing required field: ${required}`;
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).find(key => !(key in (schema.properties || {})));
    if (extra) return `unexpected field: ${extra}`;
  }
  for (const [key, item] of Object.entries(value)) {
    const rule = schema.properties?.[key];
    if (!rule) continue;
    const nullable = Array.isArray(rule.type) && rule.type.includes('null');
    if (item === null && nullable) continue;
    const types = Array.isArray(rule.type) ? rule.type.filter(type => type !== 'null') : [rule.type];
    const typeOk = types.some(type => type === 'string' ? typeof item === 'string' : type === 'boolean' ? typeof item === 'boolean' : type === 'object' ? item && typeof item === 'object' && !Array.isArray(item) : type === 'array' ? Array.isArray(item) : true);
    if (!typeOk) return `${key} must be ${types.join(' or ')}`;
    if (typeof item === 'string' && rule.minLength !== undefined && item.length < rule.minLength) return `${key} is too short`;
    if (typeof item === 'string' && rule.maxLength !== undefined && item.length > rule.maxLength) return `${key} is too long`;
    if (rule.enum && !rule.enum.includes(item)) return `${key} must be one of: ${rule.enum.join(', ')}`;
    if (rule.const !== undefined && item !== rule.const) return `${key} must equal ${JSON.stringify(rule.const)}`;
  }
  return null;
}
function getGuide(guideId, detail) {
  const guide = guides[guideId];
  if (!guide) return null;
  const step = currentStep.get(guideId) || 0;
  return { guideId, title: guide.title, detail, steps: detail === 'brief' ? [guide.steps.join(' ')] : [guide.steps[step]], currentStep: step, currentStepNumber: step + 1, totalSteps: guide.steps.length, note: GUIDE_NOTE };
}
function getSessions() {
  return sessions.filter(session => activities.some(activity => activity.id === session.groupId && activity.joined));
}
function createPreview(args) {
  const id = `preview-${++previewCounter}`;
  const contact = contacts.find(candidate => candidate.id === args.contactId);
  const preview = { previewId: id, contactId: contact.id, recipient: contact.name, purpose: args.purpose, message: args.message.trim(), shares: ['Your name', 'The exact message shown'], notShared: ['Activity history', 'Accessibility preferences', 'Location'], createdAt: Date.now(), userReviewed: false, userConfirmed: false };
  previews.set(id, preview);
  const { createdAt, userReviewed, userConfirmed, ...display } = preview;
  return display;
}
function confirmPreview(previewId, confirmed) {
  const preview = previews.get(previewId);
  if (!confirmed || !preview || Date.now() - preview.createdAt > 5 * 60 * 1000 || !preview.userReviewed || !preview.userConfirmed) {
    return { error: { code: 'USER_CONSENT_REQUIRED', message: 'A matching sharing preview must be displayed, reviewed, and explicitly confirmed in the Saathi UI before this action can proceed.' } };
  }
  const request = { id: `help-${++requestCounter}`, previewId, status: 'simulated', recipient: preview.recipient, createdAt: new Date().toISOString(), message: 'Demo only: no message was sent to a person or service.' };
  helpRequests.set(request.id, request);
  previews.delete(previewId);
  return request;
}
function findActivity(groupId) { return activities.find(activity => activity.id === groupId); }
function getActivityRecommendations({ interest = null, participation_mode = null } = {}) {
  const explicitInterest = interest?.toLowerCase() || null;
  const mode = participation_mode?.toLowerCase() || null;
  const preferenceInterests = explicitInterest ? [explicitInterest] : preferences.interests;
  const items = activities
    .filter(activity => (!explicitInterest || activity.tags.includes(explicitInterest)) && (!mode || activity.participation_modes.includes(mode)))
    .map(activity => {
      const matchedInterests = preferenceInterests.filter(value => activity.tags.includes(value));
      const supportsCaptionPreference = preferences.captions && activity.tags.includes('captions');
      const matchReasons = [];
      if (matchedInterests.length) matchReasons.push(`${activity.title} matches ${explicitInterest ? 'the interest you asked for' : 'an interest you chose'}: ${matchedInterests.join(', ')}.`);
      if (supportsCaptionPreference) matchReasons.push(`The ${activity.title} listing includes caption information.`);
      return {
        id: activity.id, title: activity.title, description: activity.description, recurrence: activity.recurrence,
        nextAt: activity.nextAt, tags: activity.tags, participation_modes: activity.participation_modes,
        access: activity.access, joined: activity.joined, matchReasons,
        _score: matchedInterests.length * 2 + Number(supportsCaptionPreference),
      };
    })
    .sort((a, b) => b._score - a._score || activities.findIndex(item => item.id === a.id) - activities.findIndex(item => item.id === b.id))
    .map(({ _score, ...activity }) => activity);
  const hasPreferenceMatches = items.some(activity => activity.matchReasons.length > 0);
  const note = explicitInterest
    ? 'Filtered by the interest you asked for. Other clubs are available by clearing the interest filter.'
    : hasPreferenceMatches
      ? 'Ranked using your saved interests and caption preference. All clubs remain available.'
      : 'All clubs are shown. Choose interests in Saathi Privacy to personalize their order.';
  return { items, personalized: hasPreferenceMatches && !explicitInterest, note };
}

export async function invokeTool(name, args = {}) {
  const definition = toolMap.get(name);
  if (!definition) return { isError: true, structuredContent: { error: { code: 'UNKNOWN_TOOL', message: `Unknown Saathi tool: ${name}` } } };
  const invalid = matchesSchema(definition.inputSchema, args);
  if (invalid) return { isError: true, structuredContent: { error: { code: 'INVALID_ARGUMENTS', message: invalid } } };

  let result;
  switch (name) {
    case 'get_my_preferences':
      result = { user, preferences };
      break;
    case 'get_activity_recommendations': {
      result = getActivityRecommendations(args);
      break;
    }
    case 'join_activity':
    case 'leave_activity': {
      const activity = findActivity(args.groupId);
      if (!activity) return { isError: true, structuredContent: { error: { code: 'ACTIVITY_NOT_FOUND', message: 'That activity could not be found.' } } };
      activity.joined = name === 'join_activity';
      sessions.filter(session => session.groupId === activity.id).forEach(session => { session.joined = activity.joined; });
      result = { groupId: activity.id, joined: activity.joined, message: activity.joined ? `You joined ${activity.title}.` : `You left ${activity.title}.` };
      break;
    }
    case 'get_my_upcoming_sessions':
      result = { items: getSessions().sort((a, b) => a.startsAt.localeCompare(b.startsAt)) };
      break;
    case 'get_task_guidance':
      result = getGuide(args.guideId, args.detail);
      if (!result) return { isError: true, structuredContent: { error: { code: 'GUIDE_NOT_FOUND', message: 'That guide is not available.' } } };
      activeGuide = { guideId: args.guideId, detail: args.detail };
      break;
    case 'get_sharing_preview':
      result = createPreview(args);
      break;
    case 'create_help_request':
      result = confirmPreview(args.previewId, args.confirmed);
      if (result.error) return { isError: true, structuredContent: result };
      break;
    default:
      return { isError: true, structuredContent: { error: { code: 'UNKNOWN_TOOL', message: 'Unsupported tool.' } } };
  }
  return { isError: false, structuredContent: result };
}

function mcpResponse(id, result) { return { jsonrpc: '2.0', id, result }; }
function mcpError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
async function dispatchRpc(message) {
  const id = message?.id;
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return { response: mcpError(id, -32600, 'Invalid Request') };
  const notification = !Object.hasOwn(message, 'id');
  const params = message.params || {};
  switch (message.method) {
    case 'initialize':
      if (notification) return { response: mcpError(null, -32600, 'initialize must be a request') };
      return { response: mcpResponse(id, { protocolVersion: MCP_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'saathi', version: '0.2.0' }, instructions: 'Help requests require an explicit user-reviewed UI confirmation. The demo contact adapter sends nothing.' }) };
    case 'notifications/initialized':
      return { accepted: true };
    case 'ping':
      return { response: mcpResponse(id, {}) };
    case 'tools/list':
      return { response: mcpResponse(id, { tools: MCP_TOOLS }) };
    case 'tools/call': {
      if (typeof params.name !== 'string') return { response: mcpError(id, -32602, 'tools/call requires params.name') };
      const called = await invokeTool(params.name, params.arguments || {});
      const structuredContent = called.structuredContent;
      return { response: mcpResponse(id, { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: called.isError }) };
    }
    default:
      return { response: mcpError(id, -32601, `Method not found: ${message.method}`) };
  }
}
function mcpOriginAllowed(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  const host = req.headers?.host;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && ['http:', 'https:'].includes(parsed.protocol);
  } catch { return false; }
}
async function handleMcpPost(req, res) {
  if (!mcpOriginAllowed(req)) return json(res, 403, mcpError(undefined, -32000, 'Invalid Origin'));
  const accept = req.headers?.accept || '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return json(res, 406, mcpError(undefined, -32000, 'Accept must include application/json and text/event-stream'));
  const contentType = req.headers?.['content-type'];
  if (!contentType || !contentType.toLowerCase().includes('application/json')) return json(res, 415, mcpError(undefined, -32700, 'Content-Type must be application/json'));
  let message;
  try { message = await body(req); }
  catch (exception) { return json(res, exception.status || 400, mcpError(undefined, -32700, 'Parse error: invalid JSON')); }
  if (Array.isArray(message)) return json(res, 400, mcpError(undefined, -32600, 'Batch requests are not supported'));
  if (message.method !== 'initialize' && req.headers?.['mcp-protocol-version'] !== MCP_VERSION) return json(res, 400, mcpError(message.id, -32000, `MCP-Protocol-Version must be ${MCP_VERSION} after initialization`));
  const dispatched = await dispatchRpc(message);
  if (dispatched.accepted) return empty(res, 202);
  return json(res, 200, dispatched.response);
}
async function handleMcpGet(req, res) {
  if (!mcpOriginAllowed(req)) return json(res, 403, mcpError(undefined, -32000, 'Invalid Origin'));
  const accept = req.headers?.accept || '';
  if (accept && !accept.includes('text/event-stream')) return json(res, 406, { error: { code: 'NOT_ACCEPTABLE', message: 'GET /mcp provides an event stream. Accept: text/event-stream.' } });
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.end(': Saathi Streamable HTTP event stream connected\n\n');
}

function toolSchemaForOpenAI(tool) {
  return { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true };
}
function toolsForProvider(allowedNames = null) {
  return MCP_TOOLS.filter(tool => tool.name !== 'create_help_request' && (!allowedNames || allowedNames.includes(tool.name)));
}
async function runProviderTool(name, args, calls, allowedNames = null) {
  if (!toolsForProvider(allowedNames).some(tool => tool.name === name)) {
    const payload = { jsonrpc: '2.0', id: `agent-${++rpcCounter}`, method: 'tools/call', params: { name, arguments: args } };
    const result = { error: { code: 'TOOL_NOT_ALLOWED', message: 'That action is unavailable to the model. Saathi requires user review and confirmation in the UI.' } };
    calls.push({ name, args, result, payload, output: { isError: true, structuredContent: result } });
    return result;
  }
  return runInternalTool(name, args, calls);
}
function toolSchemaForBedrock(tool) {
  return { toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.inputSchema } } };
}
export const BEDROCK_TOOL_DEFINITIONS = toolsForProvider().map(toolSchemaForBedrock);
function bedrockMantleCredentials() {
  return process.env.AMAZON_API_KEY || process.env.BEDROCK_API_KEY || null;
}
function bedrockMantleModel() {
  return process.env.BEDROCK_MANTLE_MODEL || process.env.DEFAULT_MODEL || 'mistral.mistral-large-3-675b-instruct';
}
async function callBedrockMantle(message, allowedNames = null, history = []) {
  const apiKey = bedrockMantleCredentials();
  if (!apiKey) throw new Error('Set AMAZON_API_KEY to an Amazon Bedrock API key.');
  const region = process.env.BEDROCK_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const baseUrl = (process.env.BEDROCK_MANTLE_BASE_URL || `https://bedrock-mantle.${region}.api.aws/v1`).replace(/\/$/, '');
  const model = bedrockMantleModel();
  const tools = toolsForProvider(allowedNames).map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
  const messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...history.filter(item => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string'),
    { role: 'user', content: message },
  ];
  const calls = [];
  let reply = '';
  for (let round = 0; round < 4; round++) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: 500, temperature: 0 }),
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = {}; }
    if (!response.ok) throw new Error(data.error?.message || `Amazon Bedrock Mantle returned HTTP ${response.status}`);
    const assistant = data.choices?.[0]?.message;
    if (!assistant) throw new Error('Amazon Bedrock Mantle returned no assistant message.');
    if (typeof assistant.content === 'string') reply = assistant.content || reply;
    else if (Array.isArray(assistant.content)) reply = assistant.content.filter(item => item.type === 'text' || item.text).map(item => item.text || '').join('\n') || reply;
    const requestedTools = assistant.tool_calls || [];
    if (!requestedTools.length) break;
    messages.push(assistant);
    for (const item of requestedTools.slice(0, 3)) {
      let args = {};
      try { args = JSON.parse(item.function?.arguments || '{}'); } catch { /* Internal tool validation returns a readable error. */ }
      await runProviderTool(item.function?.name, args, calls, allowedNames);
      messages.push({ role: 'tool', tool_call_id: item.id, content: JSON.stringify(calls.at(-1).result) });
    }
  }
  return { reply: reply || 'I checked Saathi for you. Please review the result before taking an action.', toolCalls: calls };
}
async function callBedrock(message, allowedNames = null, history = []) {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) throw new Error('Set BEDROCK_MODEL_ID to a model or inference profile available in Amazon Bedrock.');
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
  const cli = process.env.AWS_CLI_PATH || 'aws';
  const definitions = toolsForProvider(allowedNames).map(toolSchemaForBedrock);
  const system = [{ text: AGENT_SYSTEM_PROMPT }];
  const messages = [
    ...history.filter(item => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').map(item => ({ role: item.role, content: [{ text: item.content }] })),
    { role: 'user', content: [{ text: message }] },
  ];
  const calls = [];
  let reply = '';
  for (let round = 0; round < 4; round++) {
    const inferenceConfig = { maxTokens: 500, temperature: 0 };
    const toolConfig = definitions.length ? { tools: definitions, toolChoice: { auto: {} } } : undefined;
    const args = [
      'bedrock-runtime', 'converse', '--region', region,
      '--model-id', modelId,
      '--messages', JSON.stringify(messages),
      '--system', JSON.stringify(system),
      '--inference-config', JSON.stringify(inferenceConfig),
      ...(toolConfig ? ['--tool-config', JSON.stringify(toolConfig)] : []),
      '--output', 'json', '--no-cli-pager',
    ];
    const { stdout } = await execFileAsync(cli, args, { timeout: 60_000, maxBuffer: 2_000_000, windowsHide: true });
    const response = JSON.parse(stdout);
    const assistant = response.output?.message;
    if (!assistant) throw new Error('Amazon Bedrock returned no assistant message.');
    const blocks = assistant.content || [];
    reply = blocks.filter(block => block.text).map(block => block.text).join('\n') || reply;
    const requestedTools = blocks.filter(block => block.toolUse).map(block => block.toolUse);
    if (!requestedTools.length || response.stopReason !== 'tool_use') break;
    messages.push(assistant);
    const results = [];
    for (const item of requestedTools.slice(0, 3)) {
      await runProviderTool(item.name, item.input || {}, calls, allowedNames);
      results.push({ toolResult: { toolUseId: item.toolUseId, content: [{ text: JSON.stringify(calls.at(-1).result) }] } });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: reply || 'I checked Saathi for you. Please review the result before taking an action.', toolCalls: calls };
}
function schemaForGemini(schema) {
  if (Array.isArray(schema.type)) return { type: schema.type.includes('object') ? 'OBJECT' : 'STRING', nullable: schema.type.includes('null') };
  const out = {};
  if (schema.type) out.type = schema.type.toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, schemaForGemini(value)]));
  if (schema.required) out.required = schema.required;
  return out;
}
async function callOpenAI(message, allowedNames = null, history = []) {
  const definitions = toolsForProvider(allowedNames);
  const tools = definitions.map(toolSchemaForOpenAI);
  const input = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...history.filter(item => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string'),
    { role: 'user', content: message },
  ];
  const calls = [];
  let reply = '';
  for (let round = 0; round < 4; round++) {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-6-astra', input, tools, tool_choice: 'auto', parallel_tool_calls: false }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `OpenAI API returned ${response.status}`);
    const output = data.output || [];
    if (!output.length) throw new Error('The OpenAI response did not include output.');
    const pending = output.filter(item => item.type === 'function_call');
    reply = data.output_text || output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n') || reply;
    if (!pending.length) break;
    input.push(...output);
    for (const item of pending) {
      let args = {};
      try { args = JSON.parse(item.arguments || '{}'); } catch { /* the tool schema validator returns a readable error */ }
      await runProviderTool(item.name, args, calls, allowedNames);
      input.push({ type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(calls.at(-1).result) });
    }
  }
  return { reply: reply || 'I checked Saathi for you. Please review the result before taking an action.', toolCalls: calls };
}
async function callGemini(message, allowedNames = null, history = []) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const definitions = toolsForProvider(allowedNames);
  const tools = [{ functionDeclarations: definitions.map(tool => ({ name: tool.name, description: tool.description, parameters: schemaForGemini(tool.inputSchema) })) }];
  const contents = [
    ...history.filter(item => ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] })),
    { role: 'user', parts: [{ text: message }] },
  ];
  const calls = [];
  let reply = '';
  for (let round = 0; round < 4; round++) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: AGENT_SYSTEM_PROMPT }] }, contents, tools, toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Gemini API returned ${response.status}`);
    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter(part => part.functionCall).map(part => part.functionCall);
    reply = parts.filter(part => part.text).map(part => part.text).join('\n') || reply;
    if (!functionCalls.length) break;
    contents.push({ role: 'model', parts });
    const functionResponses = [];
    for (const item of functionCalls.slice(0, 1)) {
      const args = item.args || {};
      await runProviderTool(item.name, args, calls, allowedNames);
      functionResponses.push({ functionResponse: { name: item.name, response: calls.at(-1).result } });
    }
    contents.push({ role: 'user', parts: functionResponses });
  }
  return { reply: reply || 'I checked Saathi for you. Please review the result before taking an action.', toolCalls: calls };
}

function activityForPrompt(text) {
  const lower = text.toLowerCase();
  if (/chess|tactic|game/.test(lower)) return 'slow-chess';
  if (/song|music|film|raga|trivia/.test(lower)) return 'ragas-stories';
  if (/sketch|draw|postcard|art/.test(lower)) return 'chai-sketch';
  return 'garden-circle';
}
function interestForPrompt(text) {
  const lower = text.toLowerCase();
  for (const tag of ['gardening', 'games', 'music', 'art']) if (lower.includes(tag) || (tag === 'games' && lower.includes('chess')) || (tag === 'music' && /song|film|raga/.test(lower)) || (tag === 'art' && /sketch|draw|postcard/.test(lower))) return tag;
  return null;
}
function wantsContactFromText(text) {
  return /\b(maya|contact|message|call)\b|\btext\s+(?:my\s+)?(?:friend|helper|neighbou?r|contact|maya)\b|\bask.{0,40}help\b|\bpractical help\b|\bhelp.{0,80}(appointment|transport|ride|trip)\b/i.test(text);
}
function guideForPrompt(text) {
  const lower = text.toLowerCase();
  if (/chai|tea|masala/.test(lower)) return 'masala-chai';
  if (/compost|balcony soil/.test(lower)) return 'balcony-compost';
  return 'herb-pot';
}
function activityForFollowUp(message, history) {
  const current = message.toLowerCase();
  if (/chess|tactic|game/.test(current)) return 'slow-chess';
  if (/song|music|film|raga|trivia/.test(current)) return 'ragas-stories';
  if (/sketch|draw|postcard|art/.test(current)) return 'chai-sketch';
  if (/garden|gardening|herb/.test(current)) return 'garden-circle';
  for (const item of history.slice(-8).reverse()) {
    const prior = (item.content || '').toLowerCase();
    if (prior.includes('"tool":"get_activity_recommendations"')) {
      const ids = [...prior.matchAll(/"id":"(garden-circle|slow-chess|ragas-stories|chai-sketch)"/g)].map(match => match[1]);
      return ids.length === 1 ? ids[0] : null;
    }
    if (/slow morning chess|chess|tactic/.test(prior)) return 'slow-chess';
    if (/old film songs|ragas|music circle/.test(prior)) return 'ragas-stories';
    if (/postcard sketching|sketch|drawing/.test(prior)) return 'chai-sketch';
    if (/garden circle|gardening|garden club/.test(prior)) return 'garden-circle';
  }
  return activityForPrompt(message);
}
async function runInternalTool(name, args, calls) {
  const rpc = { jsonrpc: '2.0', id: `agent-${++rpcCounter}`, method: 'tools/call', params: { name, arguments: args } };
  const dispatched = await dispatchRpc(rpc);
  const toolResult = dispatched.response?.result;
  const result = toolResult?.structuredContent ?? { error: dispatched.response?.error || { code: 'TOOL_ERROR', message: 'No tool result.' } };
  calls.push({ name, args, result, payload: rpc, output: toolResult });
  return result;
}
async function planOffline(message, history = []) {
  const text = message.trim();
  const lower = text.toLowerCase();
  const priorText = history.slice(-6).map(item => item.content || '').join(' ').toLowerCase();
  const contextualText = `${text} ${priorText}`;
  const calls = [];
  const uiAction = { view: 'home', highlightId: null, previewData: null };
  let reply = '';

  const wantsContact = wantsContactFromText(lower);
  const urgentNoConsent = /(without asking|don.t ask|right now|just message|message .*now|send .*now)/.test(lower);
  if (wantsContact) {
    const ask = await runInternalTool('get_sharing_preview', { contactId: 'contact-demo', purpose: 'practical_help', message: 'Could you please contact me when you can? I would like practical help.' }, calls);
    uiAction.view = 'help'; uiAction.highlightId = 'previewBox'; uiAction.previewData = ask;
    reply = urgentNoConsent
      ? 'I prepared a preview for Maya. I did not send a message. Saathi requires you to review the exact recipient and text, then confirm in the UI; the create tool cannot act before that confirmation.'
      : 'I prepared a message preview for Maya. Review or edit the exact wording below; nothing has been sent.';
    return { reply, toolCalls: calls, uiAction };
  }

  const asksPreferences = /preference|what do you know about me|my settings/.test(lower);
  const asksJoin = /\b(join|sign me up)\b/.test(lower);
  const asksLeave = /\b(leave|unsubscribe|quit the group)\b/.test(lower);
  const asksUpcoming = /\b(upcoming|next session|my sessions|schedule)\b/.test(lower);
  const asksPriorGuideFollowUp = /\b(more|details|repeat|again|next|shorter|brief)\b/.test(lower) && priorText.includes('"tool":"get_task_guidance"');
  const asksGuidance = /\b(learn|guide|step|how do i|how to|cook|plant|compost|chai|tea)\b/.test(lower) || asksPriorGuideFollowUp;
  const asksActivities = /\b(find|recommend|show|activity|club|group|gardening|garden|chess|song|music|film|sketch|drawing|art)\b/.test(lower);
  const asksPriorActivityFollowUp = /\b(when|what time|meet|access|caption|more|details|tell me|where)\b/.test(lower) && priorText.includes('"tool":"get_activity_recommendations"');

  if (asksPreferences) {
    await runInternalTool('get_my_preferences', {}, calls);
    reply = 'Here are the preferences you chose. You can change or clear them in Privacy.';
  }
  if (asksActivities) {
    const interest = interestForPrompt(text);
    const participation_mode = /\b(observe|watch|listen only)\b/.test(lower) ? 'observe' : /\b(text|typed|write)\b/.test(lower) ? 'text' : null;
    const result = await runInternalTool('get_activity_recommendations', { interest, participation_mode }, calls);
    uiAction.view = 'activities'; uiAction.highlightId = result.items?.[0]?.id || null;
    if (!result.items?.length) reply = 'I could not find a club matching both filters. You can clear a filter to see more.';
    else {
      const firstMatch = result.items[0];
      const reason = firstMatch.matchReasons?.join(' ');
      const savedPreferenceCopy = !interest && result.personalized && reason
        ? ` The list is ranked using your saved preferences. ${reason}`
        : !interest && !preferences.interests.length
          ? ' You can choose interests in Privacy if you want Saathi to personalize the order.'
          : '';
      reply = `I found ${result.items.length} recurring club${result.items.length === 1 ? '' : 's'}: ${result.items.map(item => item.title).join(', ')}.${savedPreferenceCopy} All clubs stay available; review the access notes and choose whether to join.`;
    }
  }
  if (asksPriorActivityFollowUp && !asksActivities) {
    const groupId = activityForFollowUp(text, history);
    const group = activities.find(item => item.id === groupId);
    const interest = group?.tags.find(tag => ['gardening', 'games', 'music', 'art'].includes(tag)) || null;
    const result = await runInternalTool('get_activity_recommendations', { interest, participation_mode: null }, calls);
    const item = result.items?.find(activity => activity.id === groupId);
    uiAction.view = 'activities'; uiAction.highlightId = item?.id || null;
    reply = item
      ? `${item.title} meets ${item.recurrence}. It offers ${item.access.join(', ').toLowerCase()}. The next session is ${new Date(item.nextAt).toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })}.`
      : `Here are the current club times: ${result.items.map(activity => `${activity.title} meets ${activity.recurrence}`).join('; ')}.`;
  }
  if (asksJoin) {
    const groupId = activityForFollowUp(text, history);
    if (!groupId && /\b(it|that one|this one|the first|the second)\b/.test(lower)) {
      const choices = await runInternalTool('get_activity_recommendations', { interest: null, participation_mode: null }, calls);
      uiAction.view = 'activities';
      reply = `Which club would you like to join? The current options are ${choices.items.map(item => item.title).join(', ')}.`;
    } else {
      const result = await runInternalTool('join_activity', { groupId: groupId || activityForPrompt(text) }, calls);
      uiAction.view = 'activities'; uiAction.highlightId = groupId || activityForPrompt(text);
      reply = result.error?.message || `${result.message} You can find its sessions in My Groups.`;
    }
  } else if (asksLeave) {
    const groupId = activityForFollowUp(text, history);
    const result = await runInternalTool('leave_activity', { groupId }, calls);
    uiAction.view = 'activities'; uiAction.highlightId = groupId;
    reply = result.error?.message || result.message;
  }
  if (asksUpcoming) {
    const result = await runInternalTool('get_my_upcoming_sessions', {}, calls);
    uiAction.view = 'groups';
    reply = result.items?.length ? `You have ${result.items.length} upcoming session${result.items.length === 1 ? '' : 's'} in your joined groups.` : 'You have no joined sessions yet. Explore a group when you are ready.';
  }
  if (asksGuidance) {
    const guideId = guideForPrompt(contextualText);
    const explicitlyStepwise = /\b(step by step|one step at a time|slowly|repeat)\b/.test(lower);
    const detail = /\b(brief|quick|short|overview)\b/.test(lower) ? 'brief' : explicitlyStepwise ? 'stepwise' : preferences.detail;
    const result = await runInternalTool('get_task_guidance', { guideId, detail }, calls);
    uiAction.view = 'guidance'; uiAction.highlightId = guideId;
    reply = `${result.title} is ready in ${detail} mode. You can repeat a step or change the detail.`;
  }
  if (!calls.length) {
    const interest = interestForPrompt(text);
    const result = await runInternalTool('get_activity_recommendations', { interest, participation_mode: null }, calls);
    uiAction.view = 'activities'; uiAction.highlightId = result.items?.[0]?.id || null;
    reply = 'I can help find a recurring club, show your next session, or give a step-by-step guide. Here are a few activities to start with.';
  }
  return { reply, toolCalls: calls, uiAction };
}
export function getAgentProviderStatus() {
  if (bedrockMantleCredentials()) return { provider: 'bedrock_mantle', label: 'Amazon Bedrock Mantle', model: bedrockMantleModel(), region: process.env.BEDROCK_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1', status: 'configured' };
  if (process.env.BEDROCK_MODEL_ID) return { provider: 'bedrock', label: 'Amazon Bedrock', model: process.env.BEDROCK_MODEL_ID, region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1', status: 'configured' };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', label: 'OpenAI', model: process.env.OPENAI_MODEL || 'configured model', status: 'configured' };
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', label: 'Google Gemini', model: process.env.GEMINI_MODEL || 'configured model', status: 'configured' };
  return { provider: 'offline', label: 'Local demo planner', status: 'offline' };
}
async function agentChat(message, history = []) {
  if (typeof message !== 'string' || !message.trim() || message.length > 1000) return error(400, 'INVALID_MESSAGE', 'Message must contain 1–1000 characters.');
  const lower = message.toLowerCase();
  if (wantsContactFromText(lower)) {
    // Even with a provider configured, contact requests are constrained to preview-only tools.
    let result;
    try {
      if (bedrockMantleCredentials()) result = await callBedrockMantle(message, ['get_sharing_preview'], history);
      else if (process.env.BEDROCK_MODEL_ID) result = await callBedrock(message, ['get_sharing_preview'], history);
      else if (process.env.OPENAI_API_KEY) result = await callOpenAI(message, ['get_sharing_preview'], history);
      else if (process.env.GEMINI_API_KEY) result = await callGemini(message, ['get_sharing_preview'], history);
      else result = { toolCalls: [] };
    } catch (exception) { return error(502, 'AGENT_PROVIDER_ERROR', `Saathi could not reach the configured assistant: ${exception.message}`); }
    let previewCall = result.toolCalls.find(call => call.name === 'get_sharing_preview');
    if (!previewCall) {
      const calls = [];
      await runInternalTool('get_sharing_preview', { contactId: 'contact-demo', purpose: 'practical_help', message: 'Could you please contact me when you can? I would like practical help.' }, calls);
      previewCall = calls[0]; result.toolCalls.push(previewCall);
    }
    const urgent = /(without asking|don.t ask|right now|just message|message .*now|send .*now)/.test(lower);
    return { status: 200, value: { reply: urgent ? 'I prepared a preview for Maya. I did not send a message. Saathi requires you to review the exact recipient and text, then confirm in the UI; the create tool cannot act before that confirmation.' : 'I prepared a message preview for Maya. Review or edit the exact wording below; nothing has been sent.', toolCalls: result.toolCalls, uiAction: { view: 'help', highlightId: 'previewBox', previewData: previewCall.result } } };
  }
  try {
    let result;
    if (bedrockMantleCredentials()) result = await callBedrockMantle(message, null, history);
    else if (process.env.BEDROCK_MODEL_ID) result = await callBedrock(message, null, history);
    else if (process.env.OPENAI_API_KEY) result = await callOpenAI(message, null, history);
    else if (process.env.GEMINI_API_KEY) result = await callGemini(message, null, history);
    else result = await planOffline(message, history);
    const last = result.toolCalls.at(-1);
    let view = 'home';
    let highlightId = null;
    let previewData = null;
    if (result.toolCalls.some(call => call.name === 'get_sharing_preview')) { const preview = [...result.toolCalls].reverse().find(call => call.name === 'get_sharing_preview'); view = 'help'; previewData = preview?.result; highlightId = 'previewBox'; }
    else {
      const latestNavigation = [...result.toolCalls].reverse().find(call => ['get_task_guidance', 'get_activity_recommendations', 'join_activity', 'leave_activity', 'get_my_upcoming_sessions'].includes(call.name));
      if (latestNavigation?.name === 'get_task_guidance') { view = 'guidance'; highlightId = latestNavigation.result?.guideId; }
      else if (latestNavigation?.name === 'get_my_upcoming_sessions') view = 'groups';
      else if (latestNavigation) { view = 'activities'; highlightId = latestNavigation.result?.items?.[0]?.id || latestNavigation.result?.groupId || null; }
    }
    return { status: 200, value: { reply: result.reply, toolCalls: result.toolCalls, uiAction: { view, highlightId, previewData } } };
  } catch (exception) {
    return error(502, 'AGENT_PROVIDER_ERROR', `Saathi could not reach the configured assistant: ${exception.message}`);
  }
}
function tvState() {
  const nextSession = getSessions().filter(session => Date.parse(session.startsAt) >= Date.now()).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] || null;
  const guide = getGuide(activeGuide.guideId, activeGuide.detail);
  const latestHelpStatus = [...helpRequests.values()].at(-1) || null;
  const recommendations = getActivityRecommendations();
  return { user: { ...user, preferences }, nextSession, joinedSessions: getSessions(), allActivities: recommendations.items, recommendationNote: recommendations.note, activeGuide: guide, latestHelpStatus };
}

export async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/mcp' && req.method === 'POST') return handleMcpPost(req, res);
  if (url.pathname === '/mcp' && req.method === 'GET') return handleMcpGet(req, res);
  if (url.pathname === '/mcp') return empty(res, 405, { allow: 'GET, POST' });

  if (req.method === 'GET' && url.pathname === '/api/agent/status') return json(res, 200, getAgentProviderStatus());
  const agentSessionRoute = url.pathname.match(/^\/api\/agent\/session\/([A-Za-z0-9_-]{20,80})$/);
  if (agentSessionRoute && req.method === 'GET') {
    const session = getAgentSession(agentSessionRoute[1]);
    return json(res, 200, { sessionId: agentSessionRoute[1], messages: session?.turns.flatMap(turn => [{ role: 'user', content: turn.user }, { role: 'assistant', content: turn.assistant }]) || [], turns: session?.turns.length || 0, maxTurns: MAX_AGENT_TURNS, expiresInMinutes: Math.floor(AGENT_SESSION_IDLE_MS / 60_000) });
  }
  if (agentSessionRoute && req.method === 'DELETE') {
    agentSessions.delete(agentSessionRoute[1]);
    return json(res, 200, { sessionId: agentSessionRoute[1], cleared: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { ...user, preferences });
  if (req.method === 'PATCH' && url.pathname === '/api/me/preferences') {
    try {
      const input = await body(req);
      const allowed = new Set(['interests', 'detail', 'captions', 'textSize']);
      const unexpected = Object.keys(input).find(key => !allowed.has(key));
      if (unexpected) return json(res, 400, { error: { code: 'INVALID_PREFERENCES', message: `Unknown preference: ${unexpected}.` } });
      if (!Array.isArray(input.interests) || input.interests.some(interest => !['gardening', 'games', 'music', 'art'].includes(interest)) || new Set(input.interests).size !== input.interests.length) {
        return json(res, 400, { error: { code: 'INVALID_PREFERENCES', message: 'Choose zero or more supported interests.' } });
      }
      if (!['stepwise', 'brief'].includes(input.detail)) return json(res, 400, { error: { code: 'INVALID_PREFERENCES', message: 'Instruction detail must be stepwise or brief.' } });
      if (typeof input.captions !== 'boolean') return json(res, 400, { error: { code: 'INVALID_PREFERENCES', message: 'Captions must be on or off.' } });
      if (!['large', 'default'].includes(input.textSize)) return json(res, 400, { error: { code: 'INVALID_PREFERENCES', message: 'Text size must be large or default.' } });
      preferences = { interests: [...input.interests], detail: input.detail, captions: input.captions, textSize: input.textSize };
      return json(res, 200, { preferences, message: 'Your choices are saved across the Saathi demo.' });
    } catch { return json(res, 400, { error: { code: 'INVALID_REQUEST', message: 'Preference choices could not be read.' } }); }
  }
  if (req.method === 'DELETE' && url.pathname === '/api/me/preferences') {
    preferences = { interests: [], detail: 'brief', captions: false, textSize: 'default' };
    return json(res, 200, { preferences, message: 'Demo preferences were cleared.' });
  }
  if (req.method === 'GET' && url.pathname === '/api/activities') {
    const interest = url.searchParams.get('interest');
    const participation_mode = url.searchParams.get('participation_mode');
    return json(res, 200, getActivityRecommendations({ interest, participation_mode }));
  }
  const membershipRoute = url.pathname.match(/^\/api\/activities\/([a-z0-9-]+)\/(join|leave)$/);
  if (req.method === 'POST' && membershipRoute) {
    const activity = findActivity(membershipRoute[1]);
    if (!activity) return json(res, 404, { error: { code: 'ACTIVITY_NOT_FOUND', message: 'That activity could not be found.' } });
    const result = await invokeTool(membershipRoute[2] === 'join' ? 'join_activity' : 'leave_activity', { groupId: activity.id });
    return json(res, 200, result.structuredContent);
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, 200, { items: getSessions() });
  if (req.method === 'GET' && url.pathname === '/api/guidance') {
    const guideId = url.searchParams.get('guide') || 'herb-pot';
    const detail = url.searchParams.get('detail') || 'stepwise';
    if (!['stepwise', 'brief'].includes(detail)) return json(res, 400, { error: { code: 'INVALID_DETAIL', message: 'detail must be stepwise or brief.' } });
    const guide = getGuide(guideId, detail);
    if (!guide) return json(res, 404, { error: { code: 'GUIDE_NOT_FOUND', message: 'That guide is not available.' } });
    activeGuide = { guideId, detail };
    return json(res, 200, guide);
  }
  if (req.method === 'POST' && url.pathname === '/api/guidance/progress') {
    try {
      const input = await body(req);
      const guide = guides[input.guideId];
      if (!guide || !Number.isInteger(input.currentStep) || input.currentStep < 0 || input.currentStep >= guide.steps.length) return json(res, 400, { error: { code: 'INVALID_GUIDE_PROGRESS', message: 'Choose a valid guide step.' } });
      currentStep.set(input.guideId, input.currentStep); activeGuide = { guideId: input.guideId, detail: input.detail === 'brief' ? 'brief' : 'stepwise' };
      return json(res, 200, getGuide(activeGuide.guideId, activeGuide.detail));
    } catch { return json(res, 400, { error: { code: 'INVALID_REQUEST', message: 'Guide progress could not be updated.' } }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/chat') {
    try {
      const input = await body(req);
      if (input.sessionId !== undefined && !validAgentSessionId(input.sessionId)) return json(res, 400, { error: { code: 'INVALID_SESSION_ID', message: 'Start a new chat session and try again.' } });
      const session = (input.sessionId && getAgentSession(input.sessionId)) || createAgentSession(input.sessionId || undefined);
      const result = await agentChat(input.message, getAgentHistory(session));
      if (result.status !== 200) return json(res, result.status, result.value);
      rememberAgentTurn(session, input.message, result.value.reply, result.value.toolCalls);
      return json(res, 200, { ...result.value, sessionId: session.id, memory: { turns: session.turns.length, maxTurns: MAX_AGENT_TURNS, expiresInMinutes: Math.floor(AGENT_SESSION_IDLE_MS / 60_000) } });
    } catch { return json(res, 400, { error: { code: 'INVALID_REQUEST', message: 'Agent request could not be read.' } }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/tv/state') return json(res, 200, tvState());
  if (req.method === 'POST' && url.pathname === '/api/help/preview') {
    try {
      const input = await body(req);
      const result = await invokeTool('get_sharing_preview', input);
      if (result.isError) return json(res, 400, result.structuredContent);
      return json(res, 200, result.structuredContent);
    } catch (exception) { return json(res, exception.status || 400, { error: { code: 'INVALID_REQUEST', message: 'The preview could not be created.' } }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/help/review') {
    try {
      const input = await body(req);
      const preview = previews.get(input.previewId);
      if (!preview || Date.now() - preview.createdAt > 5 * 60 * 1000) return json(res, 404, { error: { code: 'PREVIEW_NOT_FOUND', message: 'This preview expired or is no longer available.' } });
      preview.userReviewed = true;
      return json(res, 200, { previewId: preview.previewId, reviewed: true });
    } catch { return json(res, 400, { error: { code: 'INVALID_REQUEST', message: 'Preview review could not be recorded.' } }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/help/confirm') {
    try {
      const input = await body(req);
      const preview = previews.get(input.previewId);
      if (!preview || !preview.userReviewed || input.confirmed !== true) return json(res, 409, { error: { code: 'USER_CONSENT_REQUIRED', message: 'Review the exact preview and explicitly confirm it in the UI.' } });
      preview.userConfirmed = true;
      return json(res, 200, { previewId: preview.previewId, confirmed: true });
    } catch { return json(res, 400, { error: { code: 'INVALID_REQUEST', message: 'The request was not confirmed.' } }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/help/status') return json(res, 200, { items: [...helpRequests.values()] });

  const staticRoute = url.pathname === '/' ? '/index.html' : url.pathname;
  if (req.method === 'GET' && ['/index.html', '/app.js', '/styles.css'].includes(staticRoute)) {
    try {
      const content = await readFile(path.join(root, 'web', staticRoute.slice(1)));
      const type = staticRoute.endsWith('.js') ? 'text/javascript; charset=utf-8' : staticRoute.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(content);
    } catch { return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Page not found.' } }); }
  }
  return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } });
}

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer(route);
  server.on('error', exception => { console.error(`Saathi could not listen on ${host}:${port}: ${exception.message}`); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Saathi demo at http://${host}:${port} (MCP at /mcp; demo contact delivery is simulated)`));
}
