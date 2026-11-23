import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { solve } from '../dist/solver.js';

const data = JSON.parse(
  await readFile(new URL('../dist/data/game-data.json', import.meta.url), 'utf8'),
);
let assertions = 0;
const near = (actual, expected, label, tolerance = 2e-5) => {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: expected ${expected}, got ${actual}`,
  );
  assertions++;
};
function feasible(result) {
  assert.equal(result.status, 'optimal', result.message);
  assert.ok(result.validation.feasible, result.message);
  for (const [item, b] of Object.entries(result.balance)) {
    near(
      b.produced + b.imported + b.extracted,
      b.consumed + b.target + b.surplus,
      `Conservation ${item}`,
    );
  }
  for (const r of result.resources) if (r.limit !== null) assert.ok(r.rate <= r.limit + 1e-5);
  return result;
}
const subset = (ids) => ({ ...data, recipes: data.recipes.filter((r) => ids.includes(r.id)) });
const res = (result, item) => result.resources.find((r) => r.item === item)?.rate || 0;
const machine = (result, id) => result.recipes.find((r) => r.id === id)?.machines || 0;
const basic = {
  objective: 'resources',
  minerTier: 3,
  minerClock: 100,
  clock: 100,
  alternates: false,
};

const steelData = subset(['Recipe_IngotSteel_C']);
const steel = feasible(
  await solve(steelData, { ...basic, targets: [{ item: 'Desc_SteelIngot_C', rate: 60 }] }),
);
near(res(steel, 'Desc_OreIron_C'), 60, '60 steel -> 60 iron ore');
near(res(steel, 'Desc_Coal_C'), 60, '60 steel -> 60 coal');
near(machine(steel, 'Recipe_IngotSteel_C'), 4 / 3, 'Steel foundries');
near(steel.totals.powerMW, (16 * 4) / 3 + 45 * 0.5, 'Current Mk.3 mining power included');

const screwData = subset([
  'Recipe_IngotIron_C',
  'Recipe_IronRod_C',
  'Recipe_Screw_C',
  'Recipe_Alternate_Screw_C',
]);
const screw = feasible(
  await solve(screwData, { ...basic, targets: [{ item: 'Desc_IronScrew_C', rate: 120 }] }),
);
near(res(screw, 'Desc_OreIron_C'), 30, '120 screws -> 30 iron ore');
near(machine(screw, 'Recipe_IngotIron_C'), 1, 'Iron smelter');
near(machine(screw, 'Recipe_IronRod_C'), 2, 'Iron rod constructors');
near(machine(screw, 'Recipe_Screw_C'), 3, 'Screw constructors');
near(screw.totals.machines, 6.125, 'Six production equivalents plus mining');
near(screw.totals.powerMW, 29.625, 'Manual screw energy calculation');
const cast = feasible(
  await solve(screwData, {
    ...basic,
    alternates: true,
    objective: 'buildings',
    targets: [{ item: 'Desc_IronScrew_C', rate: 120 }],
  }),
);
near(machine(cast, 'Recipe_Alternate_Screw_C'), 2.4, 'Cast screw alternative');
near(cast.totals.machines, 3.525, 'Cast screw building minimum');
const disabledCast = feasible(
  await solve(screwData, {
    ...basic,
    alternates: true,
    disabledRecipes: ['Recipe_Alternate_Screw_C'],
    targets: [{ item: 'Desc_IronScrew_C', rate: 120 }],
  }),
);
near(machine(disabledCast, 'Recipe_Screw_C'), 3, 'Individual recipe disable');

// Acid input: 30 fresh + 10 recycled = 40
const nuclearData = subset(['Recipe_UraniumCell_C', 'Recipe_SulfuricAcid_C', 'Recipe_Concrete_C']);
const nuclear = feasible(
  await solve(nuclearData, { ...basic, targets: [{ item: 'Desc_UraniumCell_C', rate: 25 }] }),
);
near(res(nuclear, 'Desc_OreUranium_C'), 50, 'Nuclear uranium consumption');
near(res(nuclear, 'Desc_Sulfur_C'), 30, 'Acid recycling reduces fresh sulfur');
near(res(nuclear, 'Desc_Water_C'), 30, 'Acid recycling reduces fresh water');
near(res(nuclear, 'Desc_Stone_C'), 45, 'Concrete limestone');
near(nuclear.balance.Desc_SulfuricAcid_C.produced, 40, 'Fresh plus recycled acid');
near(nuclear.balance.Desc_SulfuricAcid_C.consumed, 40, 'Acid total consumption');
near(nuclear.balance.Desc_SulfuricAcid_C.surplus, 0, 'Acid loop closes');

const multi = feasible(
  await solve(screwData, {
    ...basic,
    targets: [
      { item: 'Desc_IronScrew_C', rate: 120 },
      { item: 'Desc_IronRod_C', rate: 15 },
      { item: 'Desc_IronRod_C', rate: 15 },
    ],
  }),
);
near(res(multi, 'Desc_OreIron_C'), 60, 'Shared upstream demand');
near(machine(multi, 'Recipe_IronRod_C'), 4, 'Rod export plus screw demand');
assert.equal(multi.targets.length, 2);

const blocked = await solve(steelData, {
  ...basic,
  targets: [{ item: 'Desc_SteelIngot_C', rate: 60 }],
  resourceSettings: { Desc_Coal_C: { limit: 50 } },
});
assert.equal(blocked.status, 'infeasible');
assert.ok(blocked.shortages.some((s) => s.item === 'Desc_SteelIngot_C' && s.shortage >= 9.99));
const imported = feasible(
  await solve(steelData, {
    ...basic,
    targets: [{ item: 'Desc_SteelIngot_C', rate: 60 }],
    imports: [{ item: 'Desc_SteelIngot_C', rate: 20 }],
  }),
);
near(res(imported, 'Desc_Coal_C'), 40, 'Existing factory imports reduce raw demand');
near(imported.imports[0].rate, 20, 'Bounded import usage');

const pure = feasible(
  await solve(steelData, {
    ...basic,
    targets: [{ item: 'Desc_SteelIngot_C', rate: 60 }],
    resourceSettings: { Desc_Coal_C: { purity: 'pure' }, Desc_OreIron_C: { purity: 2 } },
  }),
);
near(res(pure, 'Desc_OreIron_C'), 60, 'Purity never changes required raw material');
near(
  pure.totals.resourcePowerMW,
  steel.totals.resourcePowerMW / 2,
  'Purity reduces mining equivalents/power',
);

const toy = {
  items: [
    { id: 'ore', name: 'ore', raw: true },
    { id: 'product', name: 'product' },
  ],
  buildings: [],
  resources: [{ itemId: 'ore', type: 'miner', baseRate: 60, powerMW: 5, weight: 1 }],
  recipes: [
    { id: 'lean', name: 'lean', inputs: { ore: 1 }, outputs: { product: 1 }, powerMW: 100 },
    { id: 'lowpower', name: 'lowpower', inputs: { ore: 2 }, outputs: { product: 1 }, powerMW: 1 },
    {
      id: 'compact',
      name: 'compact',
      inputs: { ore: 1000 },
      outputs: { product: 100 },
      powerMW: 500,
    },
  ],
};
for (const [objective, expected] of [
  ['resources', 'lean'],
  ['energy', 'lowpower'],
  ['buildings', 'compact'],
]) {
  const r = feasible(
    await solve(toy, { ...basic, objective, targets: [{ item: 'product', rate: 100 }] }),
  );
  assert.ok(machine(r, expected) > 0.999, `${objective} selects ${expected}`);
}

// Coupled recipes: B -> 2 A and A + raw -> 2 B

const cycle = {
  ...toy,
  items: [
    { id: 'ore', name: 'ore', raw: true },
    { id: 'A', name: 'A' },
    { id: 'B', name: 'B' },
  ],
  recipes: [
    { id: 'makeA', name: 'makeA', inputs: { B: 1 }, outputs: { A: 2 }, powerMW: 4 },
    { id: 'makeB', name: 'makeB', inputs: { A: 1, ore: 1 }, outputs: { B: 2 }, powerMW: 4 },
  ],
};
const cycled = feasible(await solve(cycle, { ...basic, targets: [{ item: 'A', rate: 3 }] }));
near(machine(cycled, 'makeA'), 2, 'Cycle A machines');
near(machine(cycled, 'makeB'), 1, 'Cycle B machines');
near(res(cycled, 'ore'), 1, 'Cycle fresh resource consumption');

const coproduct = {
  ...toy,
  items: [
    { id: 'ore', name: 'ore', raw: true },
    { id: 'product', name: 'product' },
    { id: 'waste', name: 'waste', form: 'liquid' },
  ],
  recipes: [
    { id: 'co', name: 'co', inputs: { ore: 2 }, outputs: { product: 1, waste: 3 }, powerMW: 4 },
  ],
};
const surplus = feasible(
  await solve(coproduct, { ...basic, targets: [{ item: 'product', rate: 10 }] }),
);
near(surplus.surplus.find((s) => s.item === 'waste').rate, 30, 'Coproduct explicitly exported');
assert.ok(surplus.warnings.some((w) => w.includes('Жидкие')));

for (const targets of [
  [{ item: 'Desc_NuclearFuelRod_C', rate: 4 }],
  [{ item: 'Desc_AluminumIngot_C', rate: 120 }],
  [
    { item: 'Desc_Plastic_C', rate: 120 },
    { item: 'Desc_Rubber_C', rate: 120 },
  ],
  [{ item: 'Desc_ModularFrameHeavy_C', rate: 10 }],
]) {
  for (const objective of ['resources', 'energy', 'buildings']) {
    const r = feasible(await solve(data, { ...basic, alternates: true, objective, targets }));
    assert.ok(
      r.resources.every((x) => x.type !== 'external'),
      'Manual sources have default limit 0',
    );
    console.log(
      `PASS full ${targets.map((t) => t.item).join('+')} ${objective}: ${r.recipes.length} recipes, ${r.totals.powerMW.toFixed(2)} MW`,
    );
  }
}
const invalid = await solve(data, { targets: [{ item: 'Desc_IronScrew_C', rate: -1 }] });
assert.equal(invalid.status, 'error');
const waste = await solve(data, { ...basic, targets: [{ item: 'Desc_NuclearWaste_C', rate: 1 }] });
assert.equal(waste.status, 'infeasible', 'Nuclear waste cannot appear as an unlimited free input');

console.log(`PASS all solver tests; ${assertions} numeric and material-balance assertions`);
