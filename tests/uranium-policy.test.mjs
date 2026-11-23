import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { solve } from '../dist/solver.js';
import { getResourceWeights } from '../dist/resource-weights.js';
import {
  recipePermission,
  effectiveDisabledRecipes,
  setRecipeEnabled,
  chooseRecipe,
  applyUnlockedRecipes,
  pinnedResourceItems,
} from '../dist/recipe-policy.js';

const data = JSON.parse(
  await readFile(new URL('../dist/data/game-data.json', import.meta.url), 'utf8'),
);
const recipes = new Map(data.recipes.map((recipe) => [recipe.id, recipe]));
const uranium = 'Desc_OreUranium_C',
  fuelRod = 'Desc_NuclearFuelRod_C';
const uraniumConversion = 'Recipe_Uranium_Bauxite_C',
  alternateRod = 'Recipe_Alternate_NuclearFuelRod_1_C';
const baseState = () => ({
  alternates: false,
  resourceConversions: false,
  seasonal: false,
  enabledAlternates: [],
  enabledConversions: [],
  unlockedAlternates: null,
  disabledRecipes: [],
  recipeOverrides: {},
  resourceSettings: {},
  resourceProfile: 'scarce',
});
const near = (actual, expected, description) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-4,
    `${description}: expected ${expected}, received ${actual}`,
  );
const extraction = (result, item) =>
  result.resources
    ?.filter((row) => row.item === item)
    .reduce((total, row) => total + row.rate, 0) || 0;
const usedRecipes = (result) =>
  result.recipes.filter((row) => row.machines > 1e-7).map((row) => recipes.get(row.recipeId));
const usedConversions = (result) =>
  usedRecipes(result)
    .filter((recipe) => recipe.conversion)
    .map((recipe) => recipe.id);
const usedAlternatives = (result) =>
  usedRecipes(result)
    .filter((recipe) => recipe.alternate)
    .map((recipe) => recipe.id);

function solverOptions(
  state,
  targets,
  {
    profile = state.resourceProfile || 'scarce',
    objective = 'resources',
    resourceSettings = {},
  } = {},
) {
  const weights = getResourceWeights(data.resources, { profile });
  const settings = Object.fromEntries(
    data.resources.map((resource) => [
      resource.itemId,
      {
        purity: 1,
        weight: weights[resource.itemId],
        ...state.resourceSettings?.[resource.itemId],
        ...resourceSettings[resource.itemId],
      },
    ]),
  );
  // Apply conversion pins to solver limits without changing saved extraction settings

  for (const item of pinnedResourceItems(data, state))
    settings[item] = { ...settings[item], limit: 0 };
  return {
    targets,
    objective,
    alternates: true,
    seasonal: state.seasonal === true,
    disabledRecipes: effectiveDisabledRecipes(data, state),
    resourceSettings: settings,
    minerTier: 3,
    minerClock: 100,
    clock: 100,
    imports: [],
  };
}

async function run(state, targets, options) {
  const result = await solve(data, solverOptions(state, targets, options));
  if (result.status === 'optimal') {
    assert.equal(result.validation.feasible, true);
    for (const recipe of usedRecipes(result))
      assert.equal(
        recipePermission(recipe, state).enabled,
        true,
        `Forbidden recipe reached the solver: ${recipe.id}`,
      );
  }
  return result;
}

test('fresh and basic policies produce 120 uranium by mining, not by transmutation', async () => {
  for (const state of [{}, baseState()]) {
    const result = await run(state, [{ item: uranium, rate: 120 }]);
    assert.equal(result.status, 'optimal', result.message);
    near(extraction(result, uranium), 120, 'Direct uranium extraction');
    const miner = result.resources.find((row) => row.item === uranium);
    near(miner.capacity, 240, 'Normal Mk.3 capacity at 100%');
    near(miner.machines, 0.5, 'Half a normal Mk.3 miner');
    near(result.totals.powerMW, 22.5, 'Only the uranium miner consumes power');
    assert.equal(result.recipes.length, 0);
    near(extraction(result, 'Desc_OreBauxite_C'), 0, 'No bauxite route');
    near(extraction(result, 'Desc_OreCopper_C'), 0, 'No copper-to-bauxite route');
    near(extraction(result, 'Desc_SAM_C'), 0, 'No unrequested SAM chain');
  }
});

test('four fuel rods on basic recipes mine 400 uranium with scarce or equal weights', async () => {
  for (const profile of ['scarce', 'equal']) {
    const result = await run(baseState(), [{ item: fuelRod, rate: 4 }], { profile });
    assert.equal(result.status, 'optimal', result.message);
    near(extraction(result, uranium), 400, `${profile}: standard fuel chain needs 400 uranium`);
    near(result.balance[uranium].consumed, 400, `${profile}: uranium material balance`);
    near(result.totals.powerMW, 2367.291666666667, `${profile}: base-chain power`);
    assert.deepEqual(usedAlternatives(result), []);
    assert.deepEqual(usedConversions(result), []);
    assert.ok(result.recipes.some((row) => row.recipeId === 'Recipe_NuclearFuelRod_C'));
  }
});

test('one explicitly allowed fuel-rod alternative leaves every other alternative and conversion off', async () => {
  const state = setRecipeEnabled(data, baseState(), alternateRod, true);
  assert.equal(state.alternates, false);
  assert.equal(state.resourceConversions, false);
  const result = await run(state, [{ item: fuelRod, rate: 4 }]);
  assert.equal(result.status, 'optimal', result.message);
  assert.deepEqual(usedAlternatives(result), [alternateRod]);
  assert.deepEqual(usedConversions(result), []);
  near(
    extraction(result, uranium),
    800 / 3,
    'An alternative fuel rod with standard cells mines 266⅔ uranium',
  );
  assert.ok(result.recipes.some((row) => row.recipeId === 'Recipe_UraniumCell_C'));
  assert.equal(
    result.recipes.some((row) => row.recipeId === 'Recipe_Alternate_UraniumCell_1_C'),
    false,
  );
});

test('one explicitly allowed uranium conversion uses mined bauxite and SAM without enabling copper conversion', async () => {
  const state = setRecipeEnabled(data, baseState(), uraniumConversion, true);
  assert.equal(state.resourceConversions, false, 'One exception is not global permission');
  assert.deepEqual(state.enabledConversions, [uraniumConversion]);
  assert.deepEqual(
    pinnedResourceItems(data, state),
    [],
    'Permission alone does not forbid direct mining',
  );
  const result = await run(state, [{ item: uranium, rate: 120 }]);
  assert.equal(result.status, 'optimal', result.message);
  assert.deepEqual(usedConversions(result), [uraniumConversion]);
  assert.deepEqual(usedAlternatives(result), []);
  near(extraction(result, uranium), 0, 'Scarcity prefers the explicitly permitted conversion');
  near(extraction(result, 'Desc_OreBauxite_C'), 480, 'Bauxite is actually mined');
  near(extraction(result, 'Desc_SAM_C'), 40, 'Ten reanimated SAM require forty raw SAM');
  near(extraction(result, 'Desc_OreCopper_C'), 0, 'Copper-to-bauxite is still forbidden');
  near(result.totals.powerMW, 348.8333333333333, 'Only the permitted conversion chain is built');
  const equal = await run(state, [{ item: uranium, rate: 120 }], { profile: 'equal' });
  assert.equal(equal.status, 'optimal', equal.message);
  near(extraction(equal, uranium), 120, 'An allowed conversion is optional when mining is cheaper');
  assert.equal(equal.recipes.length, 0);
});

test('uranium limits remain hard constraints and never silently enable conversions', async () => {
  for (const limit of [0, 60]) {
    const result = await run(baseState(), [{ item: uranium, rate: 120 }], {
      resourceSettings: { [uranium]: { limit } },
    });
    assert.equal(
      result.status,
      'infeasible',
      `A ${limit}/min uranium limit cannot satisfy 120/min without permission for conversion`,
    );
  }
});

test('uranium node purity changes miners and power, not ore demand or scarcity weight', async () => {
  for (const [purity, capacity, machines, power] of [
    [0.5, 120, 1, 45],
    [1, 240, 0.5, 22.5],
    [2, 480, 0.25, 11.25],
  ]) {
    const result = await run(baseState(), [{ item: uranium, rate: 120 }], {
      resourceSettings: { [uranium]: { purity } },
    });
    assert.equal(result.status, 'optimal', result.message);
    const miner = result.resources.find((row) => row.item === uranium);
    near(miner.rate, 120, `${purity}: unchanged ore demand`);
    near(miner.capacity, capacity, `${purity}: extraction capacity`);
    near(miner.machines, machines, `${purity}: fractional miner equivalents`);
    near(result.totals.powerMW, power, `${purity}: miner power`);
    near(
      result.totals.weightedResources,
      (120 * 92100) / 2100,
      `${purity}: unchanged global-scarcity cost`,
    );
    assert.equal(result.recipes.length, 0);
  }
});

test('an explicit conversion pin replaces mining even for equal weights or the energy objective', async () => {
  const original = {
    ...baseState(),
    resourceSettings: { [uranium]: { limit: 60 }, Desc_OreBauxite_C: { limit: 600 } },
  };
  const state = chooseRecipe(data, original, uranium, uraniumConversion);
  const snapshot = JSON.stringify(state);
  assert.deepEqual(pinnedResourceItems(data, state), [uranium]);
  for (const objective of ['resources', 'energy']) {
    const options = solverOptions(state, [{ item: uranium, rate: 120 }], {
      profile: 'equal',
      objective,
    });
    assert.equal(options.resourceSettings[uranium].limit, 0);
    assert.equal(
      options.resourceSettings.Desc_OreBauxite_C.limit,
      600,
      'Other resource limits are preserved',
    );
    const result = await solve(data, options);
    assert.equal(result.status, 'optimal', result.message);
    assert.equal(result.validation.feasible, true);
    near(extraction(result, uranium), 0, `${objective}: a pin replaces direct uranium mining`);
    near(extraction(result, 'Desc_OreBauxite_C'), 480, `${objective}: selected converter input`);
    near(extraction(result, 'Desc_SAM_C'), 40, `${objective}: selected converter SAM input`);
    assert.deepEqual(usedConversions(result), [uraniumConversion]);
    assert.deepEqual(usedAlternatives(result), []);
  }
  assert.equal(
    JSON.stringify(state),
    snapshot,
    'Applying the pin to solver options cannot overwrite saved limits',
  );
  assert.equal(state.resourceSettings[uranium].limit, 60);
});

test('importing unlocked uranium alternatives does not apply them to the next calculation', async () => {
  const state = applyUnlockedRecipes(
    data,
    baseState(),
    [alternateRod, 'Recipe_Alternate_UraniumCell_1_C'],
    { saveName: 'test.sav' },
  ).state;
  assert.equal(state.alternates, false);
  assert.equal(state.resourceConversions, false);
  assert.deepEqual(state.enabledAlternates, []);
  assert.equal(recipePermission(recipes.get(alternateRod), state).unlocked, true);
  assert.equal(recipePermission(recipes.get(alternateRod), state).enabled, false);
  const result = await run(state, [{ item: fuelRod, rate: 4 }]);
  assert.equal(result.status, 'optimal', result.message);
  near(
    extraction(result, uranium),
    400,
    'Unlocked-but-unselected alternatives leave the basic uranium chain unchanged',
  );
  assert.deepEqual(usedAlternatives(result), []);
  assert.deepEqual(usedConversions(result), []);
});
