import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { solve } from '../dist/solver.js';
import { buildFlowData } from '../dist/graph.js';

const data = JSON.parse(
  await readFile(new URL('../dist/data/game-data.json', import.meta.url), 'utf8'),
);
const water = 'Desc_Water_C';
const scrap = 'Desc_AluminumScrap_C';
const alumina = 'Recipe_AluminaSolution_C';
const aluminumScrap = 'Recipe_AluminumScrap_C';
const instantScrap = 'Recipe_Alternate_InstantScrap_C';
const subset = (ids) => ({
  ...data,
  recipes: data.recipes.filter((recipe) => ids.includes(recipe.id)),
});
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) <= 2e-5, `${label}: expected ${expected}, got ${actual}`);
const rate = (flow, source, target, item = water) =>
  flow.edges
    .filter((edge) => edge.source === source && edge.target === target && edge.itemId === item)
    .reduce((total, edge) => total + edge.rate, 0);

test('standard aluminum closes the inter-process water cycle without hiding gross inputs', async () => {
  // Water input: 240 fresh + 120 returned = 360

  const dataset = subset([alumina, aluminumScrap]);
  const options = {
    targets: [{ item: scrap, rate: 360 }],
    alternates: false,
    objective: 'resources',
  };
  const result = await solve(dataset, options);
  assert.equal(result.status, 'optimal', result.message);
  const balance = result.balance[water];
  near(balance.produced, 120, 'Returned water');
  near(balance.consumed, 360, 'Gross process water input');
  near(balance.extracted, 240, 'Fresh water extraction');
  near(balance.surplus, 0, 'Water loop has no surplus');
  near(result.resources.find((r) => r.item === 'Desc_OreBauxite_C').rate, 240, 'Bauxite');
  near(result.resources.find((r) => r.item === 'Desc_Coal_C').rate, 120, 'Coal');
  near(
    result.surplus.find((r) => r.item === 'Desc_Silica_C').rate,
    100,
    'Silica co-product stays explicit',
  );

  const flow = buildFlowData(dataset, result);
  assert.deepEqual(flow.diagnostics, []);
  near(rate(flow, `resource:${water}`, `recipe:${alumina}`), 240, 'Fresh-water edge');
  near(rate(flow, `recipe:${aluminumScrap}`, `recipe:${alumina}`), 120, 'Water-return edge');
  near(
    rate(flow, `recipe:${alumina}`, `recipe:${aluminumScrap}`, 'Desc_AluminaSolution_C'),
    240,
    'Forward solution edge closes the directed cycle',
  );
  near(
    flow.nodes.find((n) => n.id === `recipe:${alumina}`).inputs[water],
    360,
    'Displayed recipe retains gross input',
  );
  near(
    flow.nodes.find((n) => n.id === `recipe:${aluminumScrap}`).outputs[water],
    120,
    'Displayed recipe retains returned output',
  );

  const capped = await solve(dataset, {
    ...options,
    resourceSettings: { [water]: { limit: 240 } },
  });
  assert.equal(capped.status, 'optimal', 'Exactly the net fresh-water requirement is sufficient');
  const blocked = await solve(dataset, {
    ...options,
    resourceSettings: { [water]: { limit: 239 } },
  });
  assert.equal(blocked.status, 'infeasible', 'Recycling does not create missing fresh water');
});

test('Instant Scrap keeps an explicit self-return and needs only its net fresh water', async () => {
  // Imported acid isolates the water loop: 10 fresh + 50 returned = 60

  const dataset = subset([instantScrap]);
  const options = {
    targets: [{ item: scrap, rate: 300 }],
    alternates: true,
    objective: 'resources',
    imports: [{ item: 'Desc_SulfuricAcid_C', rate: 50 }],
  };
  const result = await solve(dataset, options);
  assert.equal(result.status, 'optimal', result.message);
  const balance = result.balance[water];
  near(balance.produced, 50, 'Water returned by the same recipe');
  near(balance.consumed, 60, 'Gross blender water input');
  near(balance.extracted, 10, 'Net fresh water requirement');
  near(balance.surplus, 0, 'No leftover water');
  near(
    result.imports.find((r) => r.item === 'Desc_SulfuricAcid_C').rate,
    50,
    'Acid is supplied externally',
  );

  const flow = buildFlowData(dataset, result);
  assert.deepEqual(flow.diagnostics, []);
  const blender = `recipe:${instantScrap}`;
  const selfEdges = flow.edges.filter(
    (edge) => edge.source === blender && edge.target === blender && edge.itemId === water,
  );
  assert.equal(selfEdges.length, 1, 'One explicit self-return connection');
  near(selfEdges[0].rate, 50, 'Self-return edge');
  near(rate(flow, `resource:${water}`, blender), 10, 'Fresh water is separate from self-return');
  const node = flow.nodes.find((n) => n.id === blender);
  near(node.inputs[water], 60, 'Graph retains gross input');
  near(node.outputs[water], 50, 'Graph retains gross return');
  near(
    flow.edges
      .filter((edge) => edge.target === blender && edge.itemId === water)
      .reduce((sum, edge) => sum + edge.rate, 0),
    60,
    'All incoming water sums to gross input',
  );

  const capped = await solve(dataset, { ...options, resourceSettings: { [water]: { limit: 10 } } });
  assert.equal(capped.status, 'optimal', 'Net fresh-water cap permits the self-recycling process');
  const blocked = await solve(dataset, { ...options, resourceSettings: { [water]: { limit: 9 } } });
  assert.equal(blocked.status, 'infeasible', 'Self-return cannot replace the final 10 fresh water');
});
