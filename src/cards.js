'use strict';

/**
 * Cards are two-character strings: rank + suit, e.g. "As", "Td", "7h".
 *   ranks: 2 3 4 5 6 7 8 9 T J Q K A
 *   suits: s (spades) h (hearts) d (diamonds) c (clubs)
 */

const crypto = require('node:crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };

function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/**
 * Unbiased in-place Fisher–Yates shuffle.
 *
 * Fairness notes:
 *  - Randomness comes from crypto.randomInt(), which uses the operating
 *    system's cryptographically secure random generator (never Math.random()).
 *  - crypto.randomInt(n) returns a uniform integer in [0, n) with no modulo
 *    bias (it uses rejection sampling internally).
 *  - Fisher–Yates with a uniform j in [0, i] makes every one of the 52!
 *    possible deck orders exactly equally likely.
 *
 * `randInt` can be injected for testing only; production always uses crypto.
 */
function shuffle(arr, randInt = crypto.randomInt) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1); // 0 <= j <= i
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** A freshly ordered deck, securely shuffled. Called once per hand. */
function shuffledDeck() {
  return shuffle(newDeck());
}

function prettyCard(c) {
  return (c[0] === 'T' ? '10' : c[0]) + SUIT_SYMBOLS[c[1]];
}

module.exports = { RANKS, SUITS, newDeck, shuffle, shuffledDeck, prettyCard };
