const $ = selector => document.querySelector(selector);
function newSessionId() { return `web-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}`; }
function loadSessionId() {
  try { const saved = sessionStorage.getItem('saathi.chatSessionId'); if (saved) return saved; const id = newSessionId(); sessionStorage.setItem('saathi.chatSessionId', id); return id; }
  catch { return newSessionId(); }
}
const state = { view: 'home', interest: null, access: null, mode: null, guide: 'herb-pot', detail: 'stepwise', detailTouched: false, currentStep: 0, trace: [], preview: null, rpcId: 0, mcpInitialized: false, tvTimer: null, conversation: [], sessionId: loadSessionId(), historyLoaded: false };
const api = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Saathi returned ${response.status}.`);
  return data;
};
async function loadAgentStatus() {
  const node = $('#agentMode');
  try {
    const status = await api('/api/agent/status');
    node.textContent = status.provider === 'bedrock'
      ? `Amazon Bedrock configured · ${status.model}`
      : status.provider === 'offline'
        ? 'AI: local planner (no model configured)'
        : `AI: ${status.label} configured`;
    $('#chatMode').textContent = status.provider === 'offline' ? 'Saathi demo planner' : `${status.label} · connected`;
    node.title = status.status === 'configured' ? 'Provider is configured; a successful model call is confirmed when an agent response appears.' : 'Uses deterministic local tool planning; no language model is called.';
  } catch {
    node.textContent = 'Agent status unavailable';
  }
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function announce(message, isError = false) { const box = $('#notice'); box.textContent = message; box.hidden = false; box.classList.toggle('error', isError); box.focus(); }
function go(view) {
  if (!document.getElementById(view)) return;
  state.view = view;
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== view; });
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  $('#notice').hidden = true;
  if (view === 'activities') loadActivities();
  if (view === 'groups') loadGroups();
  if (view === 'guidance') loadGuide();
  if (view === 'privacy') loadPreferences();
  if (view === 'help') loadStatuses();
  if (view === 'tv') { loadTvState(); focusFirstTvControl(); }
  if (view === 'chat' && state.historyLoaded && !state.conversation.length) showWelcomeMessage();
  history.replaceState({}, '', `#${view}`);
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => go(button.dataset.view)));

function traceEvent(title, payload, output, kind = 'tools/call') {
  state.trace.unshift({ title, kind, payload, output, at: new Date().toLocaleTimeString() });
  state.trace = state.trace.slice(0, 20);
  renderTrace();
}
function renderTrace() {
  $('#traceCount').textContent = String(state.trace.length);
  const root = $('#traceLog');
  root.replaceChildren();
  if (!state.trace.length) { root.innerHTML = '<p class="muted">Tool calls will appear here.</p>'; return; }
  for (const item of state.trace) {
    const entry = document.createElement('article'); entry.className = 'trace-entry';
    const heading = document.createElement('h3'); heading.textContent = `${item.title} · ${item.at}`;
    const payloadLabel = document.createElement('strong'); payloadLabel.textContent = item.kind === 'Consent boundary' ? 'Consent boundary' : 'JSON-RPC payload';
    const payload = document.createElement('pre'); payload.textContent = JSON.stringify(item.payload, null, 2);
    const outputLabel = document.createElement('strong'); outputLabel.textContent = 'Tool output / result';
    const output = document.createElement('pre'); output.textContent = JSON.stringify(item.output, null, 2);
    entry.append(heading, payloadLabel, payload, outputLabel, output); root.append(entry);
  }
}
async function mcpCall(name, args = {}) {
  if (!state.mcpInitialized) {
    const payload = { jsonrpc: '2.0', id: `web-${++state.rpcId}`, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'saathi-web-simulation', version: '0.2.0' } } };
    const response = await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(payload) });
    const envelope = await response.json(); traceEvent('initialize', payload, envelope.result || envelope.error, 'initialize');
    if (!response.ok || envelope.error) throw new Error(envelope.error?.message || 'MCP initialization failed.');
    const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };
    await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify(notification) });
    state.mcpInitialized = true;
  }
  const payload = { jsonrpc: '2.0', id: `web-${++state.rpcId}`, method: 'tools/call', params: { name, arguments: args } };
  const response = await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify(payload) });
  const envelope = response.status === 202 ? null : await response.json();
  const output = envelope?.result || envelope?.error || { accepted: true };
  traceEvent(name, payload, output);
  if (!response.ok || envelope?.error) throw new Error(envelope?.error?.message || `MCP request failed (${response.status}).`);
  if (envelope?.result?.isError) {
    const failure = envelope.result.structuredContent?.error;
    throw new Error(failure?.message || 'The Saathi tool could not complete that action.');
  }
  return envelope?.result?.structuredContent;
}
function traceAgentCalls(calls = []) {
  for (const call of [...calls].reverse()) {
    const payload = call.payload || { jsonrpc: '2.0', id: `agent-${++state.rpcId}`, method: 'tools/call', params: { name: call.name, arguments: call.args } };
    traceEvent(call.name, payload, call.output || { structuredContent: call.result, isError: Boolean(call.result?.error) });
  }
}

const interestOptions = [['all', 'All interests'], ['gardening', 'Gardening'], ['games', 'Games'], ['music', 'Music'], ['art', 'Art']];
const accessOptions = [['all', 'All access tags'], ['captions', 'Captions'], ['observe-ok', 'Observe is okay'], ['no-timer', 'No timer'], ['text-moves', 'Text moves'], ['audio-described', 'Audio-described'], ['stepwise', 'Stepwise']];
const modeOptions = [['all', 'Any way'], ['speak', 'Speak'], ['choose', 'Choose'], ['text', 'Text'], ['observe', 'Observe']];
function makeFilterChips(container, options, key) {
  container.replaceChildren();
  for (const [value, label] of options) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'filter-chip';
    const selected = state[key] === (value === 'all' ? null : value);
    button.setAttribute('aria-pressed', String(selected)); button.textContent = label;
    button.addEventListener('click', () => { state[key] = value === 'all' ? null : value; loadActivities(); });
    container.append(button);
  }
}
function activityCard(activity) {
  return `<article class="activity-card" id="activity-${escapeHtml(activity.id)}"><div class="activity-icon" aria-hidden="true">${{ 'garden-circle': '🌱', 'slow-chess': '♟', 'ragas-stories': '♫', 'chai-sketch': '✎' }[activity.id] || '✳'}</div><div class="activity-copy"><p class="eyebrow">${escapeHtml(activity.recurrence)} · RECURRING CLUB</p><h2>${escapeHtml(activity.title)}</h2><p>${escapeHtml(activity.description)}</p><div class="tag-list">${activity.tags.map(tag => `<span class="badge">${escapeHtml(tag)}</span>`).join('')}</div><ul>${activity.access.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul><p class="next-label">Next session · ${new Date(activity.nextAt).toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</p><div class="button-row"><button class="${activity.joined ? 'secondary' : 'primary'} activity-toggle" data-id="${escapeHtml(activity.id)}" data-joined="${activity.joined}">${activity.joined ? 'Leave group' : `Join ${escapeHtml(activity.title)}`}</button><button class="text-button activity-info" data-id="${escapeHtml(activity.id)}">Details</button></div></div></article>`;
}
async function loadActivities() {
  makeFilterChips($('#interestFilters'), interestOptions, 'interest');
  makeFilterChips($('#accessFilters'), accessOptions, 'access');
  makeFilterChips($('#modeFilters'), modeOptions, 'mode');
  try {
    const query = new URLSearchParams(); if (state.interest) query.set('interest', state.interest); if (state.mode) query.set('participation_mode', state.mode);
    const { items } = await api(`/api/activities?${query}`);
    const filtered = state.access ? items.filter(activity => activity.tags.includes(state.access)) : items;
    $('#activityList').innerHTML = filtered.length ? filtered.map(activityCard).join('') : '<div class="card"><h2>No activities match those filters</h2><p>Try clearing one filter to see more options.</p></div>';
    $('#activityList').querySelectorAll('.activity-toggle').forEach(button => button.addEventListener('click', async () => {
      const join = button.dataset.joined !== 'true';
      try { const result = await mcpCall(join ? 'join_activity' : 'leave_activity', { groupId: button.dataset.id }); announce(result.message); loadActivities(); loadGroups(); loadTvState(); }
      catch (exception) { announce(exception.message, true); }
    }));
    $('#activityList').querySelectorAll('.activity-info').forEach(button => button.addEventListener('click', () => { document.getElementById(`activity-${button.dataset.id}`).scrollIntoView({ block: 'center', behavior: 'smooth' }); document.querySelector(`#activity-${button.dataset.id} .activity-toggle`).focus(); }));
  } catch (exception) { announce(exception.message, true); }
}
async function loadGroups() {
  try {
    const { items } = await api('/api/sessions');
    const target = $('#groupList');
    if (!items.length) { target.innerHTML = '<div class="card"><h2>No groups yet</h2><p>Explore activities and join one when it feels right.</p><button class="primary" data-view="activities">Explore activities</button></div>'; target.querySelector('[data-view]').onclick = () => go('activities'); return; }
    target.innerHTML = items.map(item => `<article class="group-item"><p class="eyebrow">${escapeHtml(item.recurrence)}</p><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.topic)}</p><p><strong>Next session</strong> · ${new Date(item.startsAt).toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })}</p><p>${item.access.map(escapeHtml).join(' · ')}</p><button class="secondary leave-group" data-id="${escapeHtml(item.groupId)}">Leave group</button></article>`).join('');
    target.querySelectorAll('.leave-group').forEach(button => button.onclick = async () => { try { await mcpCall('leave_activity', { groupId: button.dataset.id }); announce('You left the group. You can join again at any time.'); loadGroups(); loadActivities(); loadTvState(); } catch (exception) { announce(exception.message, true); } });
  } catch (exception) { announce(exception.message, true); }
}
async function loadGuide() {
  try {
    if (!state.detailTouched) {
      const { preferences } = await api('/api/me');
      state.detail = preferences.detail;
    }
    const guide = await api(`/api/guidance?guide=${encodeURIComponent(state.guide)}&detail=${state.detail}`);
    state.currentStep = guide.currentStep; $('#guideTitle').textContent = guide.title; $('#guideNote').textContent = guide.note;
    $('#steps').innerHTML = guide.steps.map(step => `<li${state.detail === 'stepwise' ? ' class="current-step"' : ''}>${escapeHtml(step)}</li>`).join('');
    if (state.detail === 'stepwise') $('#guideNote').textContent = `Step ${guide.currentStepNumber} of ${guide.totalSteps}. ${guide.note}`;
    $('#previousStep').hidden = state.detail !== 'stepwise' || state.currentStep === 0;
    $('#nextStep').hidden = state.detail !== 'stepwise' || state.currentStep >= guide.totalSteps - 1;
    document.querySelectorAll('.detail-choice').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.detail === state.detail)));
  } catch (exception) { announce(exception.message, true); }
}
$('#guideSelect').addEventListener('change', event => { state.guide = event.target.value; loadGuide(); });
document.querySelectorAll('.detail-choice').forEach(button => button.addEventListener('click', () => { state.detail = button.dataset.detail; state.detailTouched = true; loadGuide(); }));
$('#previousStep').addEventListener('click', async () => changeStep(-1)); $('#nextStep').addEventListener('click', async () => changeStep(1));
async function changeStep(delta) {
  const count = { 'herb-pot': 4, 'masala-chai': 4, 'balcony-compost': 4 }[state.guide];
  state.currentStep = Math.max(0, Math.min(count - 1, state.currentStep + delta));
  try { await api('/api/guidance/progress', { method: 'POST', body: JSON.stringify({ guideId: state.guide, currentStep: state.currentStep, detail: state.detail }) }); await loadGuide(); loadTvState(); }
  catch (exception) { announce(exception.message, true); }
}

function showPreview(preview) {
  if (!preview || !preview.previewId) { announce('The preview could not be displayed. No request was sent.', true); return; }
  state.preview = preview;
  const box = $('#previewBox'); box.replaceChildren();
  const card = document.createElement('article'); card.className = 'card preview';
  const label = document.createElement('p'); label.className = 'eyebrow'; label.textContent = 'PLEASE REVIEW · NOTHING SENT YET';
  const heading = document.createElement('h2'); heading.textContent = 'What will be shared';
  const dl = document.createElement('dl');
  for (const [key, value] of [['Recipient', preview.recipient], ['Purpose', preview.purpose], ['Message', preview.message], ['Included', preview.shares.join(', ')], ['Not included', preview.notShared.join(', ')]]) { const dt = document.createElement('dt'); dt.textContent = key; const dd = document.createElement('dd'); dd.textContent = value; dl.append(dt, dd); }
  const helper = document.createElement('p'); helper.className = 'helper'; helper.textContent = 'Maya is a demo contact. Confirming creates a simulated record only; no person or service is contacted.';
  const actions = document.createElement('div'); actions.className = 'button-row';
  const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => { state.preview = null; box.replaceChildren(); announce('Cancelled. Nothing was sent.'); traceEvent('User cancelled help preview', { previewId: preview.previewId }, { message: 'No confirmation recorded.' }, 'Consent boundary'); };
  const confirm = document.createElement('button'); confirm.className = 'primary'; confirm.textContent = 'I reviewed this · Confirm demo request'; confirm.onclick = async () => {
    confirm.disabled = true;
    try {
      await api('/api/help/review', { method: 'POST', body: JSON.stringify({ previewId: preview.previewId }) });
      traceEvent('User reviewed preview', { previewId: preview.previewId }, { reviewed: true }, 'Consent boundary');
      await api('/api/help/confirm', { method: 'POST', body: JSON.stringify({ previewId: preview.previewId, confirmed: true }) });
      traceEvent('User explicitly confirmed', { previewId: preview.previewId, confirmed: true }, { consent: 'one-time UI confirmation recorded' }, 'Consent boundary');
      const result = await mcpCall('create_help_request', { previewId: preview.previewId, confirmed: true });
      state.preview = null; box.replaceChildren(); announce(result.message); loadStatuses(); loadTvState();
    } catch (exception) { confirm.disabled = false; announce(exception.message, true); }
  };
  actions.append(cancel, confirm); card.append(label, heading, dl, helper, actions); box.append(card); confirm.focus();
  traceEvent('Sharing preview presented', { previewId: preview.previewId }, { recipient: preview.recipient, message: preview.message, shares: preview.shares, notShared: preview.notShared, createHelpRequest: 'blocked until user confirms' }, 'Consent boundary');
}
$('#preview').addEventListener('click', async () => {
  const message = $('#message').value.trim();
  try { const preview = await mcpCall('get_sharing_preview', { contactId: 'contact-demo', purpose: 'practical_help', message }); showPreview(preview); }
  catch (exception) { announce(exception.message, true); }
});
async function loadStatuses() {
  try { const { items } = await api('/api/help/status'); $('#requestStatus').innerHTML = items.map(request => `<div class="status-card"><strong>Request status: ${escapeHtml(request.status)}</strong><p>${escapeHtml(request.message)}</p></div>`).join(''); }
  catch (exception) { announce(exception.message, true); }
}
async function loadPreferences() {
  try {
    const { preferences } = await api('/api/me');
    const fieldset = document.createElement('fieldset'); fieldset.className = 'preference-fieldset';
    const legend = document.createElement('legend'); legend.textContent = 'Interests'; fieldset.append(legend);
    for (const [value, label] of [['gardening', 'Gardening'], ['games', 'Games and puzzles'], ['music', 'Music'], ['art', 'Art and making']]) {
      const row = document.createElement('label'); row.className = 'preference-choice';
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'interest'; input.value = value; input.checked = preferences.interests.includes(value);
      const text = document.createElement('span'); text.textContent = label; row.append(input, text); fieldset.append(row);
    }
    const form = document.createElement('div'); form.className = 'preference-controls';
    const captionsLabel = document.createElement('label'); captionsLabel.className = 'preference-choice';
    const captions = document.createElement('input'); captions.type = 'checkbox'; captions.id = 'prefCaptions'; captions.checked = preferences.captions;
    const captionsText = document.createElement('span'); captionsText.textContent = 'Prefer sessions with captions'; captionsLabel.append(captions, captionsText);
    const detailLabel = document.createElement('label'); detailLabel.htmlFor = 'prefDetail'; detailLabel.textContent = 'Instruction detail';
    const detail = document.createElement('select'); detail.id = 'prefDetail'; detail.innerHTML = '<option value="stepwise">One step at a time</option><option value="brief">Quick overview</option>'; detail.value = preferences.detail;
    const sizeLabel = document.createElement('label'); sizeLabel.htmlFor = 'prefTextSize'; sizeLabel.textContent = 'Text size on Saathi screens';
    const size = document.createElement('select'); size.id = 'prefTextSize'; size.innerHTML = '<option value="large">Large</option><option value="default">Default</option>'; size.value = preferences.textSize;
    form.append(captionsLabel, detailLabel, detail, sizeLabel, size); $('#preferenceList').replaceChildren(fieldset, form);
    $('#preferenceStatus').textContent = 'These choices are shared with the TV companion preview and Vega app.';
  } catch (exception) { announce(exception.message, true); }
}
$('#savePrefs').addEventListener('click', async () => {
  const preferences = {
    interests: [...document.querySelectorAll('#preferenceList input[name="interest"]:checked')].map(input => input.value),
    detail: $('#prefDetail').value,
    captions: $('#prefCaptions').checked,
    textSize: $('#prefTextSize').value,
  };
  const button = $('#savePrefs'); button.disabled = true; $('#preferenceStatus').textContent = 'Saving your choices…';
  try { const result = await api('/api/me/preferences', { method: 'PATCH', body: JSON.stringify(preferences) }); state.detailTouched = false; $('#preferenceStatus').textContent = result.message; loadTvState(); }
  catch (exception) { $('#preferenceStatus').textContent = `Could not save your choices. ${exception.message}`; }
  finally { button.disabled = false; }
});
$('#clearPrefs').addEventListener('click', async () => {
  const button = $('#clearPrefs'); button.disabled = true;
  try { const result = await api('/api/me/preferences', { method: 'DELETE' }); state.detailTouched = false; await loadPreferences(); $('#preferenceStatus').textContent = result.message; loadTvState(); }
  catch (exception) { announce(exception.message, true); }
  finally { button.disabled = false; }
});

async function askAgent(text) {
  const message = text.trim();
  if (!message) { $('#chatInput')?.focus(); return; }
  const sendButtons = [$('#ask'), $('#chatSend')].filter(Boolean);
  sendButtons.forEach(button => { button.disabled = true; });
  addChatMessage('user', message);
  const pending = addChatMessage('assistant', 'I’m checking that for you…', { pending: true });
  try {
    const result = await api('/api/agent/chat', { method: 'POST', body: JSON.stringify({ message, sessionId: state.sessionId }) });
    if (result.sessionId && result.sessionId !== state.sessionId) { state.sessionId = result.sessionId; try { sessionStorage.setItem('saathi.chatSessionId', state.sessionId); } catch {} }
    if (result.memory) $('#chatMemoryStatus').textContent = `Remembering ${result.memory.turns} of ${result.memory.maxTurns} recent turns for up to ${result.memory.expiresInMinutes} minutes of inactivity. Start a new chat to clear them. Context may be sent to the configured AI provider.`;
    traceAgentCalls(result.toolCalls);
    pending.remove();
    addChatMessage('assistant', result.reply || 'I have a result for you.', { action: result.uiAction });
    if (result.uiAction?.view === 'guidance' && result.uiAction.highlightId) { state.guide = result.uiAction.highlightId; $('#guideSelect').value = state.guide; }
    if (result.uiAction?.previewData) { go('help'); showPreview(result.uiAction.previewData); }
    else go('chat');
    if (result.uiAction?.highlightId && result.uiAction.view === 'activities') setTimeout(() => document.getElementById(`activity-${result.uiAction.highlightId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 20);
  } catch (exception) { pending.remove(); addChatMessage('assistant', `I couldn’t reach the assistant just now. ${exception.message}`, { error: true }); go('chat'); }
  finally { sendButtons.forEach(button => { button.disabled = false; }); }
}
function addChatMessage(role, text, options = {}) {
  const root = $('#chatMessages');
  const row = document.createElement('article'); row.className = `chat-message ${role}${options.error ? ' error' : ''}${options.pending ? ' pending' : ''}`;
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = role === 'assistant' ? 'स' : 'A';
  const body = document.createElement('div'); body.className = 'message-body';
  const label = document.createElement('span'); label.className = 'message-label'; label.textContent = role === 'assistant' ? 'Saathi' : 'You';
  const content = document.createElement('p'); content.className = 'message-text'; content.textContent = text;
  body.append(label, content);
  if (options.action?.view && ['activities', 'groups', 'guidance', 'privacy', 'help'].includes(options.action.view) && !options.action.previewData) {
    const action = document.createElement('button'); action.className = 'text-button message-action'; action.type = 'button';
    action.textContent = ({ activities: 'Browse these activities →', groups: 'See my gatherings →', guidance: 'Open this guide →', privacy: 'Review privacy choices →', help: 'Open help controls →' })[options.action.view];
    action.addEventListener('click', () => go(options.action.view)); body.append(action);
  }
  row.append(avatar, body); root.append(row); root.scrollTop = root.scrollHeight;
  state.conversation.push({ role, text });
  return row;
}
function showWelcomeMessage() {
  if (state.conversation.length) return;
  addChatMessage('assistant', 'Hello Asha. What would you like to explore today? I can help you find a welcoming group, learn a task one step at a time, or review a request for practical help.');
}
$('#chatForm').addEventListener('submit', event => { event.preventDefault(); const input = $('#chatInput'); const message = input.value; if (!message.trim()) return; input.value = ''; input.style.height = ''; askAgent(message); });
$('#chatInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#chatForm').requestSubmit(); } });
$('#chatInput').addEventListener('input', event => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`; });
document.querySelectorAll('.chip[data-chat-prompt]').forEach(chip => chip.addEventListener('click', () => askAgent(chip.dataset.chatPrompt)));
$('#clearChat').addEventListener('click', async () => {
  const button = $('#clearChat'); button.disabled = true;
  try {
    await api(`/api/agent/session/${encodeURIComponent(state.sessionId)}`, { method: 'DELETE' });
    state.conversation = []; $('#chatMessages').replaceChildren(); showWelcomeMessage(); $('#chatInput').focus();
    $('#chatMemoryStatus').textContent = 'New chat started. The previous in-memory conversation was cleared.';
  } catch (exception) { addChatMessage('assistant', `I couldn’t clear this chat yet. ${exception.message}`, { error: true }); }
  finally { button.disabled = false; }
});
$('#ask').addEventListener('click', () => { go('chat'); askAgent($('#prompt').value); $('#prompt').value = ''; });
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter') { go('chat'); askAgent($('#prompt').value); $('#prompt').value = ''; } });
document.querySelectorAll('.chip[data-prompt]').forEach(chip => chip.addEventListener('click', () => { go('chat'); askAgent(chip.dataset.prompt); }));

async function loadTvState() {
  try {
    const data = await api('/api/tv/state');
    $('#tv').dataset.textSize = data.user.preferences.textSize;
    $('#tvPreferenceSummary').textContent = `A shared screen for the activities you chose · caption preference ${data.user.preferences.captions ? 'on' : 'off'}`;
    $('#tvNextTitle').textContent = data.nextSession?.title || 'Choose a club to get started';
    $('#tvNextMeta').textContent = data.nextSession ? `${new Date(data.nextSession.startsAt).toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })} · ${data.nextSession.topic}` : 'Your next session will appear here after you join a club.';
    const target = $('#tvJoined');
    const joinedMarkup = data.joinedSessions.length ? data.joinedSessions.slice(0, 4).map((session, index) => `<button class="tv-group-card" data-group-id="${escapeHtml(session.groupId)}" data-tv-focus="${index + 2}" data-tv-view="groups"><span class="tv-kicker">${escapeHtml(session.recurrence)}</span><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.topic)}</span></button>`).join('') : '<div class="tv-empty">No groups yet. Browse an activity when you are ready.</div>';
    if (target.innerHTML !== joinedMarkup) {
      const focusedControl = state.view === 'tv' && target.contains(document.activeElement) ? document.activeElement : null;
      const focusedGroupId = focusedControl?.dataset.groupId;
      const focusedIndex = focusedControl?.dataset.tvFocus;
      target.innerHTML = joinedMarkup;
      if (focusedControl) {
        const controls = [...target.querySelectorAll('[data-tv-focus]')];
        const restore = controls.find(control => focusedGroupId && control.dataset.groupId === focusedGroupId) || controls.find(control => control.dataset.tvFocus === focusedIndex) || document.querySelector('#tv [data-tv-view="activities"]');
        restore?.focus();
      }
    }
    $('#tvLastUpdated').textContent = new Date().toLocaleTimeString('en-IN');
  } catch { $('#tvLastUpdated').textContent = 'Could not sync'; }
}
document.querySelectorAll('[data-tv-view]').forEach(button => button.addEventListener('click', () => go(button.dataset.tvView)));
$('#tvJoined').addEventListener('click', event => { const button = event.target.closest('[data-tv-view]'); if (button) go(button.dataset.tvView); });
document.addEventListener('keydown', event => {
  if (state.view !== 'tv' || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  const current = document.activeElement.closest('[data-tv-focus]');
  if (!current) { event.preventDefault(); focusFirstTvControl(); return; }
  const controls = [...document.querySelectorAll('#tv [data-tv-focus],#tv [data-tv-view]')].filter(element => !element.closest('[hidden]') && element.getClientRects().length > 0);
  const here = current.getBoundingClientRect(); const cx = here.left + here.width / 2; const cy = here.top + here.height / 2;
  const candidates = controls.filter(element => element !== current).map(element => { const rect = element.getBoundingClientRect(); const x = rect.left + rect.width / 2 - cx; const y = rect.top + rect.height / 2 - cy; const forward = event.key === 'ArrowRight' ? x : event.key === 'ArrowLeft' ? -x : event.key === 'ArrowDown' ? y : -y; const side = event.key.startsWith('ArrowLeft') || event.key.startsWith('ArrowRight') ? Math.abs(y) : Math.abs(x); return { element, forward, score: forward + side * 2.2 }; }).filter(candidate => candidate.forward > 0).sort((a, b) => a.score - b.score);
  if (candidates[0]) { event.preventDefault(); candidates[0].element.focus(); }
});
function focusFirstTvControl() { const first = document.querySelector('#tv [data-tv-focus],#tv [data-tv-view]'); if (first && state.view === 'tv') first.focus(); }
setInterval(() => { if (state.view === 'tv') loadTvState(); }, 2000);

async function restoreChat() {
  try {
    const saved = await api(`/api/agent/session/${encodeURIComponent(state.sessionId)}`);
    for (const message of saved.messages || []) addChatMessage(message.role, message.content);
    if (state.conversation.length) $('#chatMemoryStatus').textContent = `Chat restored · ${saved.turns} of ${saved.maxTurns} recent turns kept in memory for up to ${saved.expiresInMinutes} minutes of inactivity.`;
  } catch { /* A missing/expired session simply starts with a welcome message. */ }
  state.historyLoaded = true;
  if (!state.conversation.length) showWelcomeMessage();
}

if (location.hash && document.querySelector(`${location.hash}.view`)) go(location.hash.slice(1));
else loadActivities();
loadAgentStatus();
restoreChat();
