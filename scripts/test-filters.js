#!/usr/bin/env node
// Offline tests for scoring, filtering and tab routing. No API keys needed:
// they run against scripts/fixtures/discovery.json, a copy of the example config.
const assert = require('assert');
const path = require('path');
process.env.CONFIG_DIR = path.resolve(__dirname, 'fixtures');
const { scoreKeyword, filterKeywords, classifyIntent, generateNote } = require('../src/keyword-discovery.js');

const kw = (keyword, tp = 500, extra = {}) => ({ keyword, volume: tp, difficulty: 5, traffic_potential: tp, ...extra });
const kept = list => filterKeywords(list).map(k => k.keyword);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('score rises with traffic potential and falls with difficulty', () => {
  assert.ok(scoreKeyword({ traffic_potential: 5000, difficulty: 5 }) > scoreKeyword({ traffic_potential: 500, difficulty: 5 }));
  assert.ok(scoreKeyword({ traffic_potential: 500, difficulty: 0 }) > scoreKeyword({ traffic_potential: 500, difficulty: 40 }));
  assert.strictEqual(scoreKeyword({ traffic_potential: 999, difficulty: 10 }), 28);
});

t('single words and weak two-word phrases are dropped', () => {
  assert.deepStrictEqual(kept([kw('coffee'), kw('coffee beans', 50), kw('coffee beans', 400)]), ['coffee beans']);
});

t('brand, off-topic and low-potential keywords are dropped', () => {
  assert.deepStrictEqual(kept([
    kw('starbucks coffee beans'),
    kw('coffee beans near me'),
    kw('best running shoes'),
    kw('bulk coffee beans supplier', 10),
    kw('bulk coffee beans supplier'),
  ]), ['bulk coffee beans supplier']);
});

t('retired topics pass only with an exception angle', () => {
  assert.deepStrictEqual(kept([
    kw('buy flavored coffee beans'),
    kw('flavored coffee vs regular coffee'),
  ]), ['flavored coffee vs regular coffee']);
});

t('non-home market seeds always route to the international tab', () => {
  assert.strictEqual(classifyIntent('coffee roaster', 'commercial', 'de'), 'wholesale');
});

t('local-language and geo terms route to the international tab', () => {
  assert.strictEqual(classifyIntent('kaffee großhandel', 'commercial', 'us'), 'wholesale');
  assert.strictEqual(classifyIntent('coffee supplier europe', 'commercial', 'us'), 'wholesale');
});

t('question topics are informational even with buying words', () => {
  assert.strictEqual(classifyIntent('how to buy coffee beans', 'commercial', 'us'), 'informational');
});

t('home-market trade and buying terms are commercial', () => {
  assert.strictEqual(classifyIntent('wholesale coffee beans', 'informational', 'us'), 'commercial');
  assert.strictEqual(classifyIntent('best espresso beans', 'informational', 'us'), 'commercial');
});

t('otherwise the seed intent decides', () => {
  assert.strictEqual(classifyIntent('arabica altitude', 'informational', 'us'), 'informational');
  assert.strictEqual(classifyIntent('arabica altitude', 'commercial', 'us'), 'commercial');
});

t('notes carry source, metrics and market', () => {
  const note = generateNote({ keyword: 'x', volume: 90, difficulty: 0, traffic_potential: 300, market: 'de', seedTopic: 'kaffee großhandel' });
  assert.ok(note.includes('kaffee großhandel') && note.includes('KD 0') && note.includes('Vol:90') && note.includes('Germany market'));
});

console.log(`\n${n} tests passed`);
