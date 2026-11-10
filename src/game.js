'use strict';

/**
 * Texas Hold'em game engine (no networking - pure game rules).
 *
 * Seats are numbered 0..8 and play proceeds clockwise in increasing seat order.
 */

const crypto = require('node:crypto');
const { shuffledDeck, prettyCard } = require('./cards');
const { bestHand, compareScores, describePocket } = require('./handEval');

const MAX_SEATS = 9;
const BETTING_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
const THEMES = Object.freeze(['classic', 'burgundy', 'midnight', 'kitchen']);
const DEFAULT_SETTINGS = Object.freeze({
  startingStack: 1000,
  smallBlind: 10,
  bigBlind: 20,
  turnTime: 30, // seconds; 0 = no timer
  allowRebuys: true,
  theme: 'classic',
  tableName: '', // e.g. "Friday Night at Aryan's"; shown on the felt and in invite previews
});
const TABLE_NAME_MAX = 32;
// Settings that only change how the table looks, so they apply right away, even mid-hand.
const COSMETIC = ['theme', 'tableName'];

/** Errors caused by a player's request (safe to show to the player). */
class GameError extends Error {}

/** Strip control/invisible characters, collapse whitespace, trim and cut to `max` characters. */
function cleanText(v, max) {
  return [...String(v ?? '')
    .replace(/\s+/g, ' ') // newlines/tabs become spaces first
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .trim()]
    .slice(0, max)
    .join('')
    .trim();
}

function validateSettings(s) {
  const int = (v, label, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new GameError(`${label} must be a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.`);
    }
    return n;
  };
  const out = {
    startingStack: int(s.startingStack, 'Starting chips', 2, 10_000_000),
    smallBlind: int(s.smallBlind, 'Small blind', 1, 1_000_000),
    bigBlind: int(s.bigBlind, 'Big blind', 1, 2_000_000),
    turnTime: int(s.turnTime, 'Turn timer', 0, 300),
    allowRebuys: Boolean(s.allowRebuys),
    theme: THEMES.includes(s.theme) ? s.theme : 'classic',
    tableName: cleanText(s.tableName, TABLE_NAME_MAX),
  };
  if (out.bigBlind < out.smallBlind) throw new GameError('The big blind must be at least the small blind.');
  if (out.bigBlind > out.startingStack) throw new GameError('The big blind can’t be more than the starting chips.');
  if (out.turnTime !== 0 && out.turnTime < 10) throw new GameError('The turn timer must be 0 (off) or at least 10 seconds.');
  return out;
}

function resetHandFields(p) {
  p.cards = [];
  p.inHand = false;
  p.folded = false;
  p.allIn = false;
  p.bet = 0; // chips put in during the current betting round
  p.totalBet = 0; // chips put in during the whole hand
  p.hasActed = false;
  p.actedAtRaise = -1; // value of fullRaiseCount when the player last acted
  p.lastAction = null;
  p.shown = false;
}

class Game {
  constructor(settings = {}) {
    this.settings = validateSettings({ ...DEFAULT_SETTINGS, ...settings });
    this.pendingSettings = null;
    this.seats = new Array(MAX_SEATS).fill(null);
    this.players = new Map();
    this.handPlayers = []; // players dealt into the current hand, starting left of the button
    this.phase = 'waiting'; // waiting | preflop | flop | turn | river | handOver
    this.handNumber = 0;
    this.actionCount = 0;
    this.buttonSeat = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.deck = [];
    this.deckPos = 0;
    this.board = [];
    this.toAct = -1;
    this.currentBet = 0;
    this.minRaise = 0;
    this.fullRaiseCount = 0;
    this.result = null;
    this.lastEvent = null;
    this.log = [];
    this.logId = 0;
    // For the end-of-night recap. Kept after a player leaves so their night still counts.
    this.stats = new Map(); // player id -> stats
    this.records = { biggestPot: null, bestHand: null };
  }

  statsFor(p) {
    let st = this.stats.get(p.id);
    if (!st) {
      st = { name: p.name, bought: 0, finalStack: null, handsPlayed: 0, handsWon: 0, folds: 0, allIns: 0, rebuys: 0 };
      this.stats.set(p.id, st);
    }
    return st;
  }

  get handInProgress() {
    return BETTING_PHASES.has(this.phase);
  }

  addLog(text) {
    this.log.push({ id: ++this.logId, text });
    if (this.log.length > 200) this.log.shift();
  }

  // ---------------------------------------------------------------- players

  addPlayer(name, id = crypto.randomBytes(8).toString('hex')) {
    const seat = this.seats.indexOf(null);
    if (seat === -1) throw new GameError('Sorry, the table is full (9 players max).');
    const p = { id, name, seat, stack: this.settings.startingStack, sittingOut: false, connected: true, rebuys: 0 };
    resetHandFields(p);
    this.seats[seat] = p;
    this.players.set(id, p);
    this.statsFor(p).bought = p.stack;
    this.addLog(`${name} joined the table.`);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.handInProgress && p.inHand && !p.folded) {
      p.folded = true;
      p.lastAction = { type: 'fold' };
      this.actionCount++;
      this.addLog(`${p.name} folds.`);
      if (this.toAct === p.seat) {
        this.continueFrom(p.seat);
      } else if (this.liveHandPlayers().length === 1) {
        this.finishHand();
      } else if (this.toAct !== -1 && !this.needsAction(this.seats[this.toAct])) {
        this.continueFrom(this.toAct);
      }
    }
    this.statsFor(p).finalStack = p.stack;
    this.seats[p.seat] = null;
    this.players.delete(id);
    this.addLog(`${p.name} left the table.`);
  }

  setSittingOut(id, value) {
    const p = this.mustGet(id);
    if (p.sittingOut === value) return;
    p.sittingOut = value;
    this.addLog(value ? `${p.name} is sitting out.` : `${p.name} is back.`);
  }

  rebuy(id) {
    const p = this.mustGet(id);
    if (!this.settings.allowRebuys) throw new GameError('Rebuys are turned off for this table.');
    if (p.stack > 0) throw new GameError('You can only rebuy when you are out of chips.');
    if (this.handInProgress && p.inHand) throw new GameError('Wait for this hand to finish.');
    p.stack = this.settings.startingStack;
    p.rebuys++;
    p.sittingOut = false;
    const st = this.statsFor(p);
    st.rebuys++;
    st.bought += p.stack;
    this.addLog(`${p.name} rebought for ${p.stack.toLocaleString()} chips.`);
  }

  updateSettings(partial) {
    const base = this.pendingSettings || this.settings;
    const next = validateSettings({ ...base, ...partial });
    if (this.handInProgress) {
      this.pendingSettings = next;
      // The look of the table (theme, name) is only cosmetic, so it changes right away, even mid-hand.
      const cosmetic = Object.fromEntries(COSMETIC.map((k) => [k, next[k]]));
      this.settings = { ...this.settings, ...cosmetic };
      this.addLog('Table settings updated (from the next hand).');
    } else {
      this.applySettings(next);
      this.addLog('Table settings updated.');
    }
  }

  applySettings(next) {
    const firstHandNotPlayed = this.handNumber === 0;
    this.settings = next;
    this.pendingSettings = null;
    // Before the first hand, everyone simply gets the new starting stack.
    if (firstHandNotPlayed) {
      for (const p of this.players.values()) {
        p.stack = next.startingStack;
        this.statsFor(p).bought = next.startingStack;
      }
    }
  }

  mustGet(id) {
    const p = this.players.get(id);
    if (!p) throw new GameError('You are not at this table.');
    return p;
  }

  isEligible(p) {
    return !p.sittingOut && p.stack > 0;
  }

  eligibleCount() {
    return this.seats.filter((p) => p && this.isEligible(p)).length;
  }

  liveHandPlayers() {
    return this.handPlayers.filter((p) => !p.folded);
  }

  /** Next occupied seat clockwise from `from` (exclusive) matching `pred`, or -1. */
  nextSeat(from, pred) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const seat = (((from + i) % MAX_SEATS) + MAX_SEATS) % MAX_SEATS;
      const p = this.seats[seat];
      if (p && pred(p)) return seat;
    }
    return -1;
  }

  // ------------------------------------------------------------------- hand

  /** Start a new hand. `deck` may be given for tests; otherwise a fresh secure shuffle is used. */
  startHand(deck) {
    if (this.handInProgress) throw new GameError('A hand is already in progress.');
    if (this.pendingSettings) this.applySettings(this.pendingSettings);

    const dealtIn = this.seats.filter((p) => p && this.isEligible(p));
    if (dealtIn.length < 2) return false;

    for (const p of this.players.values()) resetHandFields(p);
    this.handNumber++;
    this.actionCount++;
    this.result = null;
    this.board = [];
    for (const p of dealtIn) {
      p.inHand = true;
      this.statsFor(p).handsPlayed++;
    }
    const inHand = (p) => p.inHand;

    this.buttonSeat = this.nextSeat(this.buttonSeat, inHand);
    const headsUp = dealtIn.length === 2;
    this.sbSeat = headsUp ? this.buttonSeat : this.nextSeat(this.buttonSeat, inHand);
    this.bbSeat = this.nextSeat(this.sbSeat, inHand);

    // Order of play/dealing: starting with the player to the left of the button.
    this.handPlayers = [];
    let s = this.buttonSeat;
    for (let i = 0; i < dealtIn.length; i++) {
      s = this.nextSeat(s, inHand);
      this.handPlayers.push(this.seats[s]);
    }

    // The deck is fully shuffled before anything is dealt. Nothing about the
    // players (names, seats, timing) influences the shuffle.
    this.deck = deck ? [...deck] : shuffledDeck();
    this.deckPos = 0;
    for (let round = 0; round < 2; round++) {
      for (const p of this.handPlayers) p.cards.push(this.draw());
    }

    this.phase = 'preflop';
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;
    this.fullRaiseCount = 0;

    this.addLog(`— Hand #${this.handNumber} — ${this.seats[this.buttonSeat].name} has the button.`);
    const sb = this.seats[this.sbSeat];
    const bb = this.seats[this.bbSeat];
    this.postBlind(sb, this.settings.smallBlind, 'sb');
    this.postBlind(bb, this.settings.bigBlind, 'bb');
    this.currentBet = Math.max(sb.bet, bb.bet);

    this.continueFrom(this.bbSeat);
    return true;
  }

  draw() {
    return this.deck[this.deckPos++];
  }

  commit(p, amount) {
    const a = Math.min(amount, p.stack);
    p.stack -= a;
    p.bet += a;
    p.totalBet += a;
    if (p.stack === 0) p.allIn = true;
    return a;
  }

  postBlind(p, amount, type) {
    const a = this.commit(p, amount);
    p.lastAction = { type, amount: a };
    this.addLog(`${p.name} posts the ${type === 'sb' ? 'small' : 'big'} blind (${a.toLocaleString()})${p.allIn ? ' and is all-in' : ''}.`);
  }

  needsAction(p) {
    if (!p || !p.inHand || p.folded || p.allIn) return false;
    const othersCanAct = this.handPlayers.some((o) => o !== p && !o.folded && !o.allIn);
    return p.bet < this.currentBet || (!p.hasActed && othersCanAct);
  }

  /** After an action by `seat`, decide what happens next. */
  continueFrom(seat) {
    if (this.liveHandPlayers().length === 1) return this.finishHand();
    const next = this.nextSeat(seat, (p) => this.needsAction(p));
    if (next !== -1) {
      this.toAct = next;
      return;
    }
    this.toAct = -1;
    this.endBettingRound();
  }

  /** Legal actions for player `p` (assumes it is their turn). */
  legalActions(p) {
    const toCall = Math.min(Math.max(0, this.currentBet - p.bet), p.stack);
    const maxTo = p.bet + p.stack;
    const othersCanAct = this.handPlayers.some((o) => o !== p && !o.folded && !o.allIn);
    // A raise is allowed unless the betting was only re-opened by an incomplete all-in raise.
    const reopened = p.actedAtRaise < this.fullRaiseCount;
    const canRaise = othersCanAct && reopened && maxTo > this.currentBet;
    return {
      canCheck: toCall === 0,
      toCall,
      raise: canRaise
        ? { min: Math.min(this.currentBet + this.minRaise, maxTo), max: maxTo, isBet: this.currentBet === 0 }
        : null,
    };
  }

  /**
   * Perform an action for a player.
   *   type: 'fold' | 'check' | 'call' | 'raise' | 'allin'
   *   amount (raise only): the total the player's bet becomes this round ("raise to").
   */
  act(playerId, type, amount) {
    if (!this.handInProgress) throw new GameError('There is no hand in progress.');
    const p = this.players.get(playerId);
    if (!p || p.seat !== this.toAct) throw new GameError('It’s not your turn.');
    const legal = this.legalActions(p);

    if (type === 'allin') {
      if (legal.raise) {
        type = 'raise';
        amount = legal.raise.max;
      } else {
        type = legal.canCheck ? 'check' : 'call';
      }
    }

    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = { type: 'fold' };
        this.addLog(`${p.name} folds.`);
        break;
      case 'check':
        if (!legal.canCheck) throw new GameError('You can’t check, there’s a bet to call.');
        p.lastAction = { type: 'check' };
        this.addLog(`${p.name} checks.`);
        break;
      case 'call': {
        if (legal.canCheck) throw new GameError('There’s nothing to call, you can check.');
        const a = this.commit(p, legal.toCall);
        p.lastAction = { type: p.allIn ? 'allin' : 'call', amount: p.bet };
        this.addLog(`${p.name} calls ${a.toLocaleString()}${p.allIn ? ' and is all-in' : ''}.`);
        break;
      }
      case 'raise':
        this.doRaise(p, legal, amount);
        break;
      default:
        throw new GameError('Unknown action.');
    }

    p.hasActed = true;
    p.actedAtRaise = this.fullRaiseCount;
    if (p.folded) this.statsFor(p).folds++;
    if (p.allIn) this.statsFor(p).allIns++;
    this.actionCount++;
    // Lets clients play the right sound for exactly this action.
    this.lastEvent = { id: this.actionCount, seat: p.seat, type: p.lastAction.type };
    this.continueFrom(p.seat);
  }

  doRaise(p, legal, amount) {
    if (!legal.raise) throw new GameError('You can’t raise right now.');
    let to = Math.floor(Number(amount));
    if (!Number.isFinite(to)) throw new GameError('Please enter a valid amount.');
    to = Math.min(to, legal.raise.max);
    if (to < legal.raise.min) {
      throw new GameError(`The minimum ${legal.raise.isBet ? 'bet' : 'raise'} is ${legal.raise.min.toLocaleString()}.`);
    }
    const raiseBy = to - this.currentBet;
    if (raiseBy >= this.minRaise) {
      // A full raise: sets the new minimum raise and re-opens betting for everyone.
      this.minRaise = raiseBy;
      this.fullRaiseCount++;
    }
    this.currentBet = to;
    this.commit(p, to - p.bet);
    const verb = legal.raise.isBet ? 'bets' : 'raises to';
    p.lastAction = { type: p.allIn ? 'allin' : legal.raise.isBet ? 'bet' : 'raise', amount: to };
    this.addLog(`${p.name} ${verb} ${to.toLocaleString()}${p.allIn ? ' and is all-in' : ''}.`);
  }

  /** Called when a player's turn timer runs out: check if possible, otherwise fold, then sit them out. */
  autoAct() {
    const p = this.seats[this.toAct];
    if (!this.handInProgress || !p) return null;
    const legal = this.legalActions(p);
    this.addLog(`${p.name} ran out of time.`);
    this.act(p.id, legal.canCheck ? 'check' : 'fold');
    p.sittingOut = true;
    return p;
  }

  /** Return the part of the biggest bet that nobody called. */
  returnUncalled() {
    if (this.handPlayers.length === 0) return;
    const sorted = [...this.handPlayers].sort((a, b) => b.bet - a.bet);
    const top = sorted[0];
    const second = sorted[1] ? sorted[1].bet : 0;
    const excess = top.bet - second;
    // A folded bettor (only possible when someone leaves mid-hand) doesn't get chips back;
    // their bet stays in the pot as dead money.
    if (excess > 0 && !top.folded) {
      top.bet -= excess;
      top.totalBet -= excess;
      top.stack += excess;
      top.allIn = top.stack === 0;
    }
  }

  endBettingRound() {
    this.returnUncalled();
    for (const p of this.handPlayers) {
      p.bet = 0;
      p.hasActed = false;
      p.actedAtRaise = -1;
      if (!p.folded && !p.allIn) p.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;
    this.fullRaiseCount = 0;

    if (this.phase === 'river') return this.finishHand();

    this.draw(); // burn card
    if (this.phase === 'preflop') {
      this.board.push(this.draw(), this.draw(), this.draw());
      this.phase = 'flop';
      this.addLog(`Flop: ${this.board.map(prettyCard).join(' ')}`);
    } else if (this.phase === 'flop') {
      this.board.push(this.draw());
      this.phase = 'turn';
      this.addLog(`Turn: ${prettyCard(this.board[3])}`);
    } else {
      this.board.push(this.draw());
      this.phase = 'river';
      this.addLog(`River: ${prettyCard(this.board[4])}`);
    }
    // Post-flop, action starts with the first active player left of the button.
    this.continueFrom(this.buttonSeat);
  }

  /** Split everyone's contributions into a main pot and side pots. */
  buildPots(live) {
    const contrib = new Map(this.handPlayers.map((p) => [p, p.totalBet]));
    const pots = [];
    for (;;) {
      const eligible = live.filter((p) => contrib.get(p) > 0);
      if (eligible.length === 0) break;
      const level = Math.min(...eligible.map((p) => contrib.get(p)));
      let amount = 0;
      for (const p of this.handPlayers) {
        const c = Math.min(contrib.get(p), level);
        amount += c;
        contrib.set(p, contrib.get(p) - c);
      }
      const prev = pots[pots.length - 1];
      if (prev && prev.eligible.length === eligible.length && prev.eligible.every((p) => eligible.includes(p))) {
        prev.amount += amount;
      } else {
        pots.push({ amount, eligible });
      }
    }
    // Any leftover chips from folded players go to the last pot (rare edge case).
    let leftover = 0;
    for (const v of contrib.values()) leftover += v;
    if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  finishHand() {
    this.returnUncalled();
    this.toAct = -1;
    const live = this.liveHandPlayers();
    const total = this.handPlayers.reduce((sum, p) => sum + p.totalBet, 0);
    const winnings = {};
    let result;

    if (live.length === 1) {
      const w = live[0];
      w.stack += total;
      winnings[w.id] = total;
      result = {
        uncontested: true,
        pots: [{ amount: total, winners: [{ id: w.id, name: w.name, amount: total }], handName: null }],
        showdown: [],
        winnings,
      };
      this.addLog(`${w.name} wins ${total.toLocaleString()}.`);
    } else {
      const hands = new Map(live.map((p) => [p, bestHand([...p.cards, ...this.board])]));
      for (const p of live) {
        p.shown = true;
        this.addLog(`${p.name} shows ${p.cards.map(prettyCard).join(' ')} (${hands.get(p).name}).`);
      }
      const pots = this.buildPots(live).map((pot, i, all) => {
        let best = null;
        for (const p of pot.eligible) {
          const sc = hands.get(p).score;
          if (!best || compareScores(sc, best) > 0) best = sc;
        }
        // handPlayers order = clockwise from the button, which decides who gets odd chips.
        const winners = this.handPlayers.filter((p) => pot.eligible.includes(p) && compareScores(hands.get(p).score, best) === 0);
        const share = Math.floor(pot.amount / winners.length);
        let remainder = pot.amount - share * winners.length;
        const potName = all.length === 1 ? 'the pot' : i === 0 ? 'the main pot' : `side pot ${i}`;
        const paid = winners.map((p) => {
          const amt = share + (remainder > 0 ? 1 : 0);
          if (remainder > 0) remainder--;
          p.stack += amt;
          winnings[p.id] = (winnings[p.id] || 0) + amt;
          this.addLog(`${p.name} wins ${amt.toLocaleString()} from ${potName}.`);
          return { id: p.id, name: p.name, amount: amt };
        });
        return { amount: pot.amount, winners: paid, handName: hands.get(winners[0]).name };
      });
      result = {
        uncontested: false,
        pots,
        showdown: live.map((p) => ({
          id: p.id,
          name: p.name,
          handName: hands.get(p).name,
          category: hands.get(p).score[0], // 0 = high card ... 8 = straight flush
          bestCards: hands.get(p).cards,
        })),
        winnings,
      };
      // Best hand of the night (any hand shown down counts).
      for (const p of live) {
        const h = hands.get(p);
        const rec = this.records.bestHand;
        if (!rec || compareScores(h.score, rec.score) > 0) {
          this.records.bestHand = { score: h.score, name: h.name, player: p.name, hand: this.handNumber };
        }
      }
    }

    for (const id of Object.keys(winnings)) {
      const st = this.stats.get(id);
      if (st && winnings[id] > 0) st.handsWon++;
    }
    if (!this.records.biggestPot || total > this.records.biggestPot.amount) {
      this.records.biggestPot = {
        amount: total,
        winners: Object.keys(winnings).map((id) => this.stats.get(id)?.name ?? '?'),
        handName: result.uncontested ? null : result.pots[0].handName,
        hand: this.handNumber,
      };
    }

    for (const p of this.handPlayers) p.bet = 0;
    this.result = result;
    this.phase = 'handOver';
    this.actionCount++;
    for (const p of this.handPlayers) {
      if (p.stack === 0 && this.players.has(p.id)) this.addLog(`${p.name} is out of chips.`);
    }
  }

  /** After a hand, a player may choose to show their cards (e.g. after everyone folded to them). */
  showCards(id) {
    const p = this.mustGet(id);
    if (this.phase !== 'handOver') throw new GameError('You can show your cards once the hand is over.');
    if (!p.inHand || p.cards.length !== 2) throw new GameError('You weren’t dealt into this hand.');
    if (p.shown) return;
    p.shown = true;
    this.addLog(`${p.name} shows ${p.cards.map(prettyCard).join(' ')}.`);
  }

  // ---------------------------------------------------------------- recap

  /** Summary of the night so far: records, standings and some fun titles. */
  buildRecap() {
    const rows = [...this.stats.entries()].map(([id, st]) => {
      const p = this.players.get(id);
      // Mid-hand, count chips already bet this hand as still theirs (the recap is normally built between hands).
      const stack = p ? p.stack + (this.handInProgress && p.inHand ? p.totalBet : 0) : st.finalStack ?? 0;
      return { name: st.name, net: stack - st.bought, handsPlayed: st.handsPlayed, handsWon: st.handsWon, folds: st.folds, allIns: st.allIns, rebuys: st.rebuys, here: !!p };
    });
    const played = rows.filter((r) => r.handsPlayed > 0);
    const top = (key, pred) => {
      let best = null;
      for (const r of played) if (pred(r) && (!best || key(r) > key(best))) best = r;
      return best;
    };
    const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString()}`;

    const titles = [];
    if (played.length >= 2) {
      const add = (r, emoji, title, detail) => r && titles.push({ emoji, title, name: r.name, detail });
      const leader = top((r) => r.net, (r) => r.net > 0);
      add(leader, '👑', 'Chip Leader', leader && `${signed(leader.net)} chips`);
      const cowboy = top((r) => r.allIns, (r) => r.allIns > 0);
      add(cowboy, '🤠', 'The Cowboy', cowboy && `${cowboy.allIns} all-in${cowboy.allIns === 1 ? '' : 's'}`);
      const rock = top((r) => r.folds / r.handsPlayed, (r) => r.handsPlayed >= 5 && r.folds > 0);
      add(rock, '🪨', 'The Rock', rock && `folded ${Math.round((100 * rock.folds) / rock.handsPlayed)}% of hands`);
      const atm = top((r) => r.rebuys, (r) => r.rebuys > 0);
      add(atm, '🏧', 'The ATM', atm && `${atm.rebuys} rebuy${atm.rebuys === 1 ? '' : 's'}`);
      const generous = top((r) => -r.net, (r) => r.net < 0);
      add(generous, '🎁', 'Most Generous', generous && `${signed(generous.net)} chips`);
    }
    const wins = top((r) => r.handsWon, (r) => r.handsWon > 0);
    const { biggestPot, bestHand } = this.records;
    return {
      hands: this.handNumber,
      biggestPot,
      bestHand: bestHand && { name: bestHand.name, player: bestHand.player, hand: bestHand.hand },
      mostWins: wins && { name: wins.name, count: wins.handsWon },
      titles,
      standings: played.sort((a, b) => b.net - a.net).map((r) => ({ name: r.name, net: r.net, handsWon: r.handsWon, here: r.here })),
    };
  }

  // ------------------------------------------------------------------ views

  /** State as seen by one player: only their own hole cards (plus any shown at showdown). */
  getState(viewerId) {
    const me = this.players.get(viewerId);
    const inProgress = this.handInProgress;
    const pot = inProgress ? this.handPlayers.reduce((s, p) => s + p.totalBet - p.bet, 0) : 0;

    let myView = null;
    if (me) {
      let handName = null;
      if (me.inHand && me.cards.length === 2) {
        handName = this.board.length >= 3 ? bestHand([...me.cards, ...this.board]).name : describePocket(me.cards);
      }
      myView = {
        id: me.id,
        seat: me.seat,
        legal: inProgress && this.toAct === me.seat ? this.legalActions(me) : null,
        handName,
        canShow: this.phase === 'handOver' && me.inHand && me.cards.length === 2 && !me.shown,
      };
    }

    return {
      phase: this.phase,
      handInProgress: inProgress,
      handNumber: this.handNumber,
      actionCount: this.actionCount,
      board: this.board,
      pot,
      buttonSeat: this.buttonSeat,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      toAct: this.toAct,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      settings: this.settings,
      pendingSettings: this.pendingSettings,
      result: this.phase === 'handOver' ? this.result : null,
      lastEvent: this.lastEvent,
      log: this.log.slice(-80),
      me: myView,
      seats: this.seats.map(
        (p) =>
          p && {
            id: p.id,
            name: p.name,
            seat: p.seat,
            stack: p.stack,
            bet: p.bet,
            inHand: p.inHand,
            folded: p.folded,
            allIn: p.allIn,
            sittingOut: p.sittingOut,
            connected: p.connected,
            lastAction: p.lastAction,
            hasCards: p.inHand && !p.folded && p.cards.length > 0,
            shown: p.shown,
            // Hole cards are only ever sent to their owner, or to everyone once shown at showdown.
            cards: p.id === viewerId || p.shown ? p.cards : null,
          }
      ),
    };
  }
}

module.exports = { Game, GameError, MAX_SEATS, DEFAULT_SETTINGS, THEMES, validateSettings, cleanText };
