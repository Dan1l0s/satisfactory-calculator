import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOURCE_AVAILABILITY,
  RESOURCE_WEIGHT_METADATA,
  getResourceWeights,
  getResourceWeightDetails,
} from '../dist/resource-weights.js';

test('Verified default-map extraction accounts for node purity and oil wells', () => {
  for (const row of Object.values(RESOURCE_AVAILABILITY)) {
    if (row.form !== 'solid') continue;
    const { impure, normal, pure } = row.nodes;
    assert.equal(
      row.maxRate,
      impure * 300 + normal * 600 + pure * 1200,
      `${row.itemId}: Mk.3 250% node counts`,
    );
  }
  assert.equal(RESOURCE_AVAILABILITY.Desc_Stone_C.maxRate, 69300);
  for (const itemId of ['Desc_LiquidOil_C', 'Desc_NitrogenGas_C', 'Desc_Water_C']) {
    const row = RESOURCE_AVAILABILITY[itemId],
      { impure, normal, pure } = row.wellSatellites;
    assert.equal(row.wellMaxRate, impure * 75 + normal * 150 + pure * 300);
  }
  const oil = RESOURCE_AVAILABILITY.Desc_LiquidOil_C;
  assert.equal(
    oil.nodeMaxRate,
    oil.nodes.impure * 150 + oil.nodes.normal * 300 + oil.nodes.pure * 600,
  );
  assert.equal(oil.maxRate, oil.nodeMaxRate + oil.wellMaxRate);
  assert.equal(
    RESOURCE_AVAILABILITY.Desc_Water_C.maxRate,
    null,
    'Well capacity must not become a surface-water cap',
  );
  assert.equal(RESOURCE_WEIGHT_METADATA.gameVersion, '1.2.5.0');
});

test('Scarcity weights normalize to iron and equal weights remain selectable', () => {
  const weights = getResourceWeights();
  assert.equal(weights.Desc_OreIron_C, 1);
  assert.equal(weights.Desc_OreUranium_C, 92100 / 2100);
  assert.equal(weights.Desc_Sulfur_C, 92100 / 10800);
  assert.equal(weights.Desc_NitrogenGas_C, 92100 / 12000);
  assert.equal(weights.Desc_Water_C, 0);
  const equal = getResourceWeights(undefined, { profile: 'equal' });
  for (const [item, weight] of Object.entries(equal))
    assert.equal(weight, item === 'Desc_Water_C' ? 0 : 1);
});

test('Manual zero overrides win, unknown resources stay explicitly neutral', () => {
  const resources = [{ itemId: 'Desc_Sulfur_C' }, 'Desc_Water_C', 'Mod_MysteryOre_C'];
  const overrides = { Desc_Sulfur_C: 0, Desc_Water_C: 3 };
  assert.deepEqual(getResourceWeights(resources, { overrides }), {
    Desc_Sulfur_C: 0,
    Desc_Water_C: 3,
    Mod_MysteryOre_C: 1,
  });
  assert.equal(getResourceWeightDetails('Desc_Sulfur_C', { overrides }).origin, 'manual');
  const unknown = getResourceWeightDetails('Mod_MysteryOre_C');
  assert.equal(unknown.origin, 'fallback');
  assert.equal(unknown.maxRate, null);
  assert.equal(unknown.knownAvailability, false);
  assert.throws(
    () => getResourceWeights(resources, { overrides: { Desc_Sulfur_C: -1 } }),
    RangeError,
  );
  assert.throws(() => getResourceWeights(resources, { profile: 'invented' }), RangeError);
});
