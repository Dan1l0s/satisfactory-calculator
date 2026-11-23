import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BELT_TIERS,
  PIPE_TIERS,
  planTransport,
  transportLoadsLabel,
  transportSummary,
} from '../dist/transport.js';

test('all belt and pipe tiers expose their in-game per-minute capacities', () => {
  assert.deepEqual(
    BELT_TIERS.map((t) => t.capacity),
    [60, 120, 270, 480, 780, 1200],
  );
  assert.deepEqual(
    PIPE_TIERS.map((t) => t.capacity),
    [300, 600],
  );
  for (const tier of BELT_TIERS) {
    const plan = planTransport('solid', tier.capacity, { beltTier: tier.tier });
    assert.equal(plan.count, 1);
    assert.equal(plan.lastLoad, tier.capacity);
  }
});

test('1400 screws/min at Mk.5 requires two belts loaded 780 + 620', () => {
  const plan = planTransport({ form: 'solid' }, 1400);
  assert.equal(plan.kind, 'belt');
  assert.equal(plan.tier, 5);
  assert.equal(plan.capacity, 780);
  assert.equal(plan.count, 2);
  assert.equal(plan.fullCount, 1);
  assert.equal(plan.lastLoad, 620);
  assert.deepEqual(plan.loads, [780, 620]);
  assert.equal(plan.totalCapacity, 1560);
  assert.equal(plan.spareCapacity, 160);
  assert.equal(plan.utilization, 1400 / 1560);
  assert.equal(plan.loadsTruncated, false);
  assert.equal(plan.omittedCount, 0);
});

test('capacity boundaries never create an empty extra belt', () => {
  for (const [rate, count, lastLoad] of [
    [780, 1, 780],
    [1560, 2, 780],
    [2340, 3, 780],
    [0, 0, 0],
  ]) {
    const plan = planTransport('solid', rate);
    assert.equal(plan.count, count, `${rate}/min belt count`);
    assert.equal(plan.fullCount, count);
    assert.equal(plan.lastLoad, lastLoad);
    assert.equal(plan.spareCapacity, 0);
    assert.equal(
      plan.loads.reduce((a, b) => a + b, 0),
      rate,
    );
  }
  const noise = planTransport('solid', 1560 * (1 + Number.EPSILON * 4));
  assert.equal(noise.count, 2, 'Solver floating-point residue does not add a belt');
  const realOverflow = planTransport('solid', 780 + 1e-6);
  assert.equal(realOverflow.count, 2, 'A real positive overflow requires another belt');
  assert.ok(realOverflow.lastLoad > 0 && realOverflow.lastLoad < 2e-6);
});

test('selected maximum tier changes the split, not the production rate', () => {
  const mk4 = planTransport('solid', 1400, { beltTier: 4 });
  const mk6 = planTransport('solid', 1400, { beltTier: 6 });
  assert.deepEqual(mk4.loads, [480, 480, 440]);
  assert.deepEqual(mk6.loads, [1200, 200]);
  assert.equal(mk4.rate, 1400);
  assert.equal(mk6.rate, 1400);
  assert.equal(planTransport({}, 60).kind, 'belt', 'Items without a form are solids');
});

test('liquids and gases use their selected pipe tier independently of belts', () => {
  for (const form of ['liquid', 'gas']) {
    const mk1 = planTransport({ form }, 700, { beltTier: 6, pipeTier: 1 });
    assert.equal(mk1.kind, 'pipe');
    assert.deepEqual(mk1.loads, [300, 300, 100]);
    const mk2 = planTransport(form, 700, { beltTier: 1, pipeTier: 2 });
    assert.deepEqual(mk2.loads, [600, 100]);
    assert.equal(mk2.spareCapacity, 500);
  }
});

test('zero needs no transport and every positive rate needs at least one lane', () => {
  const zero = planTransport('solid', 0);
  assert.deepEqual(zero.loads, []);
  assert.equal(zero.utilization, 0);
  for (const rate of [Number.MIN_VALUE, 1e-12, 0.1, 1]) {
    const plan = planTransport('solid', rate);
    assert.equal(plan.count, 1);
    assert.equal(plan.fullCount, 0);
    assert.equal(plan.lastLoad, rate);
    assert.deepEqual(plan.loads, [rate]);
  }
});

test('huge flows retain the true lane count and final load with a bounded preview', () => {
  const plan = planTransport('solid', 100_000_000);
  assert.equal(plan.count, 128206);
  assert.equal(plan.fullCount, 128205);
  assert.equal(plan.lastLoad, 100);
  assert.equal(plan.totalCapacity, 100000680);
  assert.equal(plan.spareCapacity, 680);
  assert.deepEqual(plan.loads, [780, 780, 780, 780, 780, 100]);
  assert.equal(plan.loadsTruncated, true);
  assert.equal(plan.omittedCount, 128200);
  assert.equal(plan.fullCount * plan.capacity + plan.lastLoad, plan.rate);
  const exact = planTransport('solid', 780 * 10_000_000);
  assert.equal(exact.count, 10_000_000);
  assert.equal(exact.fullCount, 10_000_000);
  assert.equal(exact.loads.length, 6);
  assert.equal(exact.lastLoad, 780);
});

test('invalid inputs fail explicitly rather than producing NaN or unbounded allocation', () => {
  for (const rate of [NaN, Infinity, -Infinity, '1400', null, undefined]) {
    assert.throws(() => planTransport('solid', rate), TypeError);
  }
  assert.throws(() => planTransport('solid', -1), RangeError);
  assert.throws(() => planTransport('solid', Number.MAX_VALUE), RangeError);
  assert.throws(() => planTransport('solid', 100, { beltTier: 0 }), RangeError);
  assert.throws(() => planTransport('solid', 100, { beltTier: 7 }), RangeError);
  assert.throws(() => planTransport('liquid', 100, { pipeTier: 3 }), RangeError);
  assert.throws(() => planTransport('plasma', 100), RangeError);
});

test('labels distinguish actual loads from nominal lane capacity', () => {
  const plan = planTransport('solid', 1400);
  assert.equal(transportLoadsLabel(plan), '780 + 620 шт/мин');
  assert.match(transportSummary(plan), /2 конвейера Mk\.5/);
  assert.match(transportSummary(plan), /780 шт\/мин/);
  assert.equal(
    transportLoadsLabel(planTransport('gas', 700), { locale: 'en-US' }),
    '600 + 100 m³/min',
  );
  assert.match(transportLoadsLabel(planTransport('solid', 100_000_000)), /128\s?205 × 780 \+ 100/);
  assert.equal(transportLoadsLabel(planTransport('solid', 0)), '0 шт/мин');
});
