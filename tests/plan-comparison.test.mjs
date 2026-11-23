import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  comparePlans,
  recipeForOutput,
  currentProductionForOutput,
} from '../dist/plan-comparison.js';

const data = JSON.parse(
  await readFile(new URL('../dist/data/game-data.json', import.meta.url), 'utf8'),
);
const near = (actual, expected) =>
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-7,
    `Expected ${expected}, received ${actual}`);

test('uranium rod recipes are compared at the same four rods per minute', () => {
  const item = 'Desc_NuclearFuelRod_C';
  const baseRecipe = data.recipes.find((recipe) => recipe.id === 'Recipe_NuclearFuelRod_C');
  const altRecipe = data.recipes.find((recipe) => recipe.id === 'Recipe_Alternate_NuclearFuelRod_1_C');
  const base = recipeForOutput(baseRecipe, item, 4);
  const alt = recipeForOutput(altRecipe, item, 4);
  near(base.outputs[item], 4);
  near(alt.outputs[item], 4);
  near(base.machines, 10);
  near(alt.machines, 20 / 3);
  near(base.powerMW, 550);
  near(alt.powerMW, 1100 / 3);
  assert.deepEqual(base.inputs, {
    Desc_UraniumCell_C: 200,
    Desc_SteelPlateReinforced_C: 12,
    Desc_ElectromagneticControlRod_C: 20,
  });
  near(alt.inputs.Desc_UraniumCell_C, 400 / 3);
  near(alt.inputs.Desc_ElectromagneticControlRod_C, 40 / 3);
  near(alt.inputs.Desc_CrystalOscillator_C, 4);
  near(alt.inputs.Desc_Rotor_C, 40 / 3);
  assert.equal('Desc_SteelPlateReinforced_C' in alt.inputs, false);
});

test('whole-plan comparison separates metric changes, mined inputs, imports and surplus', () => {
  const before = {
    totals: { weightedResources: 100, powerMW: 0, machines: 10 },
    resources: [
      { item: 'iron', rate: 40 },
      { itemId: 'iron', rate: 60 },
      { item: 'copper', rate: 20 },
      { item: 'water', rate: 100 },
      { item: 'coal', rate: 10 },
      { item: 'noise', rate: 1000000 },
    ],
    imports: [{ item: 'water', rate: 30 }, { item: 'water', rate: 20 }, { item: 'plastic', rate: 8 }],
    surplus: [{ item: 'water', rate: 3 }],
  };
  const after = {
    totals: { weightedResources: 75, powerMW: 30, machines: 12 },
    resources: [
      { item: 'iron', rate: 80 },
      { item: 'water', rate: 150 },
      { item: 'coal', rate: 20 },
      { item: 'sulfur', rate: 5 },
      { item: 'noise', rate: 1000000.2 },
    ],
    imports: [{ item: 'water', rate: 25 }, { item: 'rubber', rate: 8 }],
    surplus: [{ item: 'water', rate: 1 }],
  };
  const comparison = comparePlans(before, after);
  assert.deepEqual(comparison.metrics, {
    resources: { before: 100, after: 75, delta: -25, percent: -25 },
    energy: { before: 0, after: 30, delta: 30, percent: null },
    buildings: { before: 10, after: 12, delta: 2, percent: 20 },
  });
  assert.deepEqual(comparison.resourceChanges, [
    { item: 'water', before: 100, after: 150, delta: 50, percent: 50, change: 'increased' },
    { item: 'copper', before: 20, after: 0, delta: -20, percent: -100, change: 'removed' },
    { item: 'iron', before: 100, after: 80, delta: -20, percent: -20, change: 'decreased' },
    { item: 'coal', before: 10, after: 20, delta: 10, percent: 100, change: 'increased' },
    { item: 'sulfur', before: 0, after: 5, delta: 5, percent: null, change: 'added' },
  ]);
  assert.deepEqual(comparison.importChanges, [
    { item: 'water', before: 50, after: 25, delta: -25, percent: -50, change: 'decreased' },
    { item: 'plastic', before: 8, after: 0, delta: -8, percent: -100, change: 'removed' },
    { item: 'rubber', before: 0, after: 8, delta: 8, percent: null, change: 'added' },
  ]);
  assert.equal(comparison.surplusChanges.length, 1);
  assert.equal(comparison.surplusChanges[0].item, 'water');
  assert.equal(comparison.surplusChanges[0].delta, -2);
  assert.equal(before.resources.length, 6);
  assert.equal(before.imports[0].rate, 30);
});

test('an empty or unchanged plan has no artificial differences or infinite percentages', () => {
  const empty = comparePlans(null, null);
  assert.deepEqual(empty.metrics.resources, { before: 0, after: 0, delta: 0, percent: null });
  assert.deepEqual(empty.resourceChanges, []);
  assert.deepEqual(empty.importChanges, []);
  assert.deepEqual(empty.surplusChanges, []);
  const plan = {
    totals: { weightedResources: 5, powerMW: 10, machines: 2 },
    resources: [{ item: 'water', rate: 100 }],
  };
  const same = comparePlans(plan, structuredClone(plan));
  assert.equal(same.metrics.energy.delta, 0);
  assert.equal(same.metrics.energy.percent, 0);
  assert.deepEqual(same.resourceChanges, []);
});

test('current production combines primary recipes and scales their actual flows together', () => {
  const dataset = { recipes: [
    { id: 'first', outputs: { product: 2, coproduct: 1 } },
    { id: 'second', outputs: { product: 4 } },
    { id: 'unrelated', outputs: { other: 5, product: 1 } },
  ] };
  const result = { recipes: [
    { recipeId: 'first', machines: 3, inputs: { ore: 12, water: 60 }, outputs: { product: 6, coproduct: 3 }, powerMW: 30 },
    { recipeId: 'second', machines: 2, inputs: { ore: 4, acid: 8 }, outputs: { product: 8 }, powerMW: 40 },
    { recipeId: 'unrelated', machines: 100, inputs: { ore: 1000 }, outputs: { other: 500, product: 100 }, powerMW: 1000 },
  ] };
  assert.deepEqual(currentProductionForOutput(dataset, result, 'product', 7), {
    machines: 2.5,
    inputs: { ore: 8, water: 30, acid: 4 },
    outputs: { product: 7, coproduct: 1.5 },
    powerMW: 35,
  });
  assert.equal(currentProductionForOutput(dataset, result, 'coproduct', 7), null);
  assert.equal(currentProductionForOutput(dataset, null, 'product', 7), null);
  assert.equal(result.recipes[0].inputs.water, 60);
});

test('invalid comparison throughput fails before producing NaN or infinite flows', () => {
  const recipe = { inputs: { water: 100 }, outputs: { concrete: 80 }, powerMW: 30 };
  for (const output of [0, -1, NaN, Infinity, '80']) {
    assert.throws(() => recipeForOutput(recipe, 'concrete', output), RangeError);
    assert.throws(() => currentProductionForOutput({ recipes: [] }, null, 'concrete', output), RangeError);
  }
  assert.throws(() => recipeForOutput(recipe, 'missing', 80), RangeError);
  assert.throws(() => recipeForOutput({ ...recipe, outputs: { concrete: 0 } }, 'concrete', 80), RangeError);
  assert.throws(() => recipeForOutput({ ...recipe, inputs: { water: NaN } }, 'concrete', 80), RangeError);
  assert.throws(() => recipeForOutput({ inputs: { water: 1e308 }, outputs: { concrete: 1 }, powerMW: 30 }, 'concrete', 2), RangeError);
});
