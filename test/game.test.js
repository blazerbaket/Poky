'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, GameError } = require('../src/game');
const { newDeck } = require('../src/cards');

function setup(stacks, settings = {}) {
  const g = new Game({ startingStack: 1000, smallBlind: 10, bigBlind: 20, ...settings });
  const ps = stacks.map((s, i) => {
    const p = g.addPlayer(`P${i}`);
    p.stack = s;
    return p;
  });
  return { g, ps };
}

/** Build a deck so that `holes` (in deal order, left of the button first) and `board` come out. */
function rigged(holes, board) {
  const used = new Set([...holes.flat(), ...board]);
  const rest = newDeck().filter((c) => !used.has(c));
  const deck = [];
  for (const hc of holes) deck.push(hc[0]);
  for (const hc of holes) deck.push(hc[1]);
  deck.push(rest.pop(), board[0], board[1], board[2]);
  deck.push(rest.pop(), board[3]);
  deck.push(rest.pop(), board[4]);
  deck.push(...rest);
  assert.equal(deck.length, 52);
  return deck;
}

/** Chips in stacks plus chips in the pot (including from players who already left). */
const totalChips = (g) =>
  [...g.players.values()].reduce((s, p) => s + p.stack, 0) +
  (g.handInProgress ? g.handPlayers.reduce((s, p) => s + p.totalBet, 0) : 0);

test('three-handed: blinds, button and first to act', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  assert.ok(g.startHand());
  assert.equal(g.buttonSeat, 0);
  assert.equal(ps[1].bet, 10); // small blind
  assert.equal(ps[2].bet, 20); // big blind
  assert.equal(g.toAct, 0); // under the gun = button when 3-handed
  for (const p of ps) assert.equal(p.cards.length, 2);
});

test('heads-up: button posts the small blind and acts first preflop, last postflop', () => {
  const { g, ps } = setup([1000, 1000]);
  g.startHand();
  assert.equal(g.buttonSeat, 0);
  assert.equal(ps[0].bet, 10);
  assert.equal(ps[1].bet, 20);
  assert.equal(g.toAct, 0);
  g.act(ps[0].id, 'call');
  assert.equal(g.toAct, 1); // big blind option
  g.act(ps[1].id, 'check');
  assert.equal(g.phase, 'flop');
  assert.equal(g.toAct, 1); // big blind acts first after the flop
});

test('button moves each hand', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  g.startHand();
  g.act(ps[0].id, 'fold');
  g.act(ps[1].id, 'fold');
  g.startHand();
  assert.equal(g.buttonSeat, 1);
  assert.equal(g.sbSeat, 2);
  assert.equal(g.bbSeat, 0);
});

test('everyone folds to the big blind', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  g.startHand();
  g.act(ps[0].id, 'fold');
  g.act(ps[1].id, 'fold');
  assert.equal(g.phase, 'handOver');
  assert.deepEqual(ps.map((p) => p.stack), [1000, 990, 1010]);
  assert.equal(g.result.uncontested, true);
});

test('big blind gets an option after limps', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  g.startHand();
  g.act(ps[0].id, 'call');
  g.act(ps[1].id, 'call');
  assert.equal(g.toAct, 2);
  const legal = g.legalActions(ps[2]);
  assert.equal(legal.canCheck, true);
  assert.ok(legal.raise);
  assert.equal(legal.raise.min, 40);
  g.act(ps[2].id, 'check');
  assert.equal(g.phase, 'flop');
  assert.equal(g.toAct, 1); // small blind first after the flop
});

test('cannot act out of turn or make illegal moves', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  g.startHand();
  assert.throws(() => g.act(ps[1].id, 'fold'), GameError);
  assert.throws(() => g.act(ps[0].id, 'check'), GameError); // must call the big blind
  assert.throws(() => g.act(ps[0].id, 'raise', 30), GameError); // min raise is to 40
  g.act(ps[0].id, 'raise', 60); // raise of 40
  assert.equal(g.minRaise, 40);
  assert.throws(() => g.act(ps[1].id, 'raise', 90), GameError); // must raise to at least 100
  g.act(ps[1].id, 'raise', 100);
  assert.equal(g.currentBet, 100);
});

test('showdown: best hand wins the pot', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  // deal order: seat1, seat2, seat0
  g.startHand(rigged([['Kh', 'Kd'], ['2c', '7d'], ['As', 'Ad']], ['Qs', '9h', '5c', '3d', 'Jc']));
  g.act(ps[0].id, 'call');
  g.act(ps[1].id, 'call');
  g.act(ps[2].id, 'check');
  for (let street = 0; street < 3; street++) {
    g.act(ps[1].id, 'check');
    g.act(ps[2].id, 'check');
    g.act(ps[0].id, 'check');
  }
  assert.equal(g.phase, 'handOver');
  assert.deepEqual(ps.map((p) => p.stack), [1040, 980, 980]);
  assert.equal(g.result.pots[0].handName, 'Pair of Aces');
});

test('side pots with three different all-in stacks', () => {
  const { g, ps } = setup([100, 300, 500]);
  g.startHand(rigged([['Kh', 'Kd'], ['2c', '7d'], ['As', 'Ad']], ['Qs', '9h', '5c', '3d', 'Jc']));
  g.act(ps[0].id, 'allin'); // to 100
  g.act(ps[1].id, 'allin'); // to 300
  g.act(ps[2].id, 'call'); // calls 300, 200 behind
  assert.equal(g.phase, 'handOver');
  assert.equal(g.board.length, 5);
  // Main pot 300 -> P0 (aces). Side pot 400 -> P1 (kings). P2 keeps 200.
  assert.deepEqual(ps.map((p) => p.stack), [300, 400, 200]);
  assert.equal(g.result.pots.length, 2);
});

test('uncalled part of a bet is returned', () => {
  const { g, ps } = setup([1000, 200, 1000]);
  g.startHand(rigged([['Kh', 'Kd'], ['2c', '7d'], ['As', 'Ad']], ['Qs', '9h', '5c', '3d', 'Jc']));
  g.act(ps[0].id, 'raise', 1000); // all-in for 1000
  g.act(ps[1].id, 'allin'); // calls all-in for 200
  g.act(ps[2].id, 'fold');
  assert.equal(g.phase, 'handOver');
  // P0 wins 200 + 200 + 20 (dead big blind); the uncalled 800 was returned.
  assert.deepEqual(ps.map((p) => p.stack), [1220, 0, 980]);
});

test('an incomplete all-in raise does not re-open betting', () => {
  const { g, ps } = setup([1000, 1000, 130]);
  g.startHand();
  g.act(ps[0].id, 'raise', 100); // raise of 80
  g.act(ps[1].id, 'call');
  g.act(ps[2].id, 'allin'); // to 130: only a 30 raise, less than 80
  assert.equal(g.toAct, 0);
  assert.equal(g.legalActions(ps[0]).raise, null);
  assert.throws(() => g.act(ps[0].id, 'raise', 300), GameError);
  g.act(ps[0].id, 'call');
  assert.equal(g.legalActions(ps[1]).raise, null);
  g.act(ps[1].id, 'call');
  assert.equal(g.phase, 'flop');
});

test('a full all-in raise does re-open betting', () => {
  const { g, ps } = setup([1000, 1000, 200]);
  g.startHand();
  g.act(ps[0].id, 'raise', 60); // raise of 40
  g.act(ps[1].id, 'call');
  g.act(ps[2].id, 'allin'); // to 200: a 140 raise
  assert.ok(g.legalActions(ps[0]).raise);
});

test('split pot gives the odd chip to the first winner left of the button', () => {
  const { g, ps } = setup([1000, 1000, 1000], { smallBlind: 5, bigBlind: 10 });
  g.startHand(rigged([['2c', '3d'], ['4c', '5d'], ['6c', '7d']], ['As', 'Ks', 'Qs', 'Js', 'Ts']));
  g.act(ps[0].id, 'call');
  g.act(ps[1].id, 'fold'); // 5 dead chips
  g.act(ps[2].id, 'check');
  for (let street = 0; street < 3; street++) {
    g.act(ps[2].id, 'check');
    g.act(ps[0].id, 'check');
  }
  // Pot 25 split between P2 and P0 -> 13 to P2 (first left of button), 12 to P0.
  assert.deepEqual(ps.map((p) => p.stack), [1002, 995, 1003]);
});

test('player leaving mid-hand is folded and the hand continues', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  g.startHand();
  g.removePlayer(ps[0].id); // it was their turn
  assert.equal(g.toAct, 1);
  g.removePlayer(ps[1].id); // only the big blind remains
  assert.equal(g.phase, 'handOver');
  assert.equal(ps[2].stack, 1010);
});

test('table theme: validated, and applies immediately even mid-hand', () => {
  const { g } = setup([1000, 1000]);
  assert.equal(g.settings.theme, 'classic');
  g.updateSettings({ theme: 'not-a-theme' });
  assert.equal(g.settings.theme, 'classic');
  g.startHand();
  g.updateSettings({ theme: 'kitchen', bigBlind: 40 });
  assert.equal(g.settings.theme, 'kitchen'); // cosmetic: right away
  assert.equal(g.settings.bigBlind, 20); // game rules: next hand
  assert.equal(g.pendingSettings.bigBlind, 40);
});

test('table name: cleaned, capped, and applies immediately even mid-hand', () => {
  const { g } = setup([1000, 1000]);
  assert.equal(g.settings.tableName, '');
  g.updateSettings({ tableName: '  Friday​   Night at\nAryan’s  ' });
  assert.equal(g.settings.tableName, 'Friday Night at Aryan’s');
  g.updateSettings({ tableName: 'x'.repeat(100) });
  assert.equal(g.settings.tableName.length, 32);
  g.startHand();
  g.updateSettings({ tableName: 'Poker Night' });
  assert.equal(g.settings.tableName, 'Poker Night');
});

test('show cards: only after the hand, and then everyone can see them', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  g.startHand();
  assert.throws(() => g.showCards(ps[0].id), GameError);
  g.act(ps[0].id, 'fold');
  g.act(ps[1].id, 'fold'); // big blind wins without a showdown
  assert.equal(g.phase, 'handOver');
  const winner = ps[2];
  assert.equal(g.getState(ps[0].id).seats[winner.seat].cards, null);
  assert.equal(g.getState(winner.id).me.canShow, true);
  g.showCards(winner.id);
  assert.deepEqual(g.getState(ps[0].id).seats[winner.seat].cards, winner.cards);
  assert.equal(g.getState(winner.id).me.canShow, false);
});

test('showdown entries carry the hand category (for big hand callouts)', () => {
  const { g, ps } = setup([1000, 1000]);
  // heads-up deal order: seat1, seat0
  g.startHand(rigged([['Kh', 'Kd'], ['2c', '7d']], ['Ks', 'Kc', '5c', '5d', 'Jc']));
  g.act(ps[0].id, 'call');
  g.act(ps[1].id, 'check');
  for (let street = 0; street < 3; street++) {
    g.act(ps[1].id, 'check');
    g.act(ps[0].id, 'check');
  }
  const kings = g.result.showdown.find((sd) => sd.id === ps[1].id);
  assert.equal(kings.category, 7);
  assert.equal(kings.handName, 'Four of a Kind, Kings');
});

test('recap: records, standings and titles', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  g.startHand(rigged([['Kh', 'Kd'], ['2c', '7d'], ['As', 'Ad']], ['Qs', '9h', '5c', '3d', 'Jc']));
  g.act(ps[0].id, 'allin');
  g.act(ps[1].id, 'fold');
  g.act(ps[2].id, 'call'); // P0's aces vs P2's 2-7 (deal order: seat1, seat2, seat0)
  assert.equal(g.phase, 'handOver');
  const r = g.buildRecap();
  assert.equal(r.hands, 1);
  assert.equal(r.biggestPot.amount, 2010);
  assert.equal(r.bestHand.player, 'P0');
  assert.equal(r.mostWins.name, 'P0');
  assert.deepEqual(r.standings.map((s) => [s.name, s.net]), [['P0', 1010], ['P1', -10], ['P2', -1000]]);
  const titles = Object.fromEntries(r.titles.map((t) => [t.title, t.name]));
  assert.equal(titles['Chip Leader'], 'P0');
  assert.equal(titles['The Cowboy'], 'P0');
  assert.equal(titles['Most Generous'], 'P2');
  // Leaving doesn't erase your night.
  g.removePlayer(ps[2].id);
  assert.equal(g.buildRecap().standings.find((s) => s.name === 'P2').net, -1000);
});

test('turn timer: auto-check or fold, then sit out', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  g.startHand();
  g.autoAct();
  assert.equal(ps[0].folded, true);
  assert.equal(ps[0].sittingOut, true);
});

test('hole cards are only visible to their owner until showdown', () => {
  const { g, ps } = setup([1000, 1000]);
  g.startHand();
  const view = g.getState(ps[0].id);
  assert.deepEqual(view.seats[0].cards, ps[0].cards);
  assert.equal(view.seats[1].cards, null);
  assert.equal(view.seats[1].hasCards, true);
  assert.ok(!JSON.stringify(view).includes(ps[1].cards[0] + '"'), 'opponent card must not leak');
  assert.equal(JSON.stringify(view).includes('deck'), false);
});

test('random simulation: chips are always conserved and hands always finish', () => {
  // Deterministic pseudo-random choices for the *players' decisions* only
  // (the deck still uses the real secure shuffle).
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  for (let game = 0; game < 150; game++) {
    const n = 2 + Math.floor(rnd() * 8);
    const { g } = setup(Array.from({ length: n }, () => 50 + Math.floor(rnd() * 2000)));
    let total = [...g.players.values()].reduce((s, p) => s + p.stack, 0);

    for (let hand = 0; hand < 60; hand++) {
      if (rnd() < 0.05 && g.players.size < 9) total += g.addPlayer('New').stack;
      if (!g.startHand()) break;
      let guard = 0;
      while (g.handInProgress) {
        assert.ok(guard++ < 500, 'hand did not finish');
        assert.equal(totalChips(g) + 0, total, 'chips not conserved mid-hand');
        if (rnd() < 0.01) {
          const victims = [...g.players.values()];
          const v = victims[Math.floor(rnd() * victims.length)];
          total -= v.stack; // they leave with their remaining stack; chips in the pot stay
          g.removePlayer(v.id);
          if (!g.handInProgress) break;
          continue;
        }
        const p = g.seats[g.toAct];
        const L = g.legalActions(p);
        const r = rnd();
        if (r < 0.15) g.act(p.id, 'fold');
        else if (r < 0.55) g.act(p.id, L.canCheck ? 'check' : 'call');
        else if (r < 0.9 && L.raise) g.act(p.id, 'raise', L.raise.min + Math.floor(rnd() * (L.raise.max - L.raise.min + 1)));
        else if (L.raise) g.act(p.id, 'allin');
        else g.act(p.id, L.canCheck ? 'check' : 'call');
      }
      const after = [...g.players.values()].reduce((s, p) => s + p.stack, 0);
      assert.equal(after, total, 'chips not conserved after hand');
      for (const p of g.players.values()) assert.ok(p.stack >= 0 && Number.isInteger(p.stack));
    }
  }
});

test('stats: VPIP, PFR, wins and showdowns are counted per hand', () => {
  const { g, ps } = setup([1000, 1000, 1000]);
  // Hand 1: P0 (button, first to act) raises, P1 (small blind) calls, P2 (big blind) folds.
  g.startHand();
  g.act(ps[0].id, 'raise', 60);
  g.act(ps[1].id, 'call');
  g.act(ps[2].id, 'fold');
  assert.equal(g.phase, 'flop');
  g.act(ps[1].id, 'check');
  g.act(ps[0].id, 'raise', 100);
  g.act(ps[1].id, 'fold');
  const h1 = Object.fromEntries(g.handSummary.players.map((p) => [p.id, p]));
  assert.deepEqual([h1[ps[0].id].vpip, h1[ps[0].id].pfr, h1[ps[0].id].won, h1[ps[0].id].showdown], [true, true, true, false]);
  assert.deepEqual([h1[ps[1].id].vpip, h1[ps[1].id].pfr, h1[ps[1].id].won], [true, false, false]);
  assert.deepEqual([h1[ps[2].id].vpip, h1[ps[2].id].pfr], [false, false]); // posting the blind isn't voluntary
  assert.equal(h1[ps[0].id].net, 80); // won 140, put in 60 (the uncalled 100 came back)
  assert.equal(h1[ps[1].id].net, -60);
  assert.equal(h1[ps[2].id].net, -20);

  // Hand 2: everyone limps / checks to a showdown. Checking the big blind is not VPIP.
  g.startHand();
  const bb = g.seats[g.bbSeat];
  for (let i = 0; i < 20 && g.handInProgress; i++) {
    const p = g.seats[g.toAct];
    g.act(p.id, g.legalActions(p).canCheck ? 'check' : 'call');
  }
  const h2 = g.handSummary.players;
  assert.ok(h2.every((p) => p.showdown));
  assert.equal(h2.find((p) => p.id === bb.id).vpip, false);
  assert.equal(h2.filter((p) => p.vpip).length, 2);

  const rows = Object.fromEntries(g.buildRecap().standings.map((r) => [r.name, r.stats]));
  assert.equal(rows.P0.hands, 2);
  assert.equal(rows.P0.pfr, 50);
  assert.equal(rows.P2.vpip, bb.id === ps[2].id ? 0 : 50);
  for (const r of Object.values(rows)) assert.equal(r.showdowns, 1);
});

test('sitting back down keeps your chips and does not count as a new buy-in', () => {
  const { g, ps } = setup([1000, 1000]);
  g.startHand();
  g.act(ps[0].id, 'fold'); // P0 loses the small blind
  const id = ps[0].id;
  const stack = ps[0].stack;
  g.removePlayer(id, 'P0 stood up to watch.');
  const back = g.addPlayer('P0', id, stack);
  assert.equal(back.stack, 990);
  const p0 = g.buildRecap().standings.find((r) => r.name === 'P0');
  assert.equal(p0.net, -10);
});
