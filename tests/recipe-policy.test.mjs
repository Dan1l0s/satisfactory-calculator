import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { solve } from '../dist/solver.js';
import {
  recipePermission,
  effectiveDisabledRecipes,
  chooseRecipe,
  setRecipeEnabled,
  applyUnlockedRecipes,
  chooseAlternateMode,
  pinnedResourceItems,
} from '../dist/recipe-policy.js';

const data = JSON.parse(
  await readFile(new URL('../dist/data/game-data.json', import.meta.url), 'utf8'),
);
const recipes = new Map(data.recipes.map((recipe) => [recipe.id, recipe]));
const frame = 'Desc_ModularFrame_C';
const standard = 'Recipe_ModularFrame_C';
const steeled = 'Recipe_Alternate_ModularFrame_C';
const bolted = 'Recipe_Alternate_BoltedFrame_C';
const baseState = () => ({
  alternates: false,
  alternateModeChosen: true,
  resourceConversions: false,
  enabledConversions: [],
  seasonal: false,
  unlockedAlternates: null,
  enabledAlternates: [],
  disabledRecipes: [],
  recipeOverrides: {},
});
const permission = (id, state) => recipePermission(recipes.get(id), state);
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) <= 2e-5, `${label}: expected ${expected}, got ${actual}`);
const machines = (result, id) =>
  result.recipes.find((recipe) => recipe.recipeId === id)?.machines || 0;

async function solveWithPolicy(dataset, state, targets = [{ item: frame, rate: 6 }]) {
  // The policy filters individual recipes before enabling ALT support in the solver

  const resourceSettings = Object.fromEntries(
    Object.entries(state.resourceSettings || {}).map(([id, setting]) => [id, { ...setting }]),
  );
  for (const item of pinnedResourceItems(dataset, state))
    resourceSettings[item] = { ...resourceSettings[item], limit: 0 };
  const result = await solve(dataset, {
    ...state,
    targets,
    objective: 'resources',
    alternates: true,
    disabledRecipes: effectiveDisabledRecipes(dataset, state),
    resourceSettings,
  });
  assert.equal(result.status, 'optimal', result.message);
  assert.equal(result.validation.feasible, true);
  for (const run of result.recipes) {
    assert.equal(
      recipePermission(recipes.get(run.recipeId), state).enabled,
      true,
      `Solver may not run forbidden recipe ${run.recipeId}`,
    );
  }
  return result;
}

test('all unlocked and none unlocked are distinct; basic recipes remain available', () => {
  const unrestricted = { ...baseState(), alternates: true, unlockedAlternates: null };
  const none = { ...unrestricted, unlockedAlternates: [] };
  assert.equal(permission(steeled, unrestricted).enabled, true);
  assert.equal(permission(bolted, unrestricted).enabled, true);
  assert.equal(permission(steeled, none).enabled, false);
  assert.equal(permission(steeled, none).unlocked, false);
  assert.equal(permission(bolted, none).enabled, false);
  assert.equal(permission(standard, none).enabled, true);
  const one = { ...unrestricted, unlockedAlternates: [steeled] };
  assert.equal(permission(steeled, one).enabled, true);
  assert.equal(permission(bolted, one).enabled, false);
});

test('a manual pin permits only its chosen frame method even in basic mode', async () => {
  const state = { ...baseState(), disabledRecipes: [steeled, 'Recipe_Alternate_Screw_C'] };
  const before = JSON.stringify(state);
  const pinned = chooseRecipe(data, state, frame, steeled);
  assert.equal(
    JSON.stringify(state),
    before,
    'Choosing a recipe does not mutate the previous state',
  );
  assert.equal(pinned.alternates, false, 'One pin does not globally enable every alternative');
  assert.equal(permission(steeled, pinned).enabled, true);
  assert.equal(permission(standard, pinned).enabled, false);
  assert.equal(permission(bolted, pinned).enabled, false);
  assert.ok(
    pinned.disabledRecipes.includes('Recipe_Alternate_Screw_C'),
    'An unrelated manual exclusion is preserved',
  );
  assert.equal(
    pinned.disabledRecipes.includes(steeled),
    false,
    'An explicit selection lifts the selected recipe’s own exclusion',
  );

  const result = await solveWithPolicy(data, pinned);
  near(
    machines(result, steeled),
    2,
    '6 ordinary frames/min use two Steeled Frame assemblers at 3/min each',
  );
  near(machines(result, standard), 0, 'Pinned route excludes the base frame method');
  near(machines(result, bolted), 0, 'Pinned route excludes the other frame alternative');
  assert.deepEqual(
    result.recipes.filter((run) => recipes.get(run.recipeId).alternate).map((run) => run.recipeId),
    [steeled],
    'All unrelated production remains on basic recipes',
  );
});

test('disabling the used alternative clears its pin and recalculates a valid base fallback', async () => {
  const pinned = chooseRecipe(data, baseState(), frame, steeled);
  const fallback = setRecipeEnabled(data, pinned, steeled, false);
  assert.equal(fallback.recipeOverrides[frame], undefined);
  assert.ok(fallback.disabledRecipes.includes(steeled));
  assert.equal(permission(standard, fallback).enabled, true);
  assert.equal(permission(steeled, fallback).enabled, false);
  const result = await solveWithPolicy(data, fallback);
  near(
    machines(result, standard),
    3,
    '6 frames/min fall back to three basic assemblers at 2/min each',
  );
  near(machines(result, steeled), 0, 'Disabled used alternative is absent');
  assert.equal(
    result.recipes.some((run) => recipes.get(run.recipeId).alternate),
    false,
  );
});

test('an unavailable alternative cannot be pinned or silently unlock itself', () => {
  const locked = { ...baseState(), unlockedAlternates: [] };
  const before = JSON.stringify(locked);
  assert.throws(() => chooseRecipe(data, locked, frame, steeled), /открыт/);
  assert.equal(JSON.stringify(locked), before);
  assert.throws(() => chooseRecipe(data, locked, 'Desc_IronRod_C', standard), /основной продукт/);
  assert.throws(() => chooseRecipe(data, locked, frame, 'missing-recipe'), /основной продукт/);
});

test('a manual alternative ban survives importing an unlocked list and affects the solve', async () => {
  const chosen = chooseRecipe(data, baseState(), frame, steeled);
  const banned = setRecipeEnabled(data, chosen, steeled, false);
  const snapshot = JSON.stringify(banned);
  const imported = applyUnlockedRecipes(data, banned, [steeled, steeled, standard, 'unknown'], {
    source: 'save.sav',
  });
  assert.equal(JSON.stringify(banned), snapshot, 'Import does not mutate the previous plan');
  assert.deepEqual(
    imported.state.unlockedAlternates,
    [steeled],
    'Only known hard-drive alternatives are accepted, without duplicates',
  );
  assert.ok(
    imported.state.disabledRecipes.includes(steeled),
    'Unlocking does not erase an explicit exclusion',
  );
  assert.equal(imported.state.recipeImport.count, 1);
  assert.equal(imported.state.recipeImport.source, 'save.sav');
  assert.equal(permission(steeled, imported.state).unlocked, true);
  assert.equal(permission(steeled, imported.state).manuallyDisabled, true);
  assert.equal(permission(steeled, imported.state).enabled, false);
  const result = await solveWithPolicy(data, imported.state);
  near(
    machines(result, standard),
    3,
    'A newly imported unlock does not restore the manually disabled route',
  );
  near(machines(result, steeled), 0, 'Manual ban reaches the solver');
});

test('import removes only alternative pins that are no longer unlocked', () => {
  let selected = chooseRecipe(data, baseState(), frame, steeled);
  selected = chooseRecipe(data, selected, 'Desc_IronRod_C', 'Recipe_IronRod_C');
  selected = chooseRecipe(data, selected, 'Desc_IronScrew_C', 'Recipe_Alternate_Screw_C');
  const imported = applyUnlockedRecipes(data, selected, ['Recipe_Alternate_Screw_C']);
  assert.deepEqual(imported.clearedPins, [steeled]);
  assert.equal(imported.state.recipeOverrides[frame], undefined);
  assert.equal(
    imported.state.recipeOverrides.Desc_IronRod_C,
    'Recipe_IronRod_C',
    'Basic recipe pin remains valid',
  );
  assert.equal(
    imported.state.recipeOverrides.Desc_IronScrew_C,
    'Recipe_Alternate_Screw_C',
    'Still-unlocked alternative pin remains valid',
  );
  assert.equal(selected.recipeOverrides[frame], steeled, 'Previous selection is untouched');
});

test('pinning a primary silica recipe preserves useful silica co-products of alumina', async () => {
  const subset = {
    ...data,
    recipes: data.recipes.filter((recipe) =>
      ['Recipe_AluminaSolution_C', 'Recipe_Silica_C'].includes(recipe.id),
    ),
  };
  assert.equal(subset.recipes.length, 2);
  const pinned = chooseRecipe(subset, baseState(), 'Desc_Silica_C', 'Recipe_Silica_C');
  assert.equal(
    recipePermission(recipes.get('Recipe_AluminaSolution_C'), pinned).enabled,
    true,
    'Alumina has a different primary product',
  );
  const result = await solveWithPolicy(subset, pinned, [
    { item: 'Desc_AluminaSolution_C', rate: 120 },
    { item: 'Desc_Silica_C', rate: 50 },
  ]);
  near(
    machines(result, 'Recipe_AluminaSolution_C'),
    1,
    'One alumina refinery also supplies the required 50 silica',
  );
  near(
    machines(result, 'Recipe_Silica_C'),
    0,
    'The selected main method need not discard a sufficient co-product',
  );
  near(result.balance.Desc_Silica_C.produced, 50, 'Co-product balance remains intact');
  near(result.balance.Desc_Silica_C.surplus, 0, 'The co-product is used, not duplicated');
});

test('enabling one alternative in basic mode leaves unrelated alternatives disabled', () => {
  const enabled = setRecipeEnabled(data, { ...baseState(), unlockedAlternates: [] }, steeled, true);
  assert.equal(enabled.alternates, false, 'An individual exception does not switch global mode');
  assert.deepEqual(enabled.enabledAlternates, [steeled]);
  assert.deepEqual(
    enabled.disabledRecipes,
    [],
    'Global base mode creates no artificial manual bans',
  );
  assert.equal(permission(steeled, enabled).enabled, true);
  assert.equal(permission(standard, enabled).enabled, true, 'Enabling is not the same as pinning');
  const enabledAlternatives = data.recipes
    .filter((recipe) => recipe.alternate && recipePermission(recipe, enabled).enabled)
    .map((recipe) => recipe.id);
  assert.deepEqual(enabledAlternatives, [steeled]);
  assert.ok(
    enabled.unlockedAlternates.includes(steeled),
    'Explicitly enabling a recipe records it as available',
  );
});

test('a save import preserves base mode and never introduces artificial manual bans', () => {
  const previous = { ...baseState(), disabledRecipes: ['Recipe_Alternate_Screw_C'] };
  const enabled = setRecipeEnabled(data, previous, steeled, true);
  const imported = applyUnlockedRecipes(data, enabled, [
    steeled,
    bolted,
    'Recipe_Alternate_Screw_C',
  ]);
  assert.deepEqual(
    imported.state.disabledRecipes,
    ['Recipe_Alternate_Screw_C'],
    'Only the real manual exclusion survives',
  );
  assert.deepEqual(
    imported.state.enabledAlternates,
    [steeled],
    'Individual permissions survive import',
  );
  assert.equal(
    imported.state.alternates,
    false,
    'Research import never changes the chosen global mode',
  );
  assert.equal(imported.state.alternateModeChosen, true);
  assert.equal(permission(steeled, imported.state).enabled, true);
  assert.equal(permission(bolted, imported.state).unlocked, true);
  assert.equal(
    permission(bolted, imported.state).enabled,
    false,
    'A newly opened recipe still obeys base mode',
  );
  assert.equal(permission(bolted, imported.state).manuallyDisabled, false);
  const all = chooseAlternateMode(data, imported.state, true);
  assert.equal(
    permission(bolted, all).enabled,
    true,
    'Explicitly choosing ALT mode now permits the newly opened recipe',
  );
  assert.equal(
    permission('Recipe_Alternate_Screw_C', imported.state).enabled,
    false,
    'The real manual ban still wins',
  );
  assert.deepEqual(previous.enabledAlternates, [], 'Previous plan was not mutated');
});

test('unlock availability gates individual permissions and explicit disabling removes them', () => {
  const enabled = setRecipeEnabled(data, baseState(), steeled, true);
  const withoutUnlock = applyUnlockedRecipes(data, enabled, [bolted]);
  assert.deepEqual(
    withoutUnlock.state.enabledAlternates,
    [steeled],
    'Permission is retained separately from research',
  );
  assert.equal(permission(steeled, withoutUnlock.state).unlocked, false);
  assert.equal(
    permission(steeled, withoutUnlock.state).enabled,
    false,
    'An individual permission cannot bypass missing research',
  );
  const withUnlock = applyUnlockedRecipes(data, withoutUnlock.state, [steeled]);
  assert.equal(permission(steeled, withUnlock.state).enabled, true);
  const pinned = chooseRecipe(data, enabled, frame, steeled);
  const disabled = setRecipeEnabled(data, pinned, steeled, false);
  assert.deepEqual(disabled.enabledAlternates, []);
  assert.ok(disabled.disabledRecipes.includes(steeled));
  assert.equal(disabled.recipeOverrides[frame], undefined);
  assert.equal(permission(steeled, disabled).enabled, false);
});

test('clearing a pin returns selection to optimization without removing manual bans', () => {
  const state = { ...baseState(), alternates: true, disabledRecipes: [bolted] };
  const pinned = chooseRecipe(data, state, frame, steeled);
  const automatic = chooseRecipe(data, pinned, frame, null);
  assert.equal(automatic.recipeOverrides[frame], undefined);
  assert.equal(permission(standard, automatic).enabled, true);
  assert.equal(permission(steeled, automatic).enabled, true);
  assert.equal(permission(bolted, automatic).enabled, false);
  assert.ok(automatic.disabledRecipes.includes(bolted));
});

test('missing global choices never enable ALT or resource conversions by default', () => {
  assert.equal(permission(steeled, {}).enabled, false);
  assert.equal(permission('Recipe_Coal_Iron_C', {}).enabled, false);
  assert.equal(permission(standard, {}).enabled, true);
  assert.equal(
    permission('Recipe_TimeCrystal_C', {}).enabled,
    true,
    'A normal Converter recipe is not a resource conversion',
  );
  assert.equal(
    permission('Recipe_FicsiteIngot_Iron_C', {}).enabled,
    true,
    'Ficsite ingots remain available',
  );
});

test('ALT and resource-conversion permissions are independent categories', () => {
  const altMode = chooseAlternateMode(data, baseState(), true);
  assert.equal(permission(steeled, altMode).enabled, true);
  assert.equal(
    permission('Recipe_Coal_Iron_C', altMode).enabled,
    false,
    'Allowing ALT does not allow resource conversions',
  );
  const conversionMode = { ...baseState(), resourceConversions: true };
  assert.equal(permission('Recipe_Coal_Iron_C', conversionMode).enabled, true);
  assert.equal(permission('Recipe_Coal_Limestone_C', conversionMode).enabled, true);
  assert.equal(
    permission(steeled, conversionMode).enabled,
    false,
    'Allowing conversions does not allow ALT',
  );
  const banned = setRecipeEnabled(data, conversionMode, 'Recipe_Coal_Iron_C', false);
  assert.equal(
    permission('Recipe_Coal_Iron_C', banned).enabled,
    false,
    'Manual exclusion still wins over global conversion permission',
  );
});

test('enabling one resource conversion leaves all other conversions and ALT disabled', () => {
  const state = baseState();
  const enabled = setRecipeEnabled(data, state, 'Recipe_Coal_Iron_C', true);
  assert.equal(enabled.alternates, false);
  assert.equal(enabled.resourceConversions, false);
  assert.deepEqual(enabled.enabledConversions, ['Recipe_Coal_Iron_C']);
  assert.deepEqual(enabled.enabledAlternates, []);
  assert.deepEqual(enabled.disabledRecipes, []);
  assert.deepEqual(
    data.recipes
      .filter((recipe) => recipe.conversion && recipePermission(recipe, enabled).enabled)
      .map((recipe) => recipe.id),
    ['Recipe_Coal_Iron_C'],
  );
  assert.deepEqual(
    pinnedResourceItems(data, enabled),
    [],
    'Permission alone never forces conversion over mining',
  );
  const off = setRecipeEnabled(data, enabled, 'Recipe_Coal_Iron_C', false);
  assert.deepEqual(off.enabledConversions, []);
  assert.ok(off.disabledRecipes.includes('Recipe_Coal_Iron_C'));
  assert.deepEqual(state.enabledConversions, [], 'Earlier plan is unchanged');
});

test('pinning one raw conversion forces that method without changing saved extraction limits', async () => {
  const state = { ...baseState(), resourceSettings: { Desc_Coal_C: { limit: 999, purity: 2 } } };
  const pinned = chooseRecipe(data, state, 'Desc_Coal_C', 'Recipe_Coal_Iron_C');
  assert.equal(pinned.resourceConversions, false);
  assert.deepEqual(pinnedResourceItems(data, pinned), ['Desc_Coal_C']);
  assert.equal(permission('Recipe_Coal_Limestone_C', pinned).enabled, false);
  const result = await solveWithPolicy(data, pinned, [{ item: 'Desc_Coal_C', rate: 120 }]);
  near(machines(result, 'Recipe_Coal_Iron_C'), 1, 'One converter supplies 120 coal/min');
  near(
    result.resources.find((resource) => resource.item === 'Desc_Coal_C')?.rate || 0,
    0,
    'A pinned conversion cannot be bypassed by direct mining',
  );
  near(
    result.resources.find((resource) => resource.item === 'Desc_OreIron_C')?.rate || 0,
    180,
    'Closed-form iron requirement',
  );
  near(
    result.resources.find((resource) => resource.item === 'Desc_SAM_C')?.rate || 0,
    40,
    'Ten Reanimated SAM require forty raw SAM',
  );
  assert.deepEqual(
    pinned.resourceSettings.Desc_Coal_C,
    { limit: 999, purity: 2 },
    'Temporary solver override never changes saved limits',
  );
  assert.equal(
    result.recipes.some(
      (run) => recipes.get(run.recipeId).conversion && run.recipeId !== 'Recipe_Coal_Iron_C',
    ),
    false,
  );

  const unpinned = chooseRecipe(data, pinned, 'Desc_Coal_C', null);
  assert.deepEqual(pinnedResourceItems(data, unpinned), []);
  const direct = await solveWithPolicy(data, unpinned, [{ item: 'Desc_Coal_C', rate: 120 }]);
  near(
    direct.resources.find((resource) => resource.item === 'Desc_Coal_C').rate,
    120,
    'Clearing the pin restores the existing mining limit',
  );
});

test('pinnedResourceItems ignores disabled, invalid, and non-resource production pins', () => {
  const pinned = chooseRecipe(data, baseState(), 'Desc_Coal_C', 'Recipe_Coal_Iron_C');
  assert.deepEqual(
    pinnedResourceItems(data, { ...pinned, disabledRecipes: ['Recipe_Coal_Iron_C'] }),
    [],
  );
  assert.deepEqual(
    pinnedResourceItems(data, {
      ...baseState(),
      recipeOverrides: { Desc_Coal_C: 'missing', Desc_OreIron_C: 'Recipe_Coal_Iron_C' },
    }),
    [],
  );
  const ordinary = chooseRecipe(data, baseState(), 'Desc_TimeCrystal_C', 'Recipe_TimeCrystal_C');
  assert.deepEqual(pinnedResourceItems(data, ordinary), []);
});

test('ordinary Converter production still works in a basic plan', async () => {
  const result = await solveWithPolicy(data, baseState(), [
    { item: 'Desc_TimeCrystal_C', rate: 6 },
  ]);
  near(
    machines(result, 'Recipe_TimeCrystal_C'),
    1,
    'Time Crystal uses a Converter as a normal production building',
  );
  assert.equal(
    result.recipes.some((run) => recipes.get(run.recipeId).conversion),
    false,
  );
  assert.equal(
    result.recipes.some((run) => recipes.get(run.recipeId).alternate),
    false,
  );
});

test('research import preserves mode confirmation and both categories of explicit exceptions', () => {
  const pending = {
    ...baseState(),
    alternateModeChosen: false,
    enabledAlternates: [steeled],
    enabledConversions: ['Recipe_Coal_Iron_C'],
  };
  const imported = applyUnlockedRecipes(data, pending, [steeled]);
  assert.equal(imported.state.alternateModeChosen, false, 'Import is not the initial mode choice');
  assert.equal(imported.state.alternates, false);
  assert.equal(imported.state.resourceConversions, false);
  assert.deepEqual(imported.state.enabledConversions, ['Recipe_Coal_Iron_C']);
  assert.deepEqual(imported.state.enabledAlternates, [steeled]);
  const all = applyUnlockedRecipes(
    data,
    { ...pending, alternateModeChosen: true, alternates: true, resourceConversions: true },
    [],
  );
  assert.equal(all.state.alternates, true);
  assert.equal(all.state.resourceConversions, true);
  assert.equal(all.state.alternateModeChosen, true);
});
