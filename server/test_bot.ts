// Two-tab smoke test bot. Connects to ws://localhost:8082/ws,
// joins a lobby (the server auto-assigns one if none specified),
// logs every JSON message, ignores binary frames.
const url = process.env.WS_URL ?? 'ws://localhost:8082/ws';
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

ws.addEventListener('open', () => {
  console.log('[bot] connected to', url);
  ws.send(JSON.stringify({ type: 'join', name: 'BotPlayer', uuid: 'bot-' + Math.random().toString(36).slice(2, 10) }));
});

let binCount = 0;
ws.addEventListener('message', (ev: MessageEvent) => {
  if (typeof ev.data === 'string') {
    try {
      const obj = JSON.parse(ev.data);
      console.log('[bot recv]', obj.type, JSON.stringify(obj).slice(0, 200));
    } catch { console.log('[bot recv text]', String(ev.data).slice(0, 200)); }
  } else {
    binCount++;
    if (binCount % 30 === 1) console.log('[bot recv bin]', (ev.data as ArrayBuffer).byteLength, 'bytes (frame', binCount, ')');
  }
});

ws.addEventListener('close', (ev: CloseEvent) => {
  console.log('[bot] closed', ev.code, ev.reason);
  process.exit(0);
});
ws.addEventListener('error', (err) => {
  console.log('[bot] error', err);
});

// Stay alive
setInterval(() => {}, 1000);
