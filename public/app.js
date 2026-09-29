import { BrowserFileReceiver, encodeBrowserChunk, sha256Hex } from './file-receiver.js';

const $ = (id) => document.getElementById(id);
const state = { token: localStorage.getItem('hybrid.token') || '', user: null, devices: [], session: null, ws: null, pc: null, channel: null, role: null, inputEnabled: false, hostAllowsInput: false, pendingCandidates: [], signalQueue: [] };
const fileReceiver = new BrowserFileReceiver();
const log = (message, data) => { const line = `${new Date().toLocaleTimeString()}  ${message}${data ? ` ${JSON.stringify(data)}` : ''}`; $('log').textContent += `${line}\n`; $('log').scrollTop = $('log').scrollHeight; };

async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function renderDevices() {
  const options = state.devices.map((device) => `<option value="${device.id}">${device.name} · ${device.platform} · ${device.online ? 'online' : 'offline'}</option>`).join('');
  $('device-list').innerHTML = options || '<option value="">No devices</option>';
  $('source-device').innerHTML = options;
  $('device-options').innerHTML = state.devices.map((device) => `<option value="${device.id}">${device.name}</option>`).join('');
  if (state.devices.length > 1 && !$('target-device').value) $('target-device').value = state.devices[1].id;
}

async function refresh() {
  if (!state.token) { $('identity').textContent = 'No token yet.'; return; }
  const me = await api('/api/v1/me'); state.user = me.user; $('identity').textContent = `${state.user.email} · ${state.user.id}`;
  const devices = await api('/api/v1/devices'); state.devices = devices.devices; renderDevices();
}

$('enroll-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/v1/auth/enroll', { method: 'POST', body: { email: $('email').value, name: $('name').value } });
    state.token = result.token; localStorage.setItem('hybrid.token', state.token); await refresh(); log('token issued');
  } catch (error) { log(`enrollment failed: ${error.message}`); }
});

$('device-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await api('/api/v1/devices', { method: 'POST', body: { name: $('device-name').value, platform: $('platform').value } }); await refresh(); log('device enrolled'); }
  catch (error) { log(`device enrollment failed: ${error.message}`); }
});

$('session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await api('/api/v1/sessions', { method: 'POST', body: { sourceDeviceId: $('source-device').value, targetDeviceId: $('target-device').value } });
    state.session = result.session; $('session-id').value = state.session.id; $('connect').disabled = false; log('session created', state.session);
  } catch (error) { log(`session creation failed: ${error.message}`); }
});

$('use-session').addEventListener('click', () => {
  const id = $('session-id').value.trim();
  if (!id.startsWith('ses_')) { log('enter a valid session ID'); return; }
  state.session = { id }; $('connect').disabled = false; log('session selected', { id });
});

$('connect').addEventListener('click', async () => {
  try {
    const selectedDevice = $('source-device').value;
    const ticket = await api('/api/v1/signal-tickets', { method: 'POST', body: { sessionId: state.session.id, deviceId: selectedDevice } });
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    state.ws = new WebSocket(`${scheme}://${location.host}/signal?ticket=${encodeURIComponent(ticket.ticket)}`);
    state.ws.onopen = async () => { log('signaling socket open'); await setupPeer(); for (const queued of state.signalQueue.splice(0)) await receiveSignal(queued); };
    state.ws.onmessage = async (event) => { const message = JSON.parse(event.data); log(`signal ${message.type}`, message.type === 'ice' ? undefined : message); if (!state.pc) state.signalQueue.push(message); else await receiveSignal(message); };
    state.ws.onclose = () => log('signaling socket closed');
    state.ws.onerror = () => log('signaling socket error');
  } catch (error) { log(`connect failed: ${error.message}`); }
});

async function setupPeer() {
  const config = await api('/api/v1/config');
  state.pc = new RTCPeerConnection({ iceServers: config.iceServers });
  state.pc.onicecandidate = ({ candidate }) => { if (candidate && state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'ice', candidate })); };
  state.pc.ontrack = ({ streams: [stream] }) => { $('remote-video').srcObject = stream; };
  state.pc.ondatachannel = ({ channel }) => bindChannel(channel);
}

function bindChannel(channel) {
  state.channel = channel;
  channel.binaryType = 'arraybuffer';
  channel.onmessage = (event) => receiveData(event.data).catch((error) => log(`data receive failed: ${error.message}`));
  channel.onopen = () => { $('send-ping').disabled = false; $('send-file').disabled = false; $('request-host-screen').disabled = false; $('enable-input').disabled = false; log('data channel open'); };
  channel.onclose = () => { disableInput('Data channel closed.'); };
}

async function receiveData(data) {
  const result = await fileReceiver.consume(data);
  if (result.status === 'started') { log(`receiving file: ${result.name} (${result.size} bytes)`); return; }
  if (result.status === 'complete') {
      const link = document.createElement('a'); link.href = URL.createObjectURL(result.blob); link.download = result.name; link.textContent = `Download ${result.name} (${result.size} bytes)`;
      link.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(link.href), 30_000), { once: true });
      $('downloads').append(link); log(`file verified: ${result.name}`); return;
  }
  if (result.status === 'message') {
    const message = result.value;
    if (message?.type === 'host-ready') {
      state.hostAllowsInput = Boolean(message.input);
      $('input-status').textContent = message.input ? 'Host allows input; click Enable remote input.' : 'Host policy denies remote input.';
    } else if (message?.type === 'input-capability') {
      state.hostAllowsInput = Boolean(message.enabled);
      if (message.enabled) enableInput(); else disableInput('Host policy denies remote input.');
    } else if (message?.type === 'error') {
      log(`host rejected command: ${message.message || message.code}`);
    } else log(`data: ${result.text || JSON.stringify(message)}`);
  }
}

async function receiveSignal(message) {
  if (!state.pc) return;
  if (message.type === 'welcome') {
    state.role = message.role;
    if (state.role === 'source') {
      if (!state.pc.getTransceivers().some((transceiver) => transceiver.receiver.track?.kind === 'video')) state.pc.addTransceiver('video', { direction: 'recvonly' });
      if (!state.channel) bindChannel(state.pc.createDataChannel('control', { ordered: true }));
      if (message.peers?.length) await makeOffer();
    }
  }
  if (message.type === 'peer-ready' && state.role === 'source') await makeOffer();
  if (message.type === 'offer') { await state.pc.setRemoteDescription(message.sdp); await flushCandidates(); const answer = await state.pc.createAnswer(); await state.pc.setLocalDescription(answer); state.ws.send(JSON.stringify({ type: 'answer', sdp: state.pc.localDescription })); }
  if (message.type === 'answer') { await state.pc.setRemoteDescription(message.sdp); await flushCandidates(); }
  if (message.type === 'ice' && message.candidate) {
    if (state.pc.remoteDescription) await state.pc.addIceCandidate(message.candidate); else state.pendingCandidates.push(message.candidate);
  }
}

async function flushCandidates() { for (const candidate of state.pendingCandidates.splice(0)) await state.pc.addIceCandidate(candidate); }
async function makeOffer() { const offer = await state.pc.createOffer(); await state.pc.setLocalDescription(offer); state.ws.send(JSON.stringify({ type: 'offer', sdp: state.pc.localDescription })); }

$('share-screen').addEventListener('click', async () => {
  try {
    if (!state.pc) throw new Error('Connect signaling first');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    for (const track of stream.getTracks()) state.pc.addTrack(track, stream);
    const offer = await state.pc.createOffer(); await state.pc.setLocalDescription(offer); state.ws.send(JSON.stringify({ type: 'offer', sdp: state.pc.localDescription })); log('screen offer sent');
  } catch (error) { log(`screen share failed: ${error.message}`); }
});
$('send-ping').addEventListener('click', () => sendControl({ type: 'ping', sentAt: Date.now() }));
$('request-host-screen').addEventListener('click', () => sendControl({ type: 'host-screen-start' }));
$('enable-input').addEventListener('click', () => {
  if (state.inputEnabled) { disableInput('Remote input is off.'); return; }
  if (!window.confirm('Enable remote keyboard and mouse control for this session? The host must also opt in locally.')) return;
  sendControl({ type: 'input-capability-request' });
});
$('send-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async () => {
  const file = $('file-input').files[0]; if (!file || state.channel?.readyState !== 'open') return;
  if (file.size > 8 * 1024 * 1024) { log('browser demo limits files to 8 MiB'); return; }
  const buffer = await file.arrayBuffer(); const bytes = new Uint8Array(buffer); const digest = await sha256Hex(buffer);
  state.channel.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size, mime: file.type, sha256: digest }));
  for (let offset = 0; offset < bytes.length; offset += 16 * 1024) { while (state.channel.bufferedAmount > 1024 * 1024) await new Promise((resolve) => setTimeout(resolve, 20)); state.channel.send(encodeBrowserChunk(offset, bytes.slice(offset, offset + 16 * 1024))); }
  state.channel.send(JSON.stringify({ type: 'file-complete', name: file.name })); log(`file sent: ${file.name} (${file.size} bytes)`);
});

function sendControl(message) {
  if (state.channel?.readyState !== 'open') { log('data channel is not open'); return false; }
  state.channel.send(JSON.stringify(message)); return true;
}

function enableInput() {
  if (!state.hostAllowsInput) { disableInput('Host policy denies remote input.'); return; }
  state.inputEnabled = true; $('remote-video').classList.add('input-enabled'); $('remote-video').focus();
  $('enable-input').textContent = 'Disable remote input'; $('input-status').textContent = 'Remote input enabled. Press Escape to disable locally.';
}

function disableInput(reason) {
  state.inputEnabled = false; $('remote-video').classList.remove('input-enabled'); $('enable-input').textContent = 'Enable remote input'; $('input-status').textContent = reason;
}

let lastMoveAt = 0;
$('remote-video').addEventListener('pointermove', (event) => {
  if (!state.inputEnabled || performance.now() - lastMoveAt < 16) return;
  lastMoveAt = performance.now(); const rect = event.currentTarget.getBoundingClientRect();
  sendControl({ type: 'input', event: { kind: 'mouse-move', x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) } });
});
for (const type of ['pointerdown', 'pointerup']) $('remote-video').addEventListener(type, (event) => {
  if (!state.inputEnabled) return; event.preventDefault(); $('remote-video').setPointerCapture?.(event.pointerId);
  const button = ['left', 'middle', 'right'][event.button]; if (button) sendControl({ type: 'input', event: { kind: 'mouse-button', button, pressed: type === 'pointerdown' } });
});
$('remote-video').addEventListener('contextmenu', (event) => { if (state.inputEnabled) event.preventDefault(); });
const KEY_MAP = { Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace', Delete: 'delete', ' ': 'space', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Shift: 'shift', Control: 'ctrl', Alt: 'alt' };
for (const type of ['keydown', 'keyup']) $('remote-video').addEventListener(type, (event) => {
  if (!state.inputEnabled) return;
  if (event.key === 'Escape' && type === 'keydown') { disableInput('Remote input disabled locally.'); event.preventDefault(); return; }
  const key = KEY_MAP[event.key] || (/^[a-z0-9]$/i.test(event.key) ? event.key.toLowerCase() : '');
  if (key && !event.repeat) { sendControl({ type: 'input', event: { kind: 'key', key, pressed: type === 'keydown' } }); event.preventDefault(); }
});

refresh().catch((error) => log(`refresh failed: ${error.message}`));
