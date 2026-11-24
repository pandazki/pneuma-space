const $ = id => document.getElementById(id);
async function api(path, body) {
  const response = await fetch('api/' + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || result.error || '请求失败');
  return result;
}
async function refresh() {
  const state = await api('state');
  $('identity').textContent = state.user + '，欢迎回来。';
  $('visits').textContent = '已打开 ' + state.visits + ' 次。';
  $('jobs').textContent = state.deliveries.length ? '最近一次自动记录：' + new Date(state.deliveries[0].at).toLocaleString() : '每天自动记录一次。';
  if (document.activeElement !== $('document')) $('document').value = state.document;
  $('notes').replaceChildren(...state.notes.map(note => {
    const article = document.createElement('article'), time = document.createElement('small'), p = document.createElement('p');
    time.textContent = new Date(note.created_at).toLocaleString(); p.textContent = note.body; article.append(time, p); return article;
  }));
  $('objects').replaceChildren(...state.objects.map(object => {
    const link = document.createElement('a'); link.href = '#'; link.textContent = object.key + ' · ' + object.bytes + ' bytes';
    link.onclick = async event => { event.preventDefault(); try { const result = await api('download', { key: object.key }); location.assign(result.url); } catch (error) { $('notice').textContent = error.message; } };
    return link;
  }));
}
function form(id, work) {
  $(id).onsubmit = async event => {
    event.preventDefault(); const button = $(id).querySelector('button'); button.disabled = true; $('notice').textContent = '';
    try { await work(); await refresh(); } catch (error) { $('notice').textContent = error.message; } finally { button.disabled = false; }
  };
}
form('note-form', async () => { await api('notes', { body: $('note').value }); $('note').value = ''; });
form('document-form', () => api('document', { body: $('document').value }));
form('upload-form', async () => {
  const file = $('attachment').files[0];
  const ticket = await api('upload', { key: file.name, bytes: file.size, contentType: file.type || 'application/octet-stream' });
  const response = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: file, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('附件上传失败：' + response.status);
  await api('complete', { id: ticket.id }); $('attachment').value = '';
});
const socket = new WebSocket(new URL('_pneuma-space/realtime/notes', location.href.replace(/^http/, 'ws')));
socket.onopen = () => { $('live').textContent = '实时同步已连接'; };
socket.onclose = () => { $('live').textContent = '实时同步已断开，刷新可重连'; };
socket.onmessage = () => refresh().catch(error => { $('notice').textContent = error.message; });
$('relay').onclick = async () => {
  $('relay').disabled = true; $('relay-result').textContent = '正在建立中继连接…';
  let a, b, timer;
  try {
    const config = await api('rtc', {});
    a = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: 'relay' });
    b = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: 'relay' });
    const pendingA = [], pendingB = [];
    a.onicecandidate = event => { if (event.candidate) { if (b.remoteDescription) b.addIceCandidate(event.candidate).catch(() => {}); else pendingB.push(event.candidate); } };
    b.onicecandidate = event => { if (event.candidate) { if (a.remoteDescription) a.addIceCandidate(event.candidate).catch(() => {}); else pendingA.push(event.candidate); } };
    const channel = a.createDataChannel('check');
    b.ondatachannel = event => { event.channel.onmessage = message => event.channel.send(message.data); };
    const connected = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('连接超时')), 20000);
      channel.onopen = () => channel.send('pneuma-space-relay');
      channel.onmessage = event => event.data === 'pneuma-space-relay' ? resolve() : reject(new Error('响应不匹配'));
      channel.onerror = () => reject(new Error('连接失败'));
    });
    await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
    for (const candidate of pendingB) await b.addIceCandidate(candidate);
    await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
    for (const candidate of pendingA) await a.addIceCandidate(candidate);
    await connected; $('relay-result').textContent = '中继连接成功，消息已往返。';
  } catch (error) { $('relay-result').textContent = error.message; }
  finally { clearTimeout(timer); a?.close(); b?.close(); $('relay').disabled = false; }
};
refresh().catch(error => { $('notice').textContent = error.message; });
