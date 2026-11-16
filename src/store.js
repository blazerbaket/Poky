'use strict';

/**
 * Where accounts and stats are kept.
 *
 * With DATABASE_URL set (e.g. a Neon Postgres URL) everything goes to Postgres.
 * Without it, a simple in-memory store with the same methods is used, so the game still runs
 * (and tests run) without a database; it just forgets accounts when the server restarts.
 *
 * Tables:
 *   users         one row per account
 *   sessions      logged-in browsers (only a hash of the cookie token is stored)
 *   games         one row per table/night that had at least one logged-in player
 *   game_players  per account per game: running totals, added to after every hand
 * Lifetime stats are just the sum of a player's game_players rows.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  username_key  TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS games (
  id           BIGSERIAL PRIMARY KEY,
  room_code    TEXT NOT NULL,
  table_name   TEXT NOT NULL DEFAULT '',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_hand_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS game_players (
  game_id       BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hands         INT    NOT NULL DEFAULT 0,
  wins          INT    NOT NULL DEFAULT 0,
  vpip          INT    NOT NULL DEFAULT 0,
  pfr           INT    NOT NULL DEFAULT 0,
  showdowns     INT    NOT NULL DEFAULT 0,
  showdown_wins INT    NOT NULL DEFAULT 0,
  net           BIGINT NOT NULL DEFAULT 0,
  biggest_win   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, user_id)
);
CREATE INDEX IF NOT EXISTS game_players_user ON game_players(user_id);
`;

const RECENT_GAMES = 20;
const COUNTS = ['hands', 'wins', 'vpip', 'pfr', 'showdowns', 'showdownWins', 'net'];

class TakenError extends Error {}

const emptyTotals = () => ({ hands: 0, wins: 0, vpip: 0, pfr: 0, showdowns: 0, showdownWins: 0, net: 0, biggestWin: 0, games: 0 });

// ------------------------------------------------------------------ Postgres

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    // Neon's URLs say sslmode=require; spell out the strict mode pg already uses (checks the
    // certificate), which also silences pg's warning about the name changing meaning in v9.
    const conn = url.replace(/([?&])sslmode=(require|prefer|verify-ca)\b/, '$1sslmode=verify-full');
    this.pool = new Pool({ connectionString: conn, max: 5, idleTimeoutMillis: 30_000 });
    this.pool.on('error', (err) => console.error('Database connection error:', err.message));
    this.kind = 'postgres';
  }

  async init() {
    await this.pool.query(SCHEMA);
  }

  async createUser(username, key, passwordHash) {
    try {
      const { rows } = await this.pool.query(
        'INSERT INTO users (username, username_key, password_hash) VALUES ($1, $2, $3) RETURNING id, username',
        [username, key, passwordHash]
      );
      return { id: String(rows[0].id), username: rows[0].username };
    } catch (err) {
      if (err.code === '23505') throw new TakenError('That username is taken.');
      throw err;
    }
  }

  async findUserByKey(key) {
    const { rows } = await this.pool.query('SELECT id, username, password_hash FROM users WHERE username_key = $1', [key]);
    return rows[0] ? { id: String(rows[0].id), username: rows[0].username, passwordHash: rows[0].password_hash } : null;
  }

  async createSession(tokenHash, userId, expiresAt) {
    await this.pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expiresAt]);
    // Housekeeping: drop expired sessions now and then.
    if (Math.random() < 0.05) this.pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
  }

  async findSession(tokenHash) {
    const { rows } = await this.pool.query(
      'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()',
      [tokenHash]
    );
    return rows[0] ? { id: String(rows[0].id), username: rows[0].username } : null;
  }

  async deleteSession(tokenHash) {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async createGame(roomCode, tableName) {
    const { rows } = await this.pool.query('INSERT INTO games (room_code, table_name) VALUES ($1, $2) RETURNING id', [roomCode, tableName || '']);
    return String(rows[0].id);
  }

  /** Add one finished hand to each account's totals for this game. rows: [{ userId, hands, wins, ..., biggestWin }] */
  async recordHand(gameId, tableName, rows) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE games SET last_hand_at = now(), table_name = $2 WHERE id = $1', [gameId, tableName || '']);
      for (const r of rows) {
        await client.query(
          `INSERT INTO game_players (game_id, user_id, hands, wins, vpip, pfr, showdowns, showdown_wins, net, biggest_win)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (game_id, user_id) DO UPDATE SET
             hands = game_players.hands + EXCLUDED.hands,
             wins = game_players.wins + EXCLUDED.wins,
             vpip = game_players.vpip + EXCLUDED.vpip,
             pfr = game_players.pfr + EXCLUDED.pfr,
             showdowns = game_players.showdowns + EXCLUDED.showdowns,
             showdown_wins = game_players.showdown_wins + EXCLUDED.showdown_wins,
             net = game_players.net + EXCLUDED.net,
             biggest_win = GREATEST(game_players.biggest_win, EXCLUDED.biggest_win)`,
          [gameId, r.userId, r.hands, r.wins, r.vpip, r.pfr, r.showdowns, r.showdownWins, r.net, r.biggestWin]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async userStats(userId) {
    const life = await this.pool.query(
      `SELECT COUNT(*)::int AS games, COALESCE(SUM(hands),0)::int AS hands, COALESCE(SUM(wins),0)::int AS wins,
              COALESCE(SUM(vpip),0)::int AS vpip, COALESCE(SUM(pfr),0)::int AS pfr,
              COALESCE(SUM(showdowns),0)::int AS showdowns, COALESCE(SUM(showdown_wins),0)::int AS showdown_wins,
              COALESCE(SUM(net),0)::bigint AS net, COALESCE(MAX(biggest_win),0)::bigint AS biggest_win
         FROM game_players WHERE user_id = $1`,
      [userId]
    );
    const games = await this.pool.query(
      `SELECT g.id, g.room_code, g.table_name, g.started_at, g.last_hand_at, gp.*
         FROM game_players gp JOIN games g ON g.id = gp.game_id
        WHERE gp.user_id = $1 ORDER BY g.last_hand_at DESC LIMIT ${RECENT_GAMES}`,
      [userId]
    );
    const toTotals = (r) => ({
      hands: Number(r.hands), wins: Number(r.wins), vpip: Number(r.vpip), pfr: Number(r.pfr),
      showdowns: Number(r.showdowns), showdownWins: Number(r.showdown_wins), net: Number(r.net), biggestWin: Number(r.biggest_win),
    });
    return {
      lifetime: { ...toTotals(life.rows[0]), games: life.rows[0].games },
      games: games.rows.map((r) => ({
        id: String(r.game_id), roomCode: r.room_code, tableName: r.table_name,
        startedAt: r.started_at.toISOString(), lastHandAt: r.last_hand_at.toISOString(), ...toTotals(r),
      })),
    };
  }

  /** Lifetime totals for every account that has played at least one hand (for the leaderboard). */
  async allTotals() {
    const { rows } = await this.pool.query(
      `SELECT u.username, COUNT(*)::int AS games, SUM(gp.hands)::int AS hands, SUM(gp.wins)::int AS wins,
              SUM(gp.vpip)::int AS vpip, SUM(gp.pfr)::int AS pfr, SUM(gp.showdowns)::int AS showdowns,
              SUM(gp.showdown_wins)::int AS showdown_wins, SUM(gp.net)::bigint AS net, MAX(gp.biggest_win)::bigint AS biggest_win
         FROM game_players gp JOIN users u ON u.id = gp.user_id
        GROUP BY u.id, u.username HAVING SUM(gp.hands) > 0 LIMIT 1000`
    );
    return rows.map((r) => ({
      username: r.username, games: r.games, hands: r.hands, wins: r.wins, vpip: r.vpip, pfr: r.pfr,
      showdowns: r.showdowns, showdownWins: r.showdown_wins, net: Number(r.net), biggestWin: Number(r.biggest_win),
    }));
  }

  /** Accounts whose username contains `q` (case-insensitive), names starting with it first. */
  async searchUsers(q, limit = 10) {
    const { rows } = await this.pool.query(
      `SELECT u.username, COALESCE(SUM(gp.hands), 0)::int AS hands
         FROM users u LEFT JOIN game_players gp ON gp.user_id = u.id
        WHERE u.username_key LIKE '%' || $1 || '%'
        GROUP BY u.id, u.username
        ORDER BY (u.username_key LIKE $1 || '%') DESC, u.username_key
        LIMIT $2`,
      [q.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`), limit]
    );
    return rows;
  }

  async close() {
    await this.pool.end();
  }
}

// ------------------------------------------------------------------ memory

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.users = new Map(); // id -> user
    this.byKey = new Map(); // username key -> id
    this.sessions = new Map(); // token hash -> { userId, expiresAt }
    this.games = new Map(); // id -> game
    this.gamePlayers = new Map(); // `${gameId}:${userId}` -> totals
    this.nextId = 1;
  }

  async init() {}

  async createUser(username, key, passwordHash) {
    if (this.byKey.has(key)) throw new TakenError('That username is taken.');
    const id = String(this.nextId++);
    this.users.set(id, { id, username, passwordHash });
    this.byKey.set(key, id);
    return { id, username };
  }

  async findUserByKey(key) {
    const id = this.byKey.get(key);
    return id ? { ...this.users.get(id) } : null;
  }

  async createSession(tokenHash, userId, expiresAt) {
    this.sessions.set(tokenHash, { userId, expiresAt });
  }

  async findSession(tokenHash) {
    const s = this.sessions.get(tokenHash);
    if (!s || s.expiresAt <= new Date()) return null;
    const u = this.users.get(s.userId);
    return u ? { id: u.id, username: u.username } : null;
  }

  async deleteSession(tokenHash) {
    this.sessions.delete(tokenHash);
  }

  async createGame(roomCode, tableName) {
    const id = String(this.nextId++);
    const now = new Date().toISOString();
    this.games.set(id, { id, roomCode, tableName: tableName || '', startedAt: now, lastHandAt: now });
    return id;
  }

  async recordHand(gameId, tableName, rows) {
    const g = this.games.get(gameId);
    g.lastHandAt = new Date().toISOString();
    g.tableName = tableName || '';
    for (const r of rows) {
      const k = `${gameId}:${r.userId}`;
      const t = this.gamePlayers.get(k) || { ...emptyTotals(), gameId, userId: r.userId };
      for (const c of COUNTS) t[c] += r[c];
      t.biggestWin = Math.max(t.biggestWin, r.biggestWin);
      this.gamePlayers.set(k, t);
    }
  }

  async userStats(userId) {
    const mine = [...this.gamePlayers.values()].filter((t) => t.userId === userId);
    const lifetime = emptyTotals();
    for (const t of mine) {
      for (const c of COUNTS) lifetime[c] += t[c];
      lifetime.biggestWin = Math.max(lifetime.biggestWin, t.biggestWin);
    }
    lifetime.games = mine.length;
    const games = mine
      .map((t) => {
        const g = this.games.get(t.gameId);
        const { gameId, userId: _u, games: _g, ...totals } = t;
        return { id: gameId, roomCode: g.roomCode, tableName: g.tableName, startedAt: g.startedAt, lastHandAt: g.lastHandAt, ...totals };
      })
      .sort((a, b) => (a.lastHandAt < b.lastHandAt ? 1 : -1))
      .slice(0, RECENT_GAMES);
    return { lifetime, games };
  }

  async allTotals() {
    const out = [];
    for (const u of this.users.values()) {
      const { lifetime } = await this.userStats(u.id);
      if (lifetime.hands > 0) out.push({ username: u.username, ...lifetime });
    }
    return out;
  }

  async searchUsers(q, limit = 10) {
    const k = q.toLowerCase();
    const hits = [];
    for (const [key, id] of this.byKey) if (key.includes(k)) hits.push({ key, id });
    hits.sort((a, b) => (b.key.startsWith(k) - a.key.startsWith(k)) || (a.key < b.key ? -1 : 1));
    const out = [];
    for (const h of hits.slice(0, limit)) {
      const { lifetime } = await this.userStats(h.id);
      out.push({ username: this.users.get(h.id).username, hands: lifetime.hands });
    }
    return out;
  }

  async close() {}
}

function createStore(url = process.env.DATABASE_URL) {
  return url ? new PgStore(url) : new MemoryStore();
}

module.exports = { createStore, MemoryStore, PgStore, TakenError };
