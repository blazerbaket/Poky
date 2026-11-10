'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bestHand, compareScores } = require('../src/handEval');

const h = (s) => bestHand(s.split(' '));
const beats = (a, b) => assert.ok(compareScores(h(a).score, h(b).score) > 0, `${a} should beat ${b}`);
const ties = (a, b) => assert.equal(compareScores(h(a).score, h(b).score), 0, `${a} should tie ${b}`);

test('names hands correctly', () => {
  assert.equal(h('As Ks Qs Js Ts').name, 'Royal Flush');
  assert.equal(h('9h 8h 7h 6h 5h').name, 'Straight Flush, Nine High');
  assert.equal(h('7c 7d 7h 7s 2c').name, 'Four of a Kind, Sevens');
  assert.equal(h('Kc Kd Kh 5s 5c').name, 'Full House, Kings full of Fives');
  assert.equal(h('Ad 9d 7d 4d 2d').name, 'Flush, Ace High');
  assert.equal(h('Ac 2d 3h 4s 5c').name, 'Straight, Five High');
  assert.equal(h('6c 6d 6h Ks 2c').name, 'Three of a Kind, Sixes');
  assert.equal(h('Jc Jd 4h 4s Ac').name, 'Two Pair, Jacks and Fours');
  assert.equal(h('Tc Td 4h 3s Ac').name, 'Pair of Tens');
  assert.equal(h('Ac Jd 8h 4s 2c').name, 'Ace High');
});

test('category order', () => {
  const order = [
    'As Ks Qs Js Ts', '7c 7d 7h 7s 2c', 'Kc Kd Kh 5s 5c', 'Ad 9d 7d 4d 2d', '9c 8d 7h 6s 5c',
    '6c 6d 6h Ks 2c', 'Jc Jd 4h 4s Ac', 'Tc Td 4h 3s Ac', 'Ac Jd 8h 4s 2c',
  ];
  for (let i = 0; i < order.length - 1; i++) beats(order[i], order[i + 1]);
});

test('kickers and tie-breaks', () => {
  beats('Ah Ad Kc 4s 2d', 'As Ac Qd 4h 2c'); // pair kicker
  beats('Kh Kd 5c 5s 2d', 'Qs Qc Jd Jh Ac'); // two pair: top pair matters most
  beats('Kh Kd 5c 5s 3d', 'Ks Kc 5d 5h 2c'); // two pair kicker
  beats('6c 7d 8h 9s Tc', 'Ac 2d 3h 4s 5c'); // wheel is the lowest straight
  beats('2h 3h 4h 5h 6h', 'Ah 2h 3h 4h 5h'); // steel wheel is the lowest straight flush
  beats('Ad Kd 7d 4d 3d', 'Ac Kc 7c 4c 2c'); // flush compares all five cards
  ties('Ac Kd Qh Js 9c', 'Ad Kh Qs Jc 9d');
});

test('best 5 out of 7', () => {
  assert.equal(h('As Ks 2d 3c Qs Js Ts').name, 'Royal Flush');
  assert.equal(h('2c 2d 2h Ks Kc Kd 9s').name, 'Full House, Kings full of Twos');
  assert.equal(h('Ah 2c 3d 4s 5h Kc Kd').name, 'Straight, Five High');
  // board plays: both players have the same best hand
  ties('2c 3d Ah Kh Qh Jh Th', '4s 5s Ah Kh Qh Jh Th');
});
