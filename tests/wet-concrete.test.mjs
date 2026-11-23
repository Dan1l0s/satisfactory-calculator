import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { solve } from '../dist/solver.js';
import { buildFlowData } from '../dist/graph.js';
import { effectiveDisabledRecipes } from '../dist/recipe-policy.js';
import { getResourceWeights } from '../dist/resource-weights.js';

const data = JSON.parse(
  await readFile(new URL('../dist/data/game-data.json', import.meta.url), 'utf8'),
);
const wetConcrete = 'Recipe_Alternate_WetConcrete_C';
const limestone = 'Desc_Stone_C';
const water = 'Desc_Water_C';
const concrete = 'Desc_Cement_C';
const recipe = data.recipes.find((entry) => entry.id === wetConcrete);
const state = {
  alternates: false,
  resourceConversions: false,
  seasonal: false,
  recipeOverrides: { [concrete]: wetConcrete },
};
const weights = getResourceWeights(data.resources, { profile: 'scarce' });
const resourceSettings = Object.fromEntries(
  data.resources.map((resource) => [
    resource.itemId,
    { purity: 1, weight: weights[resource.itemId] },
  ]),
);
const near = (actual, expected, description) =>
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-7,
    `${description}: expected ${expected}, received ${actual}`,
  );

test('Wet Concrete stores per-minute rates for one refinery at 100%', () => {
  assert.ok(recipe);
  assert.equal(recipe.alternate, true);
  assert.equal(recipe.buildingId, 'Build_OilRefinery_C');
  assert.equal(recipe.time, 3);
  assert.deepEqual(recipe.inputs, { [limestone]: 120, [water]: 100 });
  assert.deepEqual(recipe.outputs, { [concrete]: 80 });
  assert.equal(recipe.powerMW, 30);
  assert.equal(data.items.find((item) => item.id === water).form, 'liquid');
});

for (const [output, machines, stoneInput, waterInput] of [
  [40, 0.5, 60, 50],
  [80, 1, 120, 100],
  [344, 4.3, 516, 430],
]) {
  test(`Wet Concrete at ${output}/min uses ${machines} refinery equivalents and matching flows`, async () => {
    const result = await solve(data, {
      targets: [{ item: concrete, rate: output }],
      objective: 'resources',
      alternates: true,
      disabledRecipes: effectiveDisabledRecipes(data, state),
      seasonal: false,
      resourceSettings,
      minerTier: 3,
      clock: 100,
      minerClock: 100,
      imports: [],
    });
    assert.equal(result.status, 'optimal', result.message);
    assert.equal(result.validation.feasible, true);
    near(result.validation.maxBalanceError, 0, 'Material balance');
    near(result.validation.maxViolation, 0, 'Constraint violations');
    assert.deepEqual(result.recipes.map((row) => row.recipeId), [wetConcrete]);
    const row = result.recipes[0];
    near(row.machines, machines, 'Fractional refinery count');
    near(row.inputs[limestone], stoneInput, 'Refinery limestone input');
    near(row.inputs[water], waterInput, 'Refinery water input in m3/min');
    near(row.outputs[concrete], output, 'Refinery concrete output');
    near(result.totals.productionPowerMW, machines * 30, 'Refinery power');
    assert.equal(result.surplus.length, 0);

    for (const [item, rate] of [
      [limestone, stoneInput],
      [water, waterInput],
    ]) {
      near(
        result.resources.filter((resource) => resource.item === item)
          .reduce((sum, resource) => sum + resource.rate, 0),
        rate,
        `Fresh input ${item}`,
      );
      near(result.balance[item].extracted, rate, `Extracted ${item}`);
      near(result.balance[item].consumed, rate, `Consumed ${item}`);
    }
    near(result.balance[concrete].produced, output, 'Produced concrete');
    near(result.balance[concrete].target, output, 'Requested concrete');

    const flow = buildFlowData(data, result);
    assert.deepEqual(flow.diagnostics, []);
    const nodeId = `recipe:${wetConcrete}`;
    const node = flow.nodes.find((candidate) => candidate.id === nodeId);
    assert.ok(node);
    near(node.data.machines, machines, 'Graph refinery count');
    const inputs = flow.edges.filter((edge) => edge.target === nodeId);
    const outputs = flow.edges.filter((edge) => edge.source === nodeId);
    assert.equal(inputs.length, 2);
    assert.equal(outputs.length, 1);
    for (const [item, rate, form] of [
      [limestone, stoneInput, 'solid'],
      [water, waterInput, 'liquid'],
    ]) {
      const edge = inputs.find((candidate) => candidate.itemId === item);
      assert.ok(edge);
      assert.equal(edge.source, `resource:${item}`);
      assert.equal(edge.form, form);
      near(edge.rate, rate, `Graph input ${item}`);
    }
    assert.equal(outputs[0].itemId, concrete);
    assert.equal(outputs[0].target, `target:${concrete}`);
    near(outputs[0].rate, output, 'Graph concrete output');
  });
}
