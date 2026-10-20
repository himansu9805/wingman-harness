import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRoute } from '../src/route.ts';

test('shows the selected model and probabilities for every route', () => {
  assert.equal(formatRoute({ type: 'route', choice: 'fast', confidence: 0.0003665156881398346,
    probabilities: { fast: 0.5112700443976795, powerful: 0.4887299556023205 } }),
    'fast — fast: 51.13%, powerful: 48.87%');
});

test('zero confidence still displays the supplied probabilities', () => {
  assert.equal(formatRoute({ type: 'route', choice: 'fast', confidence: 0,
    probabilities: { fast: 0.5, powerful: 0.5 } }),
    'fast — fast: 50.00%, powerful: 50.00%');
});

test('distinguishes exact zero probability from a tiny positive probability', () => {
  assert.equal(formatRoute({ type: 'route', choice: 'powerful', confidence: 1,
    probabilities: { zero: 0, tiny: 0.000001, powerful: 0.999999 } }),
    'powerful — zero: 0.00%, tiny: <0.01%, powerful: 100.00%');
});

test('older or empty route events do not invent probabilities', () => {
  for (const probabilities of [undefined, {}]) {
    assert.equal(formatRoute({ type: 'route', choice: 'fast', confidence: 0, probabilities }),
      'fast — probabilities unavailable');
  }
});
