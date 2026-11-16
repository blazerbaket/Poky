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
    // Empty DATABASE_URL: the in-memory store, never the real database from .env.
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: '' },
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
  // Newcomers wait for the host to let them in.
  const asking = await waitFor(a, (s) => s.room.spectators.filter((x) => x.requested).length === 2);
  assert.equal(asking.seats.filter(Boolean).length, 1);
  assert.equal(b.state.viewer.spectator, true);
  assert.equal((await emit(b, 'host', { cmd: 'approve', playerId: c.state.viewer.id })).error, 'Only the host can do that.');
  for (const x of asking.room.spectators) assert.ok((await emit(a, 'host', { cmd: 'approve', playerId: x.id })).ok);
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

test('spectators: watch, ask, deny, approve, stand up and sit back down', async () => {
  const host = client('Hal');
  const created = await emit(host, 'create', { name: 'Hal', token: host.token });
  const code = created.code;
  const pal = client('Pia');
  assert.ok((await emit(pal, 'join', { code, name: 'Pia', token: pal.token })).ok);
  await waitFor(host, (s) => s.room.spectators.some((x) => x.requested));
  assert.ok((await emit(host, 'host', { cmd: 'approve', playerId: pal.state.viewer.id })).ok);
  await waitFor(pal, (s) => !!s.me);

  // Just watching: no seat, no request, and no playing.
  const w = client('Wes');
  assert.ok((await emit(w, 'join', { code, name: 'Wes', token: w.token, watch: true })).ok);
  let st = await waitFor(host, (s) => s.room.spectators.some((x) => x.name === 'Wes'));
  assert.equal(st.room.spectators.find((x) => x.name === 'Wes').requested, false);
  assert.equal((await emit(w, 'action', { type: 'fold' })).error, 'You’re watching. Ask for a seat to play.');

  // Spectators can chat (and are marked as such).
  const heard = new Promise((r) => host.socket.once('chat', r));
  assert.ok((await emit(w, 'chat', { text: 'gl all' })).ok);
  assert.equal((await heard).spectator, true);

  // During a hand a spectator sees no hole cards at all.
  assert.ok((await emit(host, 'host', { cmd: 'start' })).ok);
  st = await waitFor(w, (s) => s.handInProgress);
  assert.equal(st.me, null);
  for (const p of st.seats.filter(Boolean)) assert.equal(p.cards, null);

  // Ask -> host says no -> can't ask again straight away.
  const denied = new Promise((r) => w.socket.once('denied', r));
  assert.ok((await emit(w, 'requestSeat', {})).ok);
  await waitFor(host, (s) => s.room.spectators.some((x) => x.requested));
  assert.ok((await emit(host, 'host', { cmd: 'deny', playerId: w.state.viewer.id })).ok);
  await denied;
  assert.match((await emit(w, 'requestSeat', {})).error, /not yet/);

  // Turning approval off seats people straight away.
  assert.ok((await emit(host, 'host', { cmd: 'settings', settings: { ...host.state.settings, requireApproval: false } })).ok);
  assert.ok((await emit(w, 'requestSeat', {})).ok);
  st = await waitFor(w, (s) => !!s.me);
  assert.equal(st.viewer.spectator, false);

  // Standing up keeps your chips; an approved player sits back down without asking.
  assert.ok((await emit(host, 'host', { cmd: 'settings', settings: { ...host.state.settings, requireApproval: true } })).ok);
  await waitFor(pal, (s) => s.settings.requireApproval === true);
  const palId = pal.state.me.id;
  assert.ok((await emit(pal, 'standUp', {})).ok);
  st = await waitFor(pal, (s) => s.viewer.spectator);
  assert.equal(st.viewer.approved, true);
  assert.ok((await emit(pal, 'requestSeat', {})).ok);
  st = await waitFor(pal, (s) => !!s.me);
  const stack = st.seats[st.me.seat].stack;
  assert.equal(st.me.id, palId);
  assert.ok(stack > 0 && stack <= 1000, `kept stack ${stack}`);

  // The host can remove a spectator.
  const w2 = client('Viv');
  assert.ok((await emit(w2, 'join', { code, name: 'Viv', token: w2.token, watch: true })).ok);
  const vivId = (await waitFor(w2, (s) => !!s.viewer)).viewer.id;
  const kicked = new Promise((r) => w2.socket.once('kicked', r));
  assert.ok((await emit(host, 'host', { cmd: 'kick', playerId: vivId })).ok);
  await kicked;
  await waitFor(host, (s) => !s.room.spectators.some((x) => x.id === vivId));

  for (const x of [host, pal, w, w2]) x.socket.disconnect();
});

test('accounts: sign up, log in, play while logged in and see your stats', async () => {
  const post = (path, body, cookie) =>
    fetch(`${URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const name = `tester${Math.floor(Math.random() * 1e6)}`;

  // Validation and sign-up.
  assert.equal((await post('/api/signup', { username: 'x', password: 'secret123' })).status, 400);
  assert.equal((await post('/api/signup', { username: name, password: '123' })).status, 400);
  const res = await post('/api/signup', { username: name, password: 'secret123' });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
  assert.equal((await post('/api/signup', { username: name.toUpperCase(), password: 'other123' })).status, 400); // taken, any case

  // Log in: wrong password fails, right one works.
  assert.equal((await post('/api/login', { username: name, password: 'nope-nope' })).status, 400);
  const login = await post('/api/login', { username: name.toUpperCase(), password: 'secret123' });
  assert.equal(login.status, 200);
  const me = await (await fetch(`${URL}/api/me`, { headers: { cookie } })).json();
  assert.equal(me.user.username, name);

  // Play two hands: the logged-in host and a guest.
  const socket = io(URL, { transports: ['websocket'], forceNew: true, extraHeaders: { cookie } });
  const a = { name: 'acct', socket, token: `tok-acct-${Math.random().toString(36).slice(2)}xxxxxxxx`, state: null, listeners: [] };
  socket.on('state', (s) => {
    a.state = s;
    a.listeners = a.listeners.filter((l) => !l(s));
  });
  const g = client('Guest');
  const created = await emit(a, 'create', { name: 'ignored', token: a.token });
  assert.ok(created.ok, created.error);
  const lobby = await waitFor(a, (s) => !!s.me);
  assert.equal(lobby.seats[lobby.me.seat].name, name); // plays under the username
  assert.deepEqual(lobby.room.verified, [lobby.me.id]);
  assert.ok((await emit(g, 'join', { code: created.code, name: 'Guest', token: g.token })).ok);
  await waitFor(a, (s) => s.room.spectators.some((x) => x.requested));
  assert.ok((await emit(a, 'host', { cmd: 'approve', playerId: g.state.viewer.id })).ok);
  assert.ok((await emit(a, 'host', { cmd: 'start' })).ok);

  for (let hand = 1; hand <= 2; hand++) {
    await waitFor(a, (s) => s.handNumber === hand && s.handInProgress, 10000);
    // Whoever is first to act folds: one quick hand.
    const first = [a, g].find((x) => x.state.me && x.state.me.legal && x.state.handNumber === hand)
      || (await new Promise((r) => setTimeout(r, 100)), [a, g].find((x) => x.state.me && x.state.me.legal));
    assert.ok((await emit(first, 'action', { type: 'fold' })).ok);
    await waitFor(a, (s) => s.handNumber === hand && s.phase === 'handOver');
  }
  await new Promise((r) => setTimeout(r, 200)); // saving happens just after the hand

  const stats = await (await fetch(`${URL}/api/stats`, { headers: { cookie } })).json();
  assert.equal(stats.lifetime.hands, 2);
  assert.equal(stats.lifetime.games, 1);
  assert.equal(stats.lifetime.vpip, 0); // folded or checked the blind: never put money in by choice
  assert.equal(stats.lifetime.won, 50); // heads-up, one fold each way
  assert.equal(stats.games.length, 1);
  assert.equal(stats.games[0].hands, 2);
  // Folded the small blind once (−10), and won the other player's small blind once (+10).
  assert.equal(stats.lifetime.net, 0);

  // Anyone can look a player up, search for them, and see the leaderboard.
  const pub = await (await fetch(`${URL}/api/players/${name.toUpperCase()}`)).json();
  assert.equal(pub.user.username, name);
  assert.equal(pub.lifetime.hands, 2);
  assert.equal((await fetch(`${URL}/api/players/nobody-here`)).status, 404);
  const found = await (await fetch(`${URL}/api/players?q=${name.slice(0, 7)}`)).json();
  assert.ok(found.players.some((p) => p.username === name && p.hands === 2));
  const board = await (await fetch(`${URL}/api/leaderboard?sort=hands`)).json();
  assert.equal(board.sort, 'hands');
  assert.ok(board.players.some((p) => p.username === name));
  const pctBoard = await (await fetch(`${URL}/api/leaderboard?sort=won`)).json();
  assert.equal(pctBoard.minHands, 20);
  assert.ok(!pctBoard.players.some((p) => p.username === name)); // only 2 hands: not ranked by %

  // Tapping a seat: tonight's stats plus the account name.
  const card = await emit(g, 'playerInfo', { playerId: lobby.me.id });
  assert.equal(card.info.username, name);
  assert.equal(card.info.tonight.hands, 2);

  // Guests can't see account stats; logging out ends the session.
  assert.equal((await fetch(`${URL}/api/stats`)).status, 400);
  assert.equal((await post('/api/logout', {}, cookie)).status, 200);
  assert.equal((await (await fetch(`${URL}/api/me`, { headers: { cookie } })).json()).user, null);

  socket.disconnect();
  g.socket.disconnect();
});
