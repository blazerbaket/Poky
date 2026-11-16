'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
// Local secrets (DATABASE_URL) live in .env, which is never committed. On Render they're set in the dashboard.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* no .env file: fine */
}

const { Room } = require('./src/room');
const { GameError, playerStats } = require('./src/game');
const { createStore, TakenError } = require('./src/store');
const auth = require('./src/auth');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ROOMS = 1000;
const IDLE_ROOM_MS = 30 * 60 * 1000; // remove empty rooms after 30 minutes

const store = createStore();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render/Railway sit behind a proxy; needed for secure cookies and client IPs
app.use(express.static(PUBLIC_DIR));
app.get('/healthz', (_req, res) => res.send('ok'));

// ------------------------------------------------------------------ accounts API
const api = express.Router();
api.use(express.json({ limit: '10kb' }));
const authLimit = auth.rateLimiter(20, 15 * 60 * 1000); // per IP: 20 login/sign-up tries per 15 min

/** Wrap an async route: GameErrors become a 400 with the message; anything else a 500. */
const route = (fn) => async (req, res) => {
  try {
    res.json((await fn(req, res)) || { ok: true });
  } catch (err) {
    if (err instanceof GameError) return res.status(400).json({ error: err.message });
    console.error(`[${req.method} ${req.path}]`, err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

function setSessionCookie(req, res, token) {
  res.cookie(auth.SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: auth.SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

async function startSession(req, res, user) {
  const token = auth.newSessionToken();
  await store.createSession(auth.hashToken(token), user.id, new Date(Date.now() + auth.SESSION_DAYS * 86_400_000));
  setSessionCookie(req, res, token);
  return { user: { id: user.id, username: user.username } };
}

function limit(req) {
  if (!authLimit(req.ip)) throw new GameError('Too many tries. Please wait a few minutes.');
}

api.post('/signup', route(async (req, res) => {
  limit(req);
  const username = auth.cleanUsername(req.body?.username);
  const password = auth.checkPassword(req.body?.password);
  let user;
  try {
    user = await store.createUser(username, auth.usernameKey(username), await auth.hashPassword(password));
  } catch (err) {
    if (err instanceof TakenError) throw new GameError('That username is taken. Try another one.');
    throw err;
  }
  return startSession(req, res, user);
}));

api.post('/login', route(async (req, res) => {
  limit(req);
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const user = username && username.length <= 16 ? await store.findUserByKey(auth.usernameKey(username)) : null;
  const ok = user ? await auth.verifyPassword(password, user.passwordHash) : await auth.dummyVerify(password);
  if (!ok) throw new GameError('Wrong username or password.');
  return startSession(req, res, user);
}));

api.post('/logout', route(async (req, res) => {
  const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
  if (token) await store.deleteSession(auth.hashToken(token));
  res.clearCookie(auth.SESSION_COOKIE, { path: '/' });
}));

api.get('/me', route(async (req) => ({ user: await auth.userFromCookie(store, req.headers.cookie) })));

/** Raw totals -> what the pages show (percentages plus a few totals). */
const totalsView = (t) => ({ ...playerStats(t), games: t.games, net: t.net, biggestWin: t.biggestWin });

async function profile(user) {
  const { lifetime, games } = await store.userStats(user.id);
  return {
    user: { username: user.username },
    lifetime: totalsView(lifetime),
    games: games.map((g) => ({
      tableName: g.tableName, roomCode: g.roomCode, startedAt: g.startedAt, lastHandAt: g.lastHandAt,
      net: g.net, biggestWin: g.biggestWin, ...playerStats(g),
    })),
  };
}

// Your own stats: lifetime totals plus your recent games.
api.get('/stats', route(async (req) => {
  const user = await auth.userFromCookie(store, req.headers.cookie);
  if (!user) throw new GameError('Log in to see your stats.');
  return profile(user);
}));

// Everyone's stats are public (to anyone with the site): look someone up by username.
api.get('/players/:username', route(async (req, res) => {
  const name = String(req.params.username || '').slice(0, 32);
  const user = await store.findUserByKey(auth.usernameKey(name));
  if (!user) {
    res.status(404);
    return { error: 'No player with that username.' };
  }
  return profile(user);
}));

// Search by (part of a) username.
api.get('/players', route(async (req) => {
  const q = String(req.query.q || '').trim().slice(0, 16);
  if (!q) return { players: [] };
  return { players: await store.searchUsers(q, 10) };
}));

// Leaderboard. Percentage rankings only include players with enough hands to mean something.
const BOARD_SORTS = {
  net: (p) => p.net,
  hands: (p) => p.hands,
  won: (p) => p.won ?? -1,
  showdown: (p) => p.showdown ?? -1,
  vpip: (p) => p.vpip ?? -1,
  pfr: (p) => p.pfr ?? -1,
  biggestWin: (p) => p.biggestWin,
};
const PCT_SORTS = new Set(['won', 'showdown', 'vpip', 'pfr']);
const BOARD_MIN_HANDS = 20;
api.get('/leaderboard', route(async (req) => {
  const sort = BOARD_SORTS[req.query.sort] ? req.query.sort : 'net';
  let players = (await store.allTotals()).map((t) => ({ username: t.username, ...totalsView(t) }));
  if (PCT_SORTS.has(sort)) players = players.filter((p) => p.hands >= BOARD_MIN_HANDS && (sort !== 'showdown' || p.showdowns > 0));
  players.sort((a, b) => BOARD_SORTS[sort](b) - BOARD_SORTS[sort](a) || b.hands - a.hands);
  return { sort, minHands: PCT_SORTS.has(sort) ? BOARD_MIN_HANDS : 0, players: players.slice(0, 50) };
}));

app.use('/api', api);
const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Invite links get a title and description so chat apps show a nice preview ("Friday Night at Aryan's").
app.get('/r/:code', (req, res, next) => {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
    if (err) return next(err);
    const room = rooms.get(cleanCode(req.params.code));
    const name = room ? room.game.settings.tableName : '';
    const title = name ? `${name} · Poky` : 'Join my Poky poker table';
    const desc = name
      ? `You’re invited to ${name}. Texas Hold’em with friends, no sign-up needed.`
      : 'You’re invited to a poker night. Texas Hold’em with friends, no sign-up needed.';
    const tags = [
      `<title>${escHtml(title)}</title>`,
      `<meta property="og:title" content="${escHtml(title)}">`,
      `<meta property="og:description" content="${escHtml(desc)}">`,
      '<meta property="og:type" content="website">',
      '<meta name="twitter:card" content="summary">',
    ].join('\n  ');
    res.set('Cache-Control', 'no-store').type('html').send(html.replace(/<title>[^<]*<\/title>/, () => tags));
  });
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 10_000 });

// Who is this socket? Read the session cookie once when it connects (null = guest).
// After logging in or out, the page reconnects its socket so this runs again.
io.use(async (socket, next) => {
  socket.data.user = await auth.userFromCookie(store, socket.request.headers.cookie);
  next();
});

/** @type {Map<string, Room>} */
const rooms = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to avoid confusion
function newRoomCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function cleanName(v) {
  const name = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  if (!name) throw new GameError('Please enter a nickname.');
  return name;
}

function cleanToken(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) {
    throw new GameError('Your session is invalid. Please refresh the page.');
  }
  return v;
}

const cleanCode = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

io.on('connection', (socket) => {
  /** Wrap a handler: validates payload shape and reports errors back to the client. */
  const on = (event, fn) =>
    socket.on(event, (payload, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      try {
        const result = fn(payload && typeof payload === 'object' ? payload : {});
        reply({ ok: true, ...(result || {}) });
      } catch (err) {
        if (!(err instanceof GameError)) console.error(`[${event}]`, err);
        reply({ error: err instanceof GameError ? err.message : 'Something went wrong. Please try again.' });
      }
    });

  /** Anyone in the room: a seated player or a spectator. */
  const member = () => {
    const room = rooms.get(socket.data.roomCode);
    const pid = socket.data.playerId;
    if (!room || !pid || !room.member(pid)) throw new GameError('You are not at a table.');
    return { room, pid };
  };
  /** Someone with a seat (for playing actions). */
  const current = () => {
    const { room, pid } = member();
    if (!room.game.players.has(pid)) throw new GameError('You’re watching. Ask for a seat to play.');
    return { room, pid };
  };

  const detachCurrent = () => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.playerId) room.detach(socket, socket.data.playerId);
    socket.data.roomCode = null;
    socket.data.playerId = null;
  };

  const enter = (room, token, name, wantSeat) => {
    detachCurrent();
    const { id, notice } = room.join(socket, token, name, wantSeat, socket.data.user);
    socket.data.roomCode = room.code;
    socket.data.playerId = id;
    return { code: room.code, playerId: id, notice };
  };

  on('create', ({ name, token }) => {
    const user = socket.data.user;
    const n = user ? user.username : cleanName(name);
    const t = cleanToken(token);
    if (rooms.size >= MAX_ROOMS) throw new GameError('The server is busy. Please try again later.');
    const room = new Room(newRoomCode(), { store });
    rooms.set(room.code, room);
    return enter(room, t, n);
  });

  // New people arrive as spectators; `watch: true` means "just watch", otherwise they also ask for a seat.
  on('join', ({ code, name, token, watch }) => {
    const t = cleanToken(token);
    const room = rooms.get(cleanCode(code));
    if (!room) throw new GameError('Table not found. Check the code and try again.');
    // Returning players and spectators (same token) keep their seat (or spot) and name.
    // Logged-in people play under their username, so they don't need a nickname.
    const n = room.tokens.has(t) || socket.data.user ? null : cleanName(name);
    return enter(room, t, n, !watch);
  });

  on('requestSeat', () => {
    const { room, pid } = member();
    room.requestSeat(pid);
  });

  on('cancelRequest', () => {
    const { room, pid } = member();
    room.cancelRequest(pid);
  });

  on('standUp', () => {
    const { room, pid } = current();
    room.standUp(pid);
  });

  on('action', ({ type, amount }) => {
    const { room, pid } = current();
    if (!['fold', 'check', 'call', 'raise', 'allin'].includes(type)) throw new GameError('Unknown action.');
    room.action(pid, type, amount);
  });

  on('host', ({ cmd, settings, playerId }) => {
    const { room, pid } = member(); // the host may be watching rather than playing
    switch (cmd) {
      case 'approve': return room.approve(pid, String(playerId));
      case 'deny': return room.deny(pid, String(playerId));
      case 'start': return room.start(pid);
      case 'pause': return room.setPaused(pid, true);
      case 'resume': return room.setPaused(pid, false);
      case 'settings': return room.updateSettings(pid, settings);
      case 'kick': return room.kick(pid, String(playerId));
      case 'end': return room.endNight(pid);
      case 'continue': return room.continueNight(pid);
      default: throw new GameError('Unknown command.');
    }
  });

  on('playerInfo', ({ playerId }) => {
    const { room } = member();
    return { info: room.playerInfo(String(playerId)) };
  });

  on('rebuy', () => {
    const { room, pid } = current();
    room.rebuy(pid);
  });

  on('sitout', ({ value }) => {
    const { room, pid } = current();
    room.setSittingOut(pid, Boolean(value));
  });

  on('chat', ({ text }) => {
    const { room, pid } = member(); // spectators can chat too
    room.say(pid, text);
  });

  on('show', () => {
    const { room, pid } = current();
    room.showCards(pid);
  });

  // Tonight's stats so far (anyone at the table can look).
  on('recap', () => {
    const { room } = member();
    return { recap: room.game.buildRecap() };
  });

  on('leave', () => {
    const { room, pid } = member();
    room.leave(pid);
  });

  socket.on('disconnect', detachCurrent);
});

// Clean up abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const empty = room.game.players.size === 0 && room.spectators.size === 0;
    const abandoned = room.connectedCount === 0 && now - room.lastActivity > IDLE_ROOM_MS;
    if (empty || abandoned) {
      room.destroy();
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

store
  .init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Poky is running at http://localhost:${PORT} (accounts: ${store.kind === 'postgres' ? 'Postgres' : 'in memory, not saved'})`);
    });
  })
  .catch((err) => {
    console.error('Could not set up the database:', err.message);
    process.exit(1);
  });
