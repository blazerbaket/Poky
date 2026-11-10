'use strict';

/**
 * Pragy, the mascot dealer. Watches the game and now and then says something.
 * The server picks the line so everyone at the table sees the same thing.
 *
 * Lines use {name}, {hand} and {suit} placeholders.
 */

const LINES = {
  start: [
    'Alright alright, Master Dealer Pragy is in the house! Shuffle up and deal 🃏',
    'Phones down, chips up. Chalo shuru karte hain! 🎲',
    'Welcome, legends. May the river be kind to you 🌊',
    'Good luck everyone. You’ll need it against me 😏',
  ],
  newHand: [
    'Fresh deck, fresh dreams ✨',
    'New hand! Forget the last one, I already did 🙈',
    'Cards are flying… catch! 🃏',
    'Shuffled it myself. Totally fair. Probably 😏',
    'Another hand, another chance to bluff your friends 🤥',
    'Chalo, next hand. Focus, focus 🧘',
    'Deal me in… oh wait, I’m the dealer 😅',
    'Let’s see who’s feeling brave this time 🦁',
  ],
  flop: [
    'Here comes the flop! 🔥',
    'Flop’s out. Somebody’s smiling, somebody’s sweating 😅',
    'Three cards, a hundred feelings 🎭',
    'Ooh, interesting flop… I’m not saying anything 🤐',
    'Poker faces, everyone. I can see you 👀',
  ],
  flushBoard: [
    'Three {suit} on the board… flush alert 🚨',
    'So many {suit}! Careful, careful 😬',
    'All {suit}? Somebody’s flushing with joy 🌈',
  ],
  pairedBoard: [
    'Paired board! Somebody might have trips 👀',
    'Board paired… I smell a full house 🏠',
  ],
  aceBoard: [
    'An ace! Who’s got the ace? Don’t all answer at once 👀',
    'Ace on the flop. Someone just sat up straight 😳',
  ],
  turn: [
    'The turn! Things are heating up 🌶️',
    'Turn card’s here. Breathe, everyone 😮‍💨',
    'One card closer to glory… or heartbreak 💔',
    'Turn card. Agar bola hai tho, bet karo 😤',
  ],
  river: [
    'The river… where dreams come true or go to die 🌊',
    'River time! Last chance for some magic ✨',
    'And the river is… dun dun dunnn 🥁',
    'River card. No more excuses after this one 😬',
  ],
  allIn: [
    '{name} is ALL-IN! Somebody call an ambulance 🚑',
    '{name} pushes it all in! Le betee! 💥',
    'All the chips! {name} means business 😤',
    '{name} said “agar bola hai tho” and shoved 🔥',
    'Whoa, {name} is all-in! Even the Master Dealer is sweating 😰',
    '{name} going all-in like there’s no tomorrow 🎢',
  ],
  raise: [
    '{name} raises! Spicy 🌶️',
    '{name} is putting on the pressure 💪',
    'Ooh, {name} wants that pot 🤑',
    '{name} raising… bluff or monster? 🤔',
  ],
  foldWin: [
    '{name} takes it down. Nobody wanted to fight 🤷',
    'Everyone folded to {name}. Respect 🫡',
    '{name} wins without showing. Mystery! 🕵️',
    'Easy money for {name} 💸',
    '{name} scared everyone away 👻',
    'Hat! Everyone folded. {name} takes it 😎',
  ],
  showdownWin: [
    '{name} wins with {hand}! 🎉',
    '{hand} for {name}. Lets gooo! 🚀',
    'Show ’em and weep. {name} takes it 😎',
    '{name} drags the pot with {hand}. What a drag! 💰',
    'Winner winner, chai and samosa dinner, {name}! ☕',
    'Le betee! {name} wins with {hand} 🙌',
  ],
  monster: [
    '{hand}!! {name}, that’s just unfair 😱',
    'Master Dealer Pragy has never seen anything like it. {hand}! 🤯',
    'Somebody check {name}’s sleeves… {hand}! 🕵️',
  ],
  split: [
    'Split pot! Share karo, everybody’s happy 🤝',
    'A tie! Chips for everyone… well, half ✂️',
  ],
  bigPot: [
    'That was a MONSTER pot! {name} is rolling in it 🤑',
    'Big pot alert! {name} can buy samosas for everyone now 🥟',
    '{name} just took the pot of the night (so far) 🏆',
  ],
  bust: [
    '{name} is out of chips 💀 Tarap tarap ke…',
    'Ghee khatam for {name} 😢',
    'RIP {name}’s stack. Gone but not forgotten 🕯️',
    '{name} busted! 2000 buy-in aaja? 😏',
    'Oof. {name}, its okay yaar 🫂',
    'Tera bhi sahi hai bhai, {name} 😔',
  ],
  rebuy: [
    '{name} is back with a fresh stack! Round two 🥊',
    '{name} reloaded. The comeback starts now 💪',
    'Rebuy by {name}! The bank thanks you 🏦',
    '{name} is not done yet. Respect 🫡',
  ],
  join: [
    'Welcome {name}! Grab a seat 🪑',
    '{name} has entered the chat… I mean, the table 😎',
    'Look who’s here! Hi {name} 👋',
    '{name} just sat down. Fresh chips! 🍪',
  ],
  slow: [
    'Tick tock, {name}… ⏳',
    'Jaldi kar bhai, {name}! 😩',
    '{name} is thinking really hard 🧠',
    '{name}, the cards aren’t getting any younger 👴',
    'Neend aa rahi hai yaar… come on {name} 😴',
  ],
  endNight: [
    'That’s a wrap! Great game, everyone 🌙',
    'Good night, legends. Same time next week? 😉',
    'Master Dealer Pragy is closing the table. Check the recap! 📊',
  ],
};

// chance = how often Pragy speaks up; important lines skip the usual quiet period.
const RULES = {
  start: { chance: 1, important: true, rank: 9 },
  endNight: { chance: 1, important: true, rank: 9 },
  monster: { chance: 1, important: true, rank: 8 },
  allIn: { chance: 0.85, important: true, rank: 7 },
  bust: { chance: 0.9, important: true, rank: 7 },
  bigPot: { chance: 0.8, rank: 6 },
  split: { chance: 0.8, rank: 5 },
  showdownWin: { chance: 0.55, rank: 4 },
  foldWin: { chance: 0.35, rank: 4 },
  rebuy: { chance: 0.7, rank: 4 },
  join: { chance: 0.8, rank: 4 },
  slow: { chance: 0.7, rank: 4 },
  flushBoard: { chance: 0.6, rank: 3 },
  pairedBoard: { chance: 0.5, rank: 3 },
  aceBoard: { chance: 0.45, rank: 3 },
  river: { chance: 0.3, rank: 2 },
  flop: { chance: 0.3, rank: 2 },
  turn: { chance: 0.2, rank: 2 },
  raise: { chance: 0.25, rank: 2 },
  newHand: { chance: 0.3, rank: 1 },
};
const QUIET_MS = 10_000; // normal gap between lines
const MIN_GAP_MS = 2_500; // even important lines wait this long
const SUIT_NAMES = { h: 'hearts', d: 'diamonds', s: 'spades', c: 'clubs' };

class Pragy {
  /** `emit(line)` sends a line to the table. `rng` and `now` can be replaced in tests. */
  constructor(emit, { rng = Math.random, now = Date.now } = {}) {
    this.emit = emit;
    this.rng = rng;
    this.now = now;
    this.lastAt = -Infinity;
    this.id = 0;
    this.recent = new Map(); // key -> last few line indexes (to avoid repeats)
    this.seen = null; // snapshot of the game from the last observe()
  }

  /** Maybe say something for `key`. Returns the text if Pragy spoke. */
  say(key, vars = {}) {
    const rule = RULES[key];
    const lines = LINES[key];
    if (!rule || !lines) return null;
    const t = this.now();
    const gap = t - this.lastAt;
    if (gap < MIN_GAP_MS || (!rule.important && gap < QUIET_MS)) return null;
    if (this.rng() >= rule.chance) return null;

    const recent = this.recent.get(key) || [];
    const fresh = lines.map((_, i) => i).filter((i) => !recent.includes(i));
    const pick = fresh[Math.floor(this.rng() * fresh.length)] ?? 0;
    this.recent.set(key, [...recent, pick].slice(-Math.min(3, lines.length - 1)));

    const text = lines[pick].replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
    this.lastAt = t;
    this.emit({ id: ++this.id, text });
    return text;
  }

  /** Pick the most interesting thing that happened since last time and maybe comment on it. */
  observe(game) {
    const prev = this.seen;
    const g = game;
    this.seen = { handNumber: g.handNumber, phase: g.phase, board: g.board.length, eventId: g.lastEvent && g.lastEvent.id };
    if (!prev) return null;

    const candidates = [];
    const add = (key, vars) => candidates.push({ key, vars, rank: RULES[key].rank });

    if (g.handNumber > prev.handNumber && g.handInProgress) add('newHand');

    if (g.board.length > prev.board && g.handNumber === prev.handNumber) {
      if (g.board.length === 3) {
        const suits = new Set(g.board.map((c) => c[1]));
        const ranks = new Set(g.board.map((c) => c[0]));
        if (suits.size === 1) add('flushBoard', { suit: SUIT_NAMES[g.board[0][1]] });
        else if (ranks.size < 3) add('pairedBoard');
        else if (ranks.has('A')) add('aceBoard');
        else add('flop');
      } else if (g.board.length === 4) add('turn');
      else if (g.board.length === 5) add('river');
    }

    const ev = g.lastEvent;
    if (ev && ev.id !== prev.eventId && g.handNumber === prev.handNumber) {
      const p = g.seats[ev.seat];
      if (p && ev.type === 'allin') add('allIn', { name: p.name });
      else if (p && (ev.type === 'raise' || ev.type === 'bet')) add('raise', { name: p.name });
    }

    if (g.phase === 'handOver' && prev.phase !== 'handOver' && g.result) {
      const r = g.result;
      const total = r.pots.reduce((s, pot) => s + pot.amount, 0);
      const top = r.pots[0].winners[0];
      if (r.uncontested) {
        add('foldWin', { name: top.name });
      } else {
        const winnerIds = new Set(r.pots.flatMap((pot) => pot.winners.map((w) => w.id)));
        const best = r.showdown.filter((sd) => winnerIds.has(sd.id)).sort((a, b) => b.category - a.category)[0];
        if (best && best.category >= 6) add('monster', { name: best.name, hand: best.handName });
        if (r.pots[0].winners.length > 1) add('split');
        add('showdownWin', { name: top.name, hand: r.pots[0].handName });
      }
      if (total >= 30 * g.settings.bigBlind) add('bigPot', { name: top.name });
      for (const p of g.handPlayers) {
        if (p.stack === 0 && g.players.has(p.id)) add('bust', { name: p.name });
      }
    }

    // Most interesting first; if Pragy lets that one pass, he may still comment on the next.
    candidates.sort((a, b) => b.rank - a.rank);
    for (const c of candidates) {
      const text = this.say(c.key, c.vars);
      if (text) return text;
    }
    return null;
  }
}

module.exports = { Pragy, LINES, RULES };
