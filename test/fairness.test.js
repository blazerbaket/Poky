'use strict';
/**
 * Statistical fairness tests for the shuffle and the deal.
 *
 * Each test uses a chi-square goodness-of-fit test at a very strict
 * significance level (0.0001), so a truly fair shuffle fails by chance only
 * about once in 10,000 runs, while a biased shuffle fails reliably.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { newDeck, shuffle, shuffledDeck } = require('../src/cards');
const { Game } = require('../src/game');

const Z = 3.719; // z-score for p = 0.0001 (one-sided)
/** Wilson–Hilferty approximation of the chi-square critical value. */
const chiCritical = (df) => df * Math.pow(1 - 2 / (9 * df) + Z * Math.sqrt(2 / (9 * df)), 3);
const chiSquare = (observed, expected) => observed.reduce((s, o) => s + ((o - expected) ** 2) / expected, 0);

test('deck has 52 unique cards and the shuffle keeps them all', () => {
  const d = shuffledDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
  assert.deepEqual([...d].sort(), newDeck().sort());
});

test('Fisher–Yates draws j uniformly from [0, i] for every position', () => {
  const calls = [];
  shuffle(newDeck(), (n) => {
    calls.push(n);
    return 0;
  });
  assert.deepEqual(calls, Array.from({ length: 51 }, (_, k) => 52 - k));
});

/** Chi-square statistic for "which card ends up in which position" over N shuffles. */
function positionChi(shuffleFn, N) {
  const index = Object.fromEntries(newDeck().map((c, i) => [c, i]));
  const counts = Array.from({ length: 52 }, () => new Array(52).fill(0)); // [card][position]
  for (let t = 0; t < N; t++) {
    const d = shuffleFn();
    for (let pos = 0; pos < 52; pos++) counts[index[d[pos]]][pos]++;
  }
  return chiSquare(counts.flat(), N / 52);
}

test('every card is equally likely to land in every deck position', () => {
  const chi = positionChi(shuffledDeck, 100_000);
  const crit = chiCritical(51 * 51);
  assert.ok(chi < crit, `position bias detected: chi²=${chi.toFixed(1)} > ${crit.toFixed(1)}`);
});

test('the fairness check really does catch a subtly biased shuffle', () => {
  // A common mistake: swapping each card with ANY position. Looks random, but isn't uniform.
  const crypto = require('node:crypto');
  const naive = () => {
    const a = newDeck();
    for (let i = 0; i < a.length; i++) {
      const j = crypto.randomInt(a.length);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const chi = positionChi(naive, 50_000);
  assert.ok(chi > chiCritical(51 * 51), 'the test failed to detect a known-biased shuffle');
});

test('real games: every seat wins and gets pocket aces equally often', () => {
  const HANDS = 20_000;
  const g = new Game({ startingStack: 1_000_000, smallBlind: 1, bigBlind: 2 });
  for (let i = 0; i < 9; i++) g.addPlayer(`P${i}`);
  const wins = new Array(9).fill(0);
  const aces = new Array(9).fill(0);

  for (let h = 0; h < HANDS; h++) {
    for (const p of g.players.values()) p.stack = 1_000_000;
    g.startHand();
    for (const p of g.handPlayers) if (p.cards[0][0] === 'A' && p.cards[1][0] === 'A') aces[p.seat]++;
    // Everyone checks/calls to the river so every hand reaches showdown.
    while (g.handInProgress) {
      const p = g.seats[g.toAct];
      g.act(p.id, g.legalActions(p).canCheck ? 'check' : 'call');
    }
    const winners = g.result.pots[0].winners;
    for (const w of winners) wins[g.players.get(w.id).seat] += 1 / winners.length;
  }

  const crit = chiCritical(8);
  const winChi = chiSquare(wins, HANDS / 9);
  assert.ok(winChi < crit, `seat win-rate bias: chi²=${winChi.toFixed(2)} > ${crit.toFixed(2)} (${wins.map(Math.round)})`);
  const aceChi = chiSquare(aces, HANDS / 221);
  assert.ok(aceChi < crit, `pocket aces bias: chi²=${aceChi.toFixed(2)} > ${crit.toFixed(2)} (${aces})`);
});
