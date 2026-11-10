'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./src/room');
const { GameError } = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ROOMS = 1000;
const IDLE_ROOM_MS = 30 * 60 * 1000; // remove empty rooms after 30 minutes

const app = express();
app.disable('x-powered-by');
app.use(express.static(PUBLIC_DIR));
app.get('/healthz', (_req, res) => res.send('ok'));
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

  const current = () => {
    const room = rooms.get(socket.data.roomCode);
    const pid = socket.data.playerId;
    if (!room || !pid || !room.game.players.has(pid)) throw new GameError('You are not at a table.');
    return { room, pid };
  };

  const detachCurrent = () => {
    const room = rooms.get(socket.data.roomCode);
    if (room && socket.data.playerId) room.detach(socket, socket.data.playerId);
    socket.data.roomCode = null;
    socket.data.playerId = null;
  };

  const enter = (room, token, name) => {
    detachCurrent();
    const player = room.join(socket, token, name);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    return { code: room.code, playerId: player.id };
  };

  on('create', ({ name, token }) => {
    const n = cleanName(name);
    const t = cleanToken(token);
    if (rooms.size >= MAX_ROOMS) throw new GameError('The server is busy. Please try again later.');
    const room = new Room(newRoomCode());
    rooms.set(room.code, room);
    return enter(room, t, n);
  });

  on('join', ({ code, name, token }) => {
    const t = cleanToken(token);
    const room = rooms.get(cleanCode(code));
    if (!room) throw new GameError('Table not found. Check the code and try again.');
    // Returning players (same token) keep their seat and name.
    const n = room.tokens.has(t) ? null : cleanName(name);
    return enter(room, t, n);
  });

  on('action', ({ type, amount }) => {
    const { room, pid } = current();
    if (!['fold', 'check', 'call', 'raise', 'allin'].includes(type)) throw new GameError('Unknown action.');
    room.action(pid, type, amount);
  });

  on('host', ({ cmd, settings, playerId }) => {
    const { room, pid } = current();
    switch (cmd) {
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

  on('rebuy', () => {
    const { room, pid } = current();
    room.rebuy(pid);
  });

  on('sitout', ({ value }) => {
    const { room, pid } = current();
    room.setSittingOut(pid, Boolean(value));
  });

  on('chat', ({ text }) => {
    const { room, pid } = current();
    room.say(pid, text);
  });

  on('show', () => {
    const { room, pid } = current();
    room.showCards(pid);
  });

  // Tonight's stats so far (anyone at the table can look).
  on('recap', () => {
    const { room } = current();
    return { recap: room.game.buildRecap() };
  });

  on('leave', () => {
    const { room, pid } = current();
    room.leave(pid);
  });

  socket.on('disconnect', detachCurrent);
});

// Clean up abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const empty = room.game.players.size === 0;
    const abandoned = room.connectedCount === 0 && now - room.lastActivity > IDLE_ROOM_MS;
    if (empty || abandoned) {
      room.destroy();
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Poky is running at http://localhost:${PORT}`);
});
