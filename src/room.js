'use strict';

/**
 * A Room wraps one Game with everything multiplayer: connected sockets,
 * reconnect tokens, the host, the turn timer and automatic next hands.
 */

const crypto = require('node:crypto');
const { Game, GameError, cleanText, playerStats } = require('./game');
const { Pragy } = require('./pragy');

// "uncontested" leaves a moment for the winner to tap "Show cards".
const NEXT_HAND_DELAY = { showdown: 6000, uncontested: 4500, other: 2000 };
const CHAT_MAX_LENGTH = 200;
const CHAT_HISTORY = 50; // kept so someone who refreshes sees the recent chat
const CHAT_RATE = { count: 6, perMs: 10_000 };
const DENY_COOLDOWN_MS = 30_000; // after a "no", wait a bit before asking again

class Room {
  /** `store` (optional) saves stats for logged-in players after every hand. */
  constructor(code, { store = null } = {}) {
    this.code = code;
    this.game = new Game();
    this.store = store;
    this.accounts = new Map(); // member id -> { userId, username } for logged-in people
    this.dbGameId = null; // created when the first hand with a logged-in player is saved
    this.savedHand = 0;
    this.saveChain = Promise.resolve(); // saves run one after another, in hand order
    this.hostId = null;
    this.started = false;
    this.paused = false;
    this.tokens = new Map(); // secret reconnect token -> member id (player or spectator)
    this.sockets = new Map(); // member id -> Set<socket>
    // People watching. { id, name, connected, requested, requestedAt, stack } where stack is the
    // chips they stood up with (null if they've never sat down).
    this.spectators = new Map();
    this.approved = new Set(); // ids the host has let in; they can sit back down without asking
    this.deniedAt = new Map(); // id -> when the host last said no
    this.turnTimer = null;
    this.turnDeadline = null;
    this.turnKey = null;
    this.nextHandTimer = null;
    this.nextHandAt = null;
    this.lastActivity = Date.now();
    this.chat = [];
    this.chatId = 0;
    this.chatTimes = new Map(); // player id -> recent message timestamps (rate limit)
    this.endAfterHand = false; // host asked to end the night; finish the current hand first
    this.ended = false;
    this.endedAt = null;
    this.recap = null;
    this.slowTimer = null;
    this.pragy = new Pragy((line) => this.emitAll('pragy', line));
  }

  emitAll(event, data) {
    for (const set of this.sockets.values()) for (const s of set) s.emit(event, data);
  }

  touch() {
    this.lastActivity = Date.now();
  }

  get connectedCount() {
    let n = 0;
    for (const set of this.sockets.values()) n += set.size;
    return n;
  }

  requireHost(pid) {
    if (pid !== this.hostId) throw new GameError('Only the host can do that.');
  }

  uniqueName(name) {
    const everyone = [...this.game.players.values(), ...this.spectators.values()];
    const taken = new Set(everyone.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 13)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /** A seated player or a spectator. */
  member(id) {
    return this.game.players.get(id) || this.spectators.get(id) || null;
  }

  // ------------------------------------------------------------ membership

  /**
   * Join (or re-join with the same token). The person who creates the room sits straight down as host.
   * Everyone else arrives as a spectator; with `wantSeat` they also ask the host for a seat.
   * Returns { id, notice } where notice is something to tell the newcomer (e.g. the table is full).
   */
  join(socket, token, name, wantSeat = false, user = null) {
    const existingId = this.tokens.get(token);
    let id = existingId && this.member(existingId) ? existingId : null;
    // Logged in on another device (or after clearing the browser)? Same account = same seat.
    if (!id && user) {
      for (const [mid, acc] of this.accounts) if (acc.userId === user.id && this.member(mid)) id = mid;
      if (id) this.tokens.set(token, id);
    }
    // Was here as a guest and has now logged in: from now on their hands count for the account.
    if (id && user && !this.accounts.has(id) && ![...this.accounts.values()].some((a) => a.userId === user.id)) {
      this.accounts.set(id, { userId: user.id, username: user.username });
    }
    let isNew = false;
    if (!id) {
      if (user) name = user.username; // logged-in players always play under their username
      if (!name) throw new GameError('Please enter a nickname.');
      const clean = this.uniqueName(name);
      if (!this.hostId) {
        id = this.game.addPlayer(clean).id;
        this.hostId = id;
        this.approved.add(id);
      } else {
        id = crypto.randomBytes(8).toString('hex');
        this.spectators.set(id, { id, name: clean, connected: true, requested: false, requestedAt: 0, stack: null });
      }
      this.tokens.set(token, id);
      if (user) this.accounts.set(id, { userId: user.id, username: user.username });
      isNew = true;
    }
    this.member(id).connected = true;
    if (!this.sockets.has(id)) this.sockets.set(id, new Set());
    this.sockets.get(id).add(socket);
    socket.emit('chatHistory', this.chat);
    this.touch();

    let notice = null;
    if (isNew && wantSeat && this.spectators.has(id)) {
      try {
        this.requestSeat(id, false);
      } catch (err) {
        if (!(err instanceof GameError)) throw err;
        notice = err.message; // e.g. the table is full: they stay and watch
      }
    }
    this.update();
    return { id, notice };
  }

  // ----------------------------------------------------------- spectators

  /** A spectator asks for a seat. Returning players and tables without approval sit straight down. */
  requestSeat(id, sendUpdate = true) {
    const sp = this.spectators.get(id);
    if (!sp) throw new GameError('You already have a seat.');
    if (!this.game.seats.includes(null)) throw new GameError('The table is full (9 players max). You can watch for now.');
    if (this.approved.has(id) || !this.game.settings.requireApproval) {
      this.seat(id);
    } else if (!sp.requested) {
      const deniedAt = this.deniedAt.get(id) || 0;
      if (Date.now() - deniedAt < DENY_COOLDOWN_MS) throw new GameError('The host said not yet. Try again in a little while.');
      sp.requested = true;
      sp.requestedAt = Date.now();
      this.game.addLog(`${sp.name} asked for a seat.`);
    }
    if (sendUpdate) this.update();
  }

  cancelRequest(id) {
    const sp = this.spectators.get(id);
    if (!sp || !sp.requested) return;
    sp.requested = false;
    this.update();
  }

  /** Move a spectator into the first empty seat. */
  seat(id) {
    const sp = this.spectators.get(id);
    const p = this.game.addPlayer(sp.name, id, sp.stack);
    p.connected = sp.connected;
    this.spectators.delete(id);
    this.approved.add(id);
    // Pragy only talks once the game is on (the lobby card covers him before that).
    if (this.started) this.pragy.say('join', { name: p.name });
  }

  approve(by, id) {
    this.requireHost(by);
    const sp = this.spectators.get(id);
    if (!sp || !sp.requested) throw new GameError('That request is no longer there.');
    if (!this.game.seats.includes(null)) throw new GameError('The table is full (9 players max).');
    this.seat(id);
    this.update();
  }

  deny(by, id) {
    this.requireHost(by);
    const sp = this.spectators.get(id);
    if (!sp || !sp.requested) return;
    sp.requested = false;
    this.deniedAt.set(id, Date.now());
    this.game.addLog(`The host didn’t seat ${sp.name} this time.`);
    for (const s of this.sockets.get(id) || []) s.emit('denied');
    this.update();
  }

  /** A player gives up their seat to watch. They keep their chips for when they sit back down. */
  standUp(pid) {
    const p = this.game.players.get(pid);
    if (!p) throw new GameError('You aren’t sitting at the table.');
    this.game.removePlayer(pid, `${p.name} stood up to watch.`);
    // removePlayer may have folded them; their stack is what's left after that.
    this.spectators.set(pid, { id: pid, name: p.name, connected: p.connected, requested: false, requestedAt: 0, stack: p.stack });
    this.touch();
    this.update();
  }

  /** For the card you see when tapping a seat: tonight's stats, and the account (for all-time stats). */
  playerInfo(id) {
    const m = this.member(id);
    if (!m) throw new GameError('That player is no longer here.');
    const g = this.game;
    const st = g.stats.get(id);
    const acc = this.accounts.get(id);
    let tonight = null;
    if (st) {
      // Chips now (counting what's already in the pot this hand, or what they stood up with) minus chips bought.
      const p = g.players.get(id);
      const stack = p ? p.stack + (g.handInProgress && p.inHand ? p.totalBet : 0) : (this.spectators.get(id)?.stack ?? st.finalStack ?? 0);
      tonight = {
        ...playerStats({ hands: st.handsDone, wins: st.handsWon, vpip: st.vpip, pfr: st.pfr, showdowns: st.showdowns, showdownWins: st.showdownWins }),
        net: stack - st.bought,
      };
    }
    return { name: m.name, username: acc ? acc.username : null, tonight };
  }

  // ------------------------------------------------------------------ chat

  say(pid, rawText) {
    const p = this.member(pid);
    if (!p) throw new GameError('You are not at this table.');
    const text = cleanText(rawText, CHAT_MAX_LENGTH);
    if (!text) return;
    const now = Date.now();
    const recent = (this.chatTimes.get(pid) || []).filter((t) => now - t < CHAT_RATE.perMs);
    if (recent.length >= CHAT_RATE.count) throw new GameError('Slow down a little 🙂');
    recent.push(now);
    this.chatTimes.set(pid, recent);
    const msg = { id: ++this.chatId, pid, name: p.name, text, ts: now, spectator: this.spectators.has(pid) };
    this.chat.push(msg);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    this.emitAll('chat', msg);
    this.touch();
  }

  /** A socket went away (closed tab, lost connection). The player keeps their seat. */
  detach(socket, pid) {
    const set = this.sockets.get(pid);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) {
      this.sockets.delete(pid);
      const p = this.member(pid);
      if (p) p.connected = false;
    }
    this.touch();
    this.update();
  }

  /** A player or spectator leaves the table for good. */
  leave(pid) {
    for (const [t, id] of this.tokens) if (id === pid) this.tokens.delete(t);
    const set = this.sockets.get(pid);
    if (set) for (const s of set) {
      s.data.roomCode = null;
      s.data.playerId = null;
    }
    this.sockets.delete(pid);
    this.approved.delete(pid);
    this.accounts.delete(pid);
    if (this.spectators.has(pid)) this.spectators.delete(pid);
    else this.game.removePlayer(pid);
    if (this.hostId === pid) {
      // Prefer someone at the table who's online, then anyone seated, then a spectator.
      const watchers = [...this.spectators.values()];
      const next =
        this.game.seats.find((p) => p && p.connected) || this.game.seats.find(Boolean) ||
        watchers.find((s) => s.connected) || watchers[0];
      this.hostId = next ? next.id : null;
      if (next) this.game.addLog(`${next.name} is now the host.`);
    }
    this.touch();
    this.update();
  }

  kick(by, target) {
    this.requireHost(by);
    if (target === by) throw new GameError('You can’t remove yourself. Use “Leave table” instead.');
    if (!this.member(target)) throw new GameError('That player is no longer here.');
    for (const s of this.sockets.get(target) || []) s.emit('kicked');
    this.leave(target);
  }

  // --------------------------------------------------------------- actions

  start(pid) {
    this.requireHost(pid);
    if (this.started) throw new GameError('The game has already started.');
    if (this.game.eligibleCount() < 2) throw new GameError('You need at least 2 players to start.');
    this.started = true;
    this.game.startHand();
    this.pragy.observe(this.game); // take a first look so the deal isn't announced twice
    this.pragy.say('start');
    this.touch();
    this.update();
  }

  setPaused(pid, value) {
    this.requireHost(pid);
    if (!this.started) throw new GameError('The game hasn’t started yet.');
    this.paused = value;
    this.game.addLog(value ? 'The host paused the game.' : 'The host resumed the game.');
    this.update();
  }

  updateSettings(pid, settings) {
    this.requireHost(pid);
    if (!settings || typeof settings !== 'object') throw new GameError('Invalid settings.');
    this.game.updateSettings(settings);
    // Approval just turned off: let in everyone who was waiting (while there's room).
    if (!this.game.settings.requireApproval) {
      const waiting = [...this.spectators.values()].filter((s) => s.requested).sort((a, b) => a.requestedAt - b.requestedAt);
      for (const sp of waiting) if (this.game.seats.includes(null)) this.seat(sp.id);
    }
    this.update();
  }

  action(pid, type, amount) {
    if (this.paused) throw new GameError('The game is paused.');
    this.game.act(pid, type, amount);
    this.touch();
    this.update();
  }

  rebuy(pid) {
    this.game.rebuy(pid);
    this.update();
    this.pragy.say('rebuy', { name: this.game.players.get(pid).name });
  }

  setSittingOut(pid, value) {
    this.game.setSittingOut(pid, value);
    this.update();
  }

  showCards(pid) {
    this.game.showCards(pid);
    this.update();
  }

  /** Host ends the night: right away between hands, otherwise once the current hand is over. */
  endNight(pid) {
    this.requireHost(pid);
    if (!this.started) throw new GameError('The game hasn’t started yet.');
    if (this.ended || this.endAfterHand) return;
    this.endAfterHand = true;
    if (this.game.handInProgress) this.game.addLog('The host will end the night after this hand.');
    this.update();
  }

  /** Host keeps playing (cancels a pending end, or continues after the recap). */
  continueNight(pid) {
    this.requireHost(pid);
    if (!this.ended && !this.endAfterHand) return;
    if (this.ended) this.game.addLog('The host is keeping the game going.');
    this.endAfterHand = false;
    this.ended = false;
    this.endedAt = null;
    this.recap = null;
    this.update();
  }

  // ---------------------------------------------------------------- timers

  /** Call after anything changes: keeps timers in sync and sends everyone the new state. */
  update() {
    let endedNow = false;
    if (this.endAfterHand && !this.game.handInProgress) {
      this.endAfterHand = false;
      this.ended = true;
      this.endedAt = Date.now();
      this.recap = this.game.buildRecap();
      this.game.addLog('The host ended the night. Thanks for playing!');
      endedNow = true;
    }
    this.saveFinishedHand();
    this.syncTimers();
    this.broadcast();
    // After the state, so the line lands with what everyone is looking at.
    if (this.started) this.pragy.observe(this.game);
    if (endedNow) this.pragy.say('endNight');
  }

  /** After each hand, add it to the stats of every logged-in player who was dealt in. */
  saveFinishedHand() {
    const hs = this.game.handSummary;
    if (!this.store || !hs || hs.handNumber === this.savedHand) return;
    this.savedHand = hs.handNumber;
    const rows = hs.players
      .filter((p) => this.accounts.has(p.id))
      .map((p) => ({
        userId: this.accounts.get(p.id).userId,
        hands: 1,
        wins: p.won ? 1 : 0,
        vpip: p.vpip ? 1 : 0,
        pfr: p.pfr ? 1 : 0,
        showdowns: p.showdown ? 1 : 0,
        showdownWins: p.showdown && p.won ? 1 : 0,
        net: p.net,
        biggestWin: p.won ? p.net : 0,
      }));
    if (!rows.length) return;
    const tableName = this.game.settings.tableName;
    this.saveChain = this.saveChain
      .then(async () => {
        if (!this.dbGameId) this.dbGameId = await this.store.createGame(this.code, tableName);
        await this.store.recordHand(this.dbGameId, tableName, rows);
      })
      .catch((err) => console.error(`Saving stats for room ${this.code} failed:`, err.message));
  }

  syncTimers() {
    const g = this.game;

    // Turn timer: restart whenever it becomes someone's turn.
    const key =
      g.handInProgress && g.toAct !== -1 && !this.paused && g.settings.turnTime > 0
        ? `${g.handNumber}:${g.actionCount}:${g.toAct}`
        : null;
    if (key !== this.turnKey) {
      clearTimeout(this.turnTimer);
      clearTimeout(this.slowTimer);
      this.turnTimer = null;
      this.slowTimer = null;
      this.turnDeadline = null;
      this.turnKey = key;
      if (key) {
        const ms = g.settings.turnTime * 1000;
        this.turnDeadline = Date.now() + ms;
        this.turnTimer = setTimeout(() => this.onTurnTimeout(key), ms);
        // Pragy nudges a player who is taking a while.
        const name = g.seats[g.toAct].name;
        if (ms >= 15_000) this.slowTimer = setTimeout(() => key === this.turnKey && this.pragy.say('slow', { name }), ms - 8_000);
      }
    }

    // Next hand: deal automatically a few seconds after a hand ends.
    const canDeal = this.started && !this.paused && !this.ended && !g.handInProgress && g.eligibleCount() >= 2;
    if (!canDeal) {
      clearTimeout(this.nextHandTimer);
      this.nextHandTimer = null;
      this.nextHandAt = null;
    } else if (!this.nextHandTimer) {
      const r = g.result;
      const delay = !r ? NEXT_HAND_DELAY.other : r.uncontested ? NEXT_HAND_DELAY.uncontested : NEXT_HAND_DELAY.showdown;
      this.nextHandAt = Date.now() + delay;
      this.nextHandTimer = setTimeout(() => this.onNextHand(), delay);
    }
  }

  onTurnTimeout(key) {
    if (key !== this.turnKey) return;
    this.turnTimer = null;
    this.turnKey = null;
    try {
      this.game.autoAct();
    } catch (err) {
      console.error('autoAct failed', err);
    }
    this.update();
  }

  onNextHand() {
    this.nextHandTimer = null;
    this.nextHandAt = null;
    if (this.started && !this.paused && !this.ended && !this.game.handInProgress) {
      try {
        this.game.startHand();
      } catch (err) {
        console.error('startHand failed', err);
      }
    }
    this.update();
  }

  // ------------------------------------------------------------- broadcast

  broadcast() {
    const now = Date.now();
    const room = {
      code: this.code,
      hostId: this.hostId,
      started: this.started,
      paused: this.paused,
      endAfterHand: this.endAfterHand,
      ended: this.ended,
      endedAt: this.endedAt,
      recap: this.ended ? this.recap : null,
      turnRemainingMs: this.turnDeadline ? Math.max(0, this.turnDeadline - now) : null,
      nextHandInMs: this.nextHandAt ? Math.max(0, this.nextHandAt - now) : null,
      // Everyone can see who's watching; seat requests are listed oldest first.
      spectators: [...this.spectators.values()]
        .sort((a, b) => (a.requested === b.requested ? a.requestedAt - b.requestedAt : a.requested ? -1 : 1))
        .map((s) => ({ id: s.id, name: s.name, connected: s.connected, requested: s.requested })),
      verified: [...this.accounts.keys()], // members playing with an account (shown with a ✓)
    };
    // Everyone gets their own personalised view (players see only their own hole cards; spectators see none).
    for (const [pid, set] of this.sockets) {
      const state = this.game.getState(pid);
      state.room = room;
      const sp = this.spectators.get(pid);
      state.viewer = sp
        ? { id: pid, name: sp.name, spectator: true, requested: sp.requested, approved: this.approved.has(pid) }
        : { id: pid, spectator: false };
      for (const s of set) s.emit('state', state);
    }
  }

  destroy() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.slowTimer);
    clearTimeout(this.nextHandTimer);
  }
}

module.exports = { Room };
