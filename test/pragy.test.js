'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pragy, LINES, RULES } = require('../src/pragy');
const { Game } = require('../src/game');

function make({ rng = () => 0 } = {}) {
  let t = 1_000_000;
  const said = [];
  const p = new Pragy((line) => said.push(line.text), { rng, now: () => t });
  return { p, said, wait: (ms) => (t += ms) };
}

test('every situation has lines and a rule', () => {
  assert.deepEqual(Object.keys(LINES).sort(), Object.keys(RULES).sort());
  for (const lines of Object.values(LINES)) assert.ok(lines.length >= 2);
});

test('fills in names and keeps quiet between ordinary lines', () => {
  const { p, said, wait } = make();
  assert.ok(p.say('join', { name: 'Mia' }).includes('Mia'));
  assert.equal(p.say('newHand'), null); // too soon after the last line
  wait(3000);
  assert.ok(p.say('allIn', { name: 'Sam' }).includes('Sam')); // important lines get through
  wait(11_000);
  assert.ok(p.say('newHand'));
  assert.equal(said.length, 3);
  assert.ok(!said.some((s) => s.includes('{')));
});

test('does not repeat the same line back to back', () => {
  let i = 0;
  const seq = [0, 0, 0, 0, 0, 0]; // always "pick the first" -> must still vary
  const { p, said, wait } = make({ rng: () => seq[i++ % seq.length] });
  for (let k = 0; k < 4; k++) {
    p.say('newHand');
    wait(11_000);
  }
  assert.equal(new Set(said).size, 4);
});

test('watches the game: comments on an all-in and on the winner', () => {
  const { p, said, wait } = make();
  const g = new Game({ startingStack: 1000, smallBlind: 10, bigBlind: 20 });
  const ps = ['Ann', 'Ben', 'Cat'].map((n) => g.addPlayer(n));
  g.startHand();
  p.observe(g);
  g.act(ps[0].id, 'allin');
  wait(3000);
  p.observe(g);
  assert.match(said.at(-1), /Ann/);
  g.act(ps[1].id, 'fold');
  g.act(ps[2].id, 'fold');
  wait(11_000);
  p.observe(g);
  assert.match(said.at(-1), /Ann/); // everyone folded to Ann
});
