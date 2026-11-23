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
const uraniumRod = 'Desc_NuclearFuelRod_C';
const uraniumWaste = 'Desc_NuclearWaste_C';
const plutoniumRod = 'Desc_PlutoniumFuelRod_C';
const plutoniumWaste = 'Desc_PlutoniumWaste_C';
const water = 'Desc_Water_C';
const uraniumBurn = 'Recipe_UraniumWaste_C';
const plutoniumBurn = 'Recipe_PlutoniumWaste_C';
const weights = getResourceWeights(data.resources, { profile: 'scarce' });
const resourceSettings = Object.fromEntries(data.resources.map((resource) => [
  resource.itemId,
  { purity: 1, weight: weights[resource.itemId] },
]));

function options(item = plutoniumRod, rate = 1, overrides = {}) {
  return {
    targets: [{ item, rate }],
    objective: 'resources',
    alternates: true,
    disabledRecipes: effectiveDisabledRecipes(data, {
      alternates: false,
      resourceConversions: false,
      seasonal: false,
    }),
    seasonal: false,
    resourceSettings,
    minerTier: 3,
    clock: 100,
    minerClock: 100,
    imports: [],
    ...overrides,
  };
}

function near(actual, expected, label) {
  const tolerance = Math.max(2e-5, Math.abs(expected) * 1e-8);
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function feasible(result) {
  assert.equal(result.status, 'optimal', result.message);
  assert.equal(result.validation.feasible, true);
  near(result.validation.maxViolation, 0, 'Constraint violations');
  for (const [item, balance] of Object.entries(result.balance)) {
    near(
      balance.produced + balance.imported + balance.extracted,
      balance.consumed + balance.target + balance.surplus,
      `Conservation of ${item}`,
    );
  }
  assert.ok(result.resources.every((row) => row.type !== 'external'));
  near(result.balance[uraniumWaste].extracted, 0, 'Uranium waste is not mined');
  near(result.balance[plutoniumWaste].extracted, 0, 'Plutonium waste is not mined');
  const consumption = [...result.recipes, ...result.resources]
    .reduce((total, row) => total + row.powerMW, 0);
  const generation = result.recipes.reduce((total, row) => total + (row.generationMW || 0), 0);
  near(result.totals.powerMW, consumption, 'Gross consumption');
  near(result.totals.generationMW, generation, 'Gross generation');
  near(result.totals.netPowerMW, consumption - generation, 'Net grid requirement');
  return result;
}

function checkReactor(result, recipeId, machines, fuel, fuelRate, waste, wasteRate) {
  const row = result.recipes.find((recipe) => recipe.recipeId === recipeId);
  assert.ok(row, `${recipeId} is present`);
  near(row.machines, machines, `${recipeId} reactors`);
  near(row.inputs[fuel], fuelRate, `${recipeId} fuel consumption`);
  near(row.inputs[water], machines * 240, `${recipeId} cooling water`);
  near(row.outputs[waste], wasteRate, `${recipeId} waste production`);
  near(row.generationMW, machines * 2500, `${recipeId} generated power`);
  near(row.powerMW, 0, `${recipeId} own power consumption`);
  return row;
}

test('Nuclear waste processes retain fuel, cooling water and generation at 100%', () => {
  for (const [id, fuel, fuelRate, waste, wasteRate, seconds] of [
    [uraniumBurn, uraniumRod, 0.2, uraniumWaste, 10, 300],
    [plutoniumBurn, plutoniumRod, 0.1, plutoniumWaste, 1, 600],
  ]) {
    const recipe = data.recipes.find((entry) => entry.id === id);
    assert.ok(recipe);
    assert.equal(recipe.generator, true);
    assert.equal(recipe.alternate, false);
    assert.equal(recipe.buildingId, 'Build_GeneratorNuclear_C');
    assert.deepEqual(recipe.inputs, { [fuel]: fuelRate, [water]: 240 });
    assert.deepEqual(recipe.outputs, { [waste]: wasteRate });
    assert.equal(recipe.time, seconds);
    assert.equal(recipe.powerMW, 0);
    assert.equal(recipe.generationMW, 2500);
  }
});

for (const objective of ['resources', 'energy', 'buildings']) {
  test(`Plutonium fuel rods can be made from ore with the ${objective} objective`, async () => {
    const result = feasible(await solve(data, options(plutoniumRod, 1, { objective })));
    assert.equal(result.imports.length, 0);
    checkReactor(result, uraniumBurn, 20, uraniumRod, 4, uraniumWaste, 200);
    assert.ok(!result.recipes.some((row) => row.recipeId === plutoniumBurn));
    near(result.balance[uraniumRod].produced, 4, 'Uranium rods manufactured');
    near(result.balance[uraniumRod].consumed, 4, 'Uranium rods burned');
    near(result.balance[uraniumWaste].consumed, 200, 'Uranium waste processed');
    near(result.balance[uraniumWaste].surplus, 0, 'No extra uranium waste');
    near(result.balance[plutoniumRod].produced, 1, 'Plutonium rod output');
    near(result.totals.generationMW, 50000, 'Twenty uranium reactors generate power');
    if (objective === 'energy') {
      near(result.objective.value, result.totals.powerMW, 'Energy objective uses gross demand');
      assert.ok(result.objective.value > 0, 'Generation does not reward extra fuel burning');
    }

    const flow = buildFlowData(data, result);
    assert.deepEqual(flow.diagnostics, []);
    const reactorId = `recipe:${uraniumBurn}`;
    const waterEdges = flow.edges.filter((edge) => edge.target === reactorId && edge.itemId === water);
    assert.ok(waterEdges.length > 0);
    assert.ok(waterEdges.every((edge) => edge.form === 'liquid'));
    near(waterEdges.reduce((total, edge) => total + edge.rate, 0), 4800, 'Cooling water reaches reactor node');
    near(
      flow.edges.filter((edge) => edge.source === reactorId && edge.itemId === uraniumWaste)
        .reduce((total, edge) => total + edge.rate, 0),
      200,
      'All reactor waste reaches processing nodes',
    );
  });
}

for (const suppliedWaste of [100, 200]) {
  test(`Existing uranium waste supply of ${suppliedWaste}/min replaces only the necessary reactors`, async () => {
    const result = feasible(await solve(data, options(plutoniumRod, 1, {
      imports: [{ item: uraniumWaste, rate: suppliedWaste }],
    })));
    near(result.balance[uraniumWaste].imported, suppliedWaste, 'Existing waste supply used');
    near(result.balance[uraniumWaste].consumed, 200, 'Total waste demand');
    if (suppliedWaste === 200) {
      assert.ok(!result.recipes.some((row) => row.recipeId === uraniumBurn));
      near(result.totals.generationMW, 0, 'Existing station is outside this plan');
    } else {
      checkReactor(result, uraniumBurn, 10, uraniumRod, 2, uraniumWaste, 100);
      near(result.totals.generationMW, 25000, 'Only missing waste is generated');
    }
  });
}

test('Uranium waste target requires a real reactor instead of a free external source', async () => {
  const result = feasible(await solve(data, options(uraniumWaste, 10)));
  assert.equal(result.imports.length, 0);
  checkReactor(result, uraniumBurn, 1, uraniumRod, 0.2, uraniumWaste, 10);
  near(result.balance[uraniumRod].produced, 0.2, 'Required fuel is manufactured');
  near(result.balance[uraniumWaste].target, 10, 'Waste target');
});

test('Plutonium waste production includes both uranium and plutonium reactors', async () => {
  const result = feasible(await solve(data, options(plutoniumWaste, 1)));
  checkReactor(result, uraniumBurn, 2, uraniumRod, 0.4, uraniumWaste, 20);
  checkReactor(result, plutoniumBurn, 1, plutoniumRod, 0.1, plutoniumWaste, 1);
  near(result.balance[plutoniumRod].produced, 0.1, 'Plutonium fuel manufactured');
  near(result.balance[plutoniumRod].consumed, 0.1, 'Plutonium fuel burned');
  near(result.totals.generationMW, 7500, 'Both reactor types contribute generation');
});

test('Disabling reactors keeps nuclear waste supply limits binding', async () => {
  const blocked = options(plutoniumRod, 1);
  blocked.disabledRecipes.push(uraniumBurn, plutoniumBurn);
  const withoutSupply = await solve(data, blocked);
  assert.equal(withoutSupply.status, 'infeasible');
  const insufficientSupply = await solve(data, {
    ...blocked,
    imports: [{ item: uraniumWaste, rate: 199.99 }],
  });
  assert.equal(insufficientSupply.status, 'infeasible');
  const supplied = feasible(await solve(data, {
    ...blocked,
    imports: [{ item: uraniumWaste, rate: 200 }],
  }));
  assert.ok(!supplied.recipes.some((row) => row.recipeId === uraniumBurn || row.recipeId === plutoniumBurn));
  near(supplied.balance[uraniumWaste].imported, 200, 'Explicit supply restores feasibility');
});
