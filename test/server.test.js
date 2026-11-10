'use strict';
/** End-to-end: run the real server and play over Socket.IO with three clients. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 4100 + Math.floor(Math.random() * 500);
const URL = `http://localhost:${PORT}`;
let server;

test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('running') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});
test.after(() => server && server.kill());

function client(name) {
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const c = { name, socket, token: `tok-${name}-${Math.random().toString(36).slice(2)}xxxxxxxx`, state: null, listeners: [] };
  socket.on('state', (s) => {
    c.state = s;
    c.listeners = c.listeners.filter((l) => !l(s));
  });
  return c;
}
const emit = (c, ev, payload) => new Promise((r) => c.socket.emit(ev, payload, r));
function waitFor(c, pred, ms = 4000) {
  if (c.state && pred(c.state)) return Promise.resolve(c.state);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${c.name}: timed out waiting for state`)), ms);
    c.listeners.push((s) => {
      if (!pred(s)) return false;
      clearTimeout(t);
      resolve(s);
      return true;
    });
  });
}

test('create, join, play a full hand, reconnect and kick', async () => {
  const a = client('Ann');
  const b = client('Ben');
  const c = client('Cat');

  const created = await emit(a, 'create', { name: 'Ann', token: a.token });
  assert.ok(created.ok, created.error);
  const code = created.code;
  assert.match(code, /^[A-Z2-9]{4}$/);

  assert.ok((await emit(b, 'join', { code: code.toLowerCase(), name: 'Ben', token: b.token })).ok);
  assert.ok((await emit(c, 'join', { code, name: 'Ann', token: c.token })).ok); // duplicate name
  const lobby = await waitFor(a, (s) => s.seats.filter(Boolean).length === 3);
  assert.deepEqual(lobby.seats.filter(Boolean).map((p) => p.name), ['Ann', 'Ben', 'Ann 2']);

  assert.equal((await emit(b, 'host', { cmd: 'start' })).error, 'Only the host can do that.');
  assert.equal((await emit(a, 'join', { code: 'ZZZZ', name: 'x', token: a.token })).error, 'Table not found. Check the code and try again.');
  // That failed join must not have detached Ann. Re-join to be safe.
  assert.ok((await emit(a, 'join', { code, name: 'Ann', token: a.token })).ok);

  assert.ok((await emit(a, 'host', { cmd: 'start' })).ok);
  const clients = [a, b, c];
  await Promise.all(clients.map((x) => waitFor(x, (s) => s.handInProgress)));

  // Privacy: each player sees exactly their own two cards and nobody else's.
  for (const x of clients) {
    const mine = x.state.seats[x.state.me.seat];
    assert.equal(mine.cards.length, 2);
    for (const p of x.state.seats.filter(Boolean)) if (p.id !== x.state.me.id) assert.equal(p.cards, null);
  }
  const allCards = clients.flatMap((x) => x.state.seats[x.state.me.seat].cards);
  assert.equal(new Set(allCards).size, 6);

  // Out-of-turn action is rejected.
  const notMyTurn = clients.find((x) => !x.state.me.legal);
  assert.ok((await emit(notMyTurn, 'action', { type: 'fold' })).error);

  // Everybody checks/calls down to showdown.
  for (let guard = 0; guard < 40; guard++) {
    const s = a.state;
    if (s.phase === 'handOver') break;
    const turn = clients.find((x) => x.state.me.legal && x.state.actionCount === s.actionCount);
    if (!turn) {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    const before = turn.state.actionCount;
    const res = await emit(turn, 'action', { type: turn.state.me.legal.canCheck ? 'check' : 'call' });
    assert.ok(res.ok, res.error);
    await Promise.all(clients.map((x) => waitFor(x, (st) => st.actionCount > before)));
  }
  const over = await waitFor(a, (s) => s.phase === 'handOver');
  assert.equal(over.board.length, 5);
  assert.equal(over.seats.filter(Boolean).reduce((sum, p) => sum + p.stack, 0), 3000);
  assert.ok(over.result.showdown.length === 3);
  assert.ok(over.room.nextHandInMs > 0);

  // Reconnect: Ben drops and comes back with the same token -> same seat.
  const benSeat = b.state.me.seat;
  b.socket.disconnect();
  await waitFor(a, (s) => s.seats[benSeat] && !s.seats[benSeat].connected);
  const b2 = client('Ben2');
  b2.token = b.token;
  assert.ok((await emit(b2, 'join', { code, name: 'Whatever', token: b2.token })).ok);
  const back = await waitFor(b2, (s) => !!s.me);
  assert.equal(back.me.seat, benSeat);
  assert.equal(back.seats[benSeat].name, 'Ben');

  // Chat: everyone gets the message; a newcomer gets the history; spam is limited.
  const heard = new Promise((r) => b2.socket.once('chat', r));
  assert.ok((await emit(a, 'chat', { text: '  Nice hand!  ' })).ok);
  const msg = await heard;
  assert.equal(msg.text, 'Nice hand!');
  assert.equal(msg.name, 'Ann');
  const d = client('Dee');
  const history = new Promise((r) => d.socket.once('chatHistory', r));
  assert.ok((await emit(d, 'join', { code, name: 'Dee', token: d.token })).ok);
  assert.equal((await history).at(-1).text, 'Nice hand!');
  let limited = null;
  for (let i = 0; i < 10 && !limited; i++) limited = (await emit(d, 'chat', { text: `spam ${i}` })).error;
  assert.ok(limited, 'chat should be rate limited');

  // Table name shows up in the invite link preview.
  assert.ok((await emit(a, 'host', { cmd: 'settings', settings: { ...a.state.settings, tableName: 'Friday <Night>' } })).ok);
  const page = await (await fetch(`${URL}/r/${code}`)).text();
  assert.match(page, /<meta property="og:title" content="Friday &lt;Night&gt; · Poky">/);

  // End the night: no more hands, everyone gets the recap; the host can keep playing.
  assert.ok((await emit(a, 'host', { cmd: 'end' })).ok);
  const ended = await waitFor(b2, (s) => s.room.ended);
  assert.equal(ended.room.recap.hands >= 1, true);
  assert.equal(ended.room.nextHandInMs, null);
  assert.ok((await emit(a, 'host', { cmd: 'continue' })).ok);
  await waitFor(b2, (s) => !s.room.ended);
  d.socket.disconnect();

  // Kick.
  const catId = c.state.me.id;
  const kicked = new Promise((r) => c.socket.once('kicked', r));
  assert.ok((await emit(a, 'host', { cmd: 'kick', playerId: catId })).ok);
  await kicked;
  await waitFor(a, (s) => !s.seats.some((p) => p && p.id === catId));

  for (const x of [a, b2, c]) x.socket.disconnect();
});
