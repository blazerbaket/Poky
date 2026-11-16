'use strict';

/**
 * Poker hand evaluation.
 *
 * A hand "score" is an array: [category, ...tiebreakers]. Two scores are
 * compared element by element, so a higher score is always the better hand.
 *
 * Categories:
 *   8 Straight flush, 7 Four of a kind, 6 Full house, 5 Flush, 4 Straight,
 *   3 Three of a kind, 2 Two pair, 1 Pair, 0 High card
 */

const RANK_VALUE = Object.fromEntries('23456789TJQKA'.split('').map((r, i) => [r, i + 2]));

const RANK_NAME = {
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
};
const plural = (v) => (v === 6 ? 'Sixes' : RANK_NAME[v] + 's');

/** Score exactly five cards. */
function evaluate5(cards) {
  const values = cards.map((c) => RANK_VALUE[c[0]]).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c[1] === cards[0][1]);

  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  // Groups ordered by size, then by rank: e.g. full house K K K 5 5 -> [[13,3],[5,2]]
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let straightHigh = 0;
  if (counts.size === 5) {
    if (values[0] - values[4] === 4) straightHigh = values[0];
    else if (values[0] === 14 && values[1] === 5) straightHigh = 5; // A-2-3-4-5 "wheel"
  }

  if (straightHigh && isFlush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (isFlush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], groups[1][0], groups[2][0], groups[3][0]];
  return [0, ...values];
}

function compareScores(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function describe(score) {
  const [cat, a, b] = score;
  switch (cat) {
    case 8: return a === 14 ? 'Royal Flush' : `Straight Flush, ${RANK_NAME[a]} High`;
    case 7: return `Four of a Kind, ${plural(a)}`;
    case 6: return `Full House, ${plural(a)} full of ${plural(b)}`;
    case 5: return `Flush, ${RANK_NAME[a]} High`;
    case 4: return `Straight, ${RANK_NAME[a]} High`;
    case 3: return `Three of a Kind, ${plural(a)}`;
    case 2: return `Two Pair, ${plural(a)} and ${plural(b)}`;
    case 1: return `Pair of ${plural(a)}`;
    default: return `${RANK_NAME[a]} High`;
  }
}

const SHORT_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

/** Just the hand type ("Two Pair", "Flush"), for the live label under your cards. */
function shortName(score) {
  if (score[0] === 8 && score[1] === 14) return 'Royal Flush';
  return SHORT_NAMES[score[0]];
}

/** Best five-card hand from 5–7 cards. Returns { score, cards, name }. */
function bestHand(cards) {
  if (cards.length < 5 || cards.length > 7) throw new Error('bestHand needs 5 to 7 cards');
  const n = cards.length;
  let best = null;
  let bestCards = null;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluate5(five);
            if (!best || compareScores(score, best) > 0) {
              best = score;
              bestCards = five;
            }
          }
  return { score: best, cards: bestCards, name: describe(best), short: shortName(best) };
}

/** Short description for two hole cards before the flop (pairs only). */
function describePocket(cards) {
  if (cards.length === 2 && cards[0][0] === cards[1][0]) return `Pair of ${plural(RANK_VALUE[cards[0][0]])}`;
  return null;
}

module.exports = { evaluate5, bestHand, compareScores, describe, describePocket, shortName };
