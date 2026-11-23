import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRecipeMode } from '../dist/recipe-mode.js';
import { chooseAlternateMode, recipePermission } from '../dist/recipe-policy.js';

const pending = { alternates: false, alternateModeChosen: false };
const chosen = (alternates) => ({ alternates, alternateModeChosen: true });

test('fresh state and deliberately unchosen plans require the initial mode choice', () => {
  for (const source of ['localStorage', 'local', 'json', 'hash']) {
    for (const raw of [
      undefined,
      null,
      {},
      [],
      { alternates: true, alternateModeChosen: false },
      { alternates: false, alternateModeChosen: false },
    ]) {
      assert.deepEqual(normalizeRecipeMode(raw, { source }), pending);
    }
  }
});

test('confirmed modern plans retain either choice from every supported source', () => {
  for (const source of ['localStorage', 'local', 'json', 'hash']) {
    for (const alternates of [false, true]) {
      assert.deepEqual(normalizeRecipeMode(chosen(alternates), { source }), chosen(alternates));
    }
  }
});

test('the old local true default is not mistaken for a decision, but local false is retained', () => {
  assert.deepEqual(normalizeRecipeMode({ alternates: true }), pending);
  assert.deepEqual(normalizeRecipeMode({ alternates: false }), chosen(false));
  assert.deepEqual(
    normalizeRecipeMode({
      alternates: true,
      disabledRecipes: ['an-exclusion'],
      recipeOverrides: { item: 'a-recipe' },
    }),
    pending,
    'Unrelated editing does not prove global ALT consent',
  );
});

test('opening a legacy JSON or shared plan honors its explicit boolean policy', () => {
  for (const source of ['json', 'hash']) {
    assert.deepEqual(normalizeRecipeMode({ alternates: true }, { source }), chosen(true));
    assert.deepEqual(normalizeRecipeMode({ alternates: false }, { source }), chosen(false));
    assert.deepEqual(
      normalizeRecipeMode({ targets: [] }, { source }),
      pending,
      'Missing policy is not an explicit choice',
    );
  }
});

test('invalid markers and truthy strings never silently enable alternatives', () => {
  for (const alternates of [undefined, null, 'true', 'false', 1, 0, {}, []]) {
    assert.deepEqual(
      normalizeRecipeMode({ alternates, alternateModeChosen: true }, { source: 'json' }),
      pending,
    );
  }
  for (const alternateModeChosen of [undefined, null, 'true', 1]) {
    assert.deepEqual(
      normalizeRecipeMode({ alternates: true, alternateModeChosen }, { source: 'hash' }),
      pending,
    );
  }
  assert.throws(() => normalizeRecipeMode({}, { source: 'unknown' }), RangeError);
});

test('confirmed choices survive serialization and reopening without another prompt', () => {
  for (const alternates of [true, false]) {
    const saved = JSON.parse(
      JSON.stringify({ ...chosen(alternates), enabledAlternates: ['one-recipe'] }),
    );
    assert.deepEqual(normalizeRecipeMode(saved, { source: 'localStorage' }), chosen(alternates));
  }
});

const dataset = {
  recipes: [
    { id: 'base', outputs: { product: 2 }, alternate: false, conversion: false },
    { id: 'alt', outputs: { product: 3 }, alternate: true, conversion: false },
    { id: 'convert', outputs: { ore: 120 }, alternate: false, conversion: true },
    { id: 'ordinary', outputs: { component: 5 }, alternate: false, conversion: false },
  ],
};

test('choosing basic clears both exception categories and special pins, while preserving other decisions', () => {
  const state = {
    alternates: true,
    alternateModeChosen: false,
    resourceConversions: true,
    enabledAlternates: ['alt'],
    enabledConversions: ['convert'],
    recipeOverrides: { product: 'alt', ore: 'convert', component: 'ordinary' },
    disabledRecipes: ['base'],
    unlockedAlternates: ['alt'],
    resourceSettings: { ore: { limit: 100 } },
  };
  const before = JSON.stringify(state);
  const basic = chooseAlternateMode(dataset, state, false);
  assert.deepEqual(normalizeRecipeMode(basic), chosen(false));
  assert.equal(basic.resourceConversions, false);
  assert.deepEqual(basic.enabledAlternates, []);
  assert.deepEqual(basic.enabledConversions, []);
  assert.deepEqual(basic.recipeOverrides, { component: 'ordinary' });
  assert.deepEqual(basic.disabledRecipes, ['base']);
  assert.deepEqual(basic.unlockedAlternates, ['alt']);
  assert.deepEqual(basic.resourceSettings, { ore: { limit: 100 } });
  assert.equal(recipePermission(dataset.recipes[1], basic).enabled, false);
  assert.equal(recipePermission(dataset.recipes[2], basic).enabled, false);
  assert.equal(recipePermission(dataset.recipes[3], basic).enabled, true);
  assert.equal(JSON.stringify(state), before, 'Mode choice does not mutate the previous plan');
});

test('choosing ALT confirms that mode without authorizing conversions or clearing bans', () => {
  const state = {
    ...pending,
    resourceConversions: false,
    enabledConversions: [],
    enabledAlternates: [],
    unlockedAlternates: ['alt'],
    disabledRecipes: ['base'],
    recipeOverrides: { component: 'ordinary' },
  };
  const withAlternatives = chooseAlternateMode(dataset, state, true);
  assert.deepEqual(normalizeRecipeMode(withAlternatives), chosen(true));
  assert.equal(withAlternatives.resourceConversions, false);
  assert.deepEqual(withAlternatives.disabledRecipes, ['base']);
  assert.deepEqual(withAlternatives.recipeOverrides, { component: 'ordinary' });
  assert.equal(recipePermission(dataset.recipes[1], withAlternatives).enabled, true);
  assert.equal(recipePermission(dataset.recipes[2], withAlternatives).enabled, false);
  assert.throws(() => chooseAlternateMode(dataset, state, 'true'), TypeError);
});
