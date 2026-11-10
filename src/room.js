'use strict';

/**
 * A Room wraps one Game with everything multiplayer: connected sockets,
 * reconnect tokens, the host, the turn timer and automatic next hands.
 */

const { Game, GameError, cleanText } = require('./game');
const { Pragy } = require('./pragy');

// "uncontested" leaves a moment for the winner to tap "Show cards".
const NEXT_HAND_DELAY = { showdown: 6000, uncontested: 4500, other: 2000 };
const CHAT_MAX_LENGTH = 200;
const CHAT_HISTORY = 50; // kept so someone who refreshes sees the recent chat
const CHAT_RATE = { count: 6, perMs: 10_000 };

class Room {
  constructor(code) {
    this.code = code;
    this.game = new Game();
    this.hostId = null;
    this.started = false;
    this.paused = false;
    this.tokens = new Map(); // secret reconnect token -> player id
    this.sockets = new Map(); // player id -> Set<socket>
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
    const taken = new Set([...this.game.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name.slice(0, 13)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // ------------------------------------------------------------ membership

  /** Join (or re-join with the same token). Returns the player. */
  join(socket, token, name) {
    const existingId = this.tokens.get(token);
    let player = existingId ? this.game.players.get(existingId) : null;
    let isNew = false;
    if (!player) {
      if (!name) throw new GameError('Please enter a nickname.');
      player = this.game.addPlayer(this.uniqueName(name));
      this.tokens.set(token, player.id);
      if (!this.hostId || !this.game.players.has(this.hostId)) this.hostId = player.id;
      isNew = true;
    }
    player.connected = true;
    if (!this.sockets.has(player.id)) this.sockets.set(player.id, new Set());
    this.sockets.get(player.id).add(socket);
    socket.emit('chatHistory', this.chat);
    this.touch();
    this.update();
    // Pragy only talks once the game is on (the lobby card covers him before that).
    if (isNew && this.started) this.pragy.say('join', { name: player.name });
    return player;
  }

  // ------------------------------------------------------------------ chat

  say(pid, rawText) {
    const p = this.game.players.get(pid);
    if (!p) throw new GameError('You are not at this table.');
    const text = cleanText(rawText, CHAT_MAX_LENGTH);
    if (!text) return;
    const now = Date.now();
    const recent = (this.chatTimes.get(pid) || []).filter((t) => now - t < CHAT_RATE.perMs);
    if (recent.length >= CHAT_RATE.count) throw new GameError('Slow down a little 🙂');
    recent.push(now);
    this.chatTimes.set(pid, recent);
    const msg = { id: ++this.chatId, pid, name: p.name, text, ts: now };
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
      const p = this.game.players.get(pid);
      if (p) p.connected = false;
    }
    this.touch();
    this.update();
  }

  /** A player leaves the table for good. */
  leave(pid) {
    for (const [t, id] of this.tokens) if (id === pid) this.tokens.delete(t);
    const set = this.sockets.get(pid);
    if (set) for (const s of set) {
      s.data.roomCode = null;
      s.data.playerId = null;
    }
    this.sockets.delete(pid);
    this.game.removePlayer(pid);
    if (this.hostId === pid) {
      const next = this.game.seats.find((p) => p && p.connected) || this.game.seats.find(Boolean);
      this.hostId = next ? next.id : null;
      if (next) this.game.addLog(`${next.name} is now the host.`);
    }
    this.touch();
    this.update();
  }

  kick(by, target) {
    this.requireHost(by);
    if (target === by) throw new GameError('You can’t remove yourself. Use “Leave table” instead.');
    if (!this.game.players.has(target)) throw new GameError('That player is no longer here.');
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
    this.syncTimers();
    this.broadcast();
    // After the state, so the line lands with what everyone is looking at.
    if (this.started) this.pragy.observe(this.game);
    if (endedNow) this.pragy.say('endNight');
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
    };
    // Every player gets their own personalised view (only their own hole cards).
    for (const [pid, set] of this.sockets) {
      const state = this.game.getState(pid);
      state.room = room;
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
