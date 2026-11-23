import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { solve } from '../dist/solver.js';
import { buildFlowData, layoutFlow } from '../dist/graph.js';

const data = JSON.parse(
  await readFile(new URL('../dist/data/game-data.json', import.meta.url), 'utf8'),
);
let checks = 0;
const near = (actual, expected, label) => {
  const tolerance = Math.max(2e-5, Math.max(Math.abs(actual), Math.abs(expected)) * 1e-8);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`,
  );
  checks++;
};
const byItem = (list) => new Map(list.map((record) => [record.itemId || record.item, record]));
const add = (map, item, value) => map.set(item, (map.get(item) || 0) + value);

// Recompute balances from recipe coefficients
function checkSolverIndependently(dataset, result, options) {
  assert.equal(result.status, 'optimal', result.message);
  const recipeMap = new Map(dataset.recipes.map((recipe) => [recipe.id, recipe]));
  const extracted = byItem(result.resources);
  const produced = new Map(),
    consumed = new Map();
  for (const record of result.recipes) {
    const recipe = recipeMap.get(record.recipeId);
    assert.ok(recipe, `Recipe ${record.recipeId} exists`);
    assert.ok(
      !(options.disabledRecipes || []).includes(record.recipeId),
      'Disabled recipe never runs',
    );
    if (options.alternates === false) assert.ok(!recipe.alternate, 'Locked alternative never runs');
    const multiplier = (record.machines * record.clock) / 100;
    for (const [item, rate] of Object.entries(recipe.outputs))
      add(produced, item, rate * multiplier);
    for (const [item, rate] of Object.entries(recipe.inputs))
      add(consumed, item, rate * multiplier);
  }
  for (const resource of dataset.resources) {
    const actual = extracted.get(resource.itemId)?.rate || 0;
    const configured = options.resourceSettings?.[resource.itemId]?.limit;
    const cap = configured == null || configured === '' ? resource.defaultLimit : configured;
    assert.ok(actual >= -1e-7, 'Extraction nonnegative');
    if (cap != null)
      assert.ok(actual <= cap + 2e-5, `${resource.itemId} extraction ${actual} obeys ${cap}`);
    add(produced, resource.itemId, actual);
  }
  for (const record of result.imports) add(produced, record.item, record.rate);
  for (const record of result.targets) add(consumed, record.item, record.rate);
  for (const record of result.surplus) add(consumed, record.item, record.rate);
  for (const item of new Set([...produced.keys(), ...consumed.keys()]))
    near(produced.get(item) || 0, consumed.get(item) || 0, `Independent material balance ${item}`);
}

function checkFlow(dataset, result, options, name) {
  checkSolverIndependently(dataset, result, options);
  const flow = buildFlowData(dataset, result);
  assert.deepEqual(flow.diagnostics, [], `${name}: graph creates no missing/unallocated materials`);
  const nodeMap = new Map(flow.nodes.map((node) => [node.id, node]));
  assert.equal(nodeMap.size, flow.nodes.length, `${name}: unique node IDs`);
  assert.equal(
    new Set(flow.edges.map((edge) => edge.id)).size,
    flow.edges.length,
    `${name}: unique edge IDs`,
  );
  const incoming = new Map(),
    outgoing = new Map(),
    totalEdges = new Map();
  const compound = (node, item) => `${node}\u0000${item}`;
  for (const edge of flow.edges) {
    assert.ok(nodeMap.has(edge.source), `${name}: valid edge source`);
    assert.ok(nodeMap.has(edge.target), `${name}: valid edge destination`);
    assert.ok(Number.isFinite(edge.rate) && edge.rate > 0, `${name}: positive finite flow`);
    add(outgoing, compound(edge.source, edge.itemId), edge.rate);
    add(incoming, compound(edge.target, edge.itemId), edge.rate);
    add(totalEdges, edge.itemId, edge.rate);
  }
  const expectedTotal = new Map();
  for (const node of flow.nodes) {
    for (const [item, rate] of Object.entries(node.inputs))
      near(
        incoming.get(compound(node.id, item)) || 0,
        rate,
        `${name}: ${node.id} receives ${item}`,
      );
    for (const [item, rate] of Object.entries(node.outputs)) {
      near(outgoing.get(compound(node.id, item)) || 0, rate, `${name}: ${node.id} sends ${item}`);
      add(expectedTotal, item, rate);
    }
    for (const edge of flow.edges.filter((edge) => edge.target === node.id))
      assert.ok(node.inputs[edge.itemId] > 0, `${name}: unexpected input cannot be routed`);
    for (const edge of flow.edges.filter((edge) => edge.source === node.id))
      assert.ok(node.outputs[edge.itemId] > 0, `${name}: unexpected output cannot be routed`);
  }
  for (const [item, rate] of expectedTotal)
    near(totalEdges.get(item) || 0, rate, `${name}: every produced unit travels exactly once`);

  const layout = layoutFlow(flow.nodes, flow.edges);
  assert.equal(layout.nodes.length, flow.nodes.length, `${name}: layout keeps all nodes`);
  assert.equal(layout.edges.length, flow.edges.length, `${name}: layout keeps all edges`);
  for (const node of layout.nodes)
    assert.ok(
      Number.isFinite(node.x) && Number.isFinite(node.y),
      `${name}: finite layout coordinates`,
    );
  for (const edge of layout.edges)
    assert.ok(edge.path && !/NaN|Infinity|undefined/.test(edge.path), `${name}: valid SVG path`);
  return { flow, layout };
}

const cases = [
  ['nuclear', [{ item: 'Desc_NuclearFuelRod_C', rate: 4 }]],
  ['frames', [{ item: 'Desc_ModularFrameHeavy_C', rate: 10 }]],
  [
    'oil',
    [
      { item: 'Desc_Plastic_C', rate: 120 },
      { item: 'Desc_Rubber_C', rate: 120 },
    ],
  ],
];
for (const [name, targets] of cases) {
  for (const objective of ['resources', 'energy', 'buildings']) {
    const options = { targets, objective, alternates: true };
    const result = await solve(data, options);
    const { flow } = checkFlow(data, result, options, `${name}/${objective}`);
    console.log(
      `PASS ${name}/${objective}: ${flow.nodes.length} nodes, ${flow.edges.length} edges, all item balances preserved`,
    );
  }
}

// Self-return: 40 acid in, 10 returned, 30 fresh
const cellData = {
  ...data,
  recipes: data.recipes.filter((recipe) =>
    ['Recipe_UraniumCell_C', 'Recipe_SulfuricAcid_C', 'Recipe_Concrete_C'].includes(recipe.id),
  ),
};
const cellOptions = { targets: [{ item: 'Desc_UraniumCell_C', rate: 25 }], alternates: false };
const cells = await solve(cellData, cellOptions);
const { flow: cellFlow, layout: cellLayout } = checkFlow(
  cellData,
  cells,
  cellOptions,
  'uranium-cell-self-return',
);
const cellId = 'recipe:Recipe_UraniumCell_C';
const self = cellFlow.edges.filter(
  (edge) =>
    edge.source === cellId && edge.target === cellId && edge.itemId === 'Desc_SulfuricAcid_C',
);
assert.equal(self.length, 1, 'One explicit self-return edge');
near(self[0].rate, 10, 'Self-return acid rate');
const fresh = cellFlow.edges.find(
  (edge) =>
    edge.source === 'recipe:Recipe_SulfuricAcid_C' &&
    edge.target === cellId &&
    edge.itemId === 'Desc_SulfuricAcid_C',
);
near(fresh.rate, 30, 'Fresh acid excludes recycled acid');
assert.equal(
  cellLayout.edges.find((edge) => edge.id === self[0].id).loop,
  true,
  'Self-return gets a loop path',
);

const simple = {
  ...data,
  recipes: data.recipes.filter((recipe) => recipe.id === 'Recipe_IngotSteel_C'),
};
const importOptions = {
  targets: [{ item: 'Desc_OreIron_C', rate: 10 }],
  imports: [{ item: 'Desc_OreIron_C', rate: 5 }],
};
const imported = await solve(simple, importOptions);
const { flow: importFlow } = checkFlow(
  simple,
  imported,
  importOptions,
  'same-item-source-import-target',
);
for (const kind of ['resource', 'import', 'target'])
  assert.ok(importFlow.nodes.some((node) => node.id === `${kind}:Desc_OreIron_C`));

// Limits apply to extraction; converted resources can still enter the balance

for (const objective of ['resources', 'energy', 'buildings']) {
  const options = {
    targets: [{ item: 'Desc_ModularFrameHeavy_C', rate: 10 }],
    objective,
    alternates: true,
    resourceSettings: { Desc_Coal_C: { limit: 0 }, Desc_OreIron_C: { limit: 20 } },
  };
  const result = await solve(data, options);
  const { flow } = checkFlow(data, result, options, `capped-frames/${objective}`);
  assert.ok(
    !flow.nodes.some((node) => node.id === 'resource:Desc_Coal_C'),
    'Zero-cap coal cannot appear as an extraction node',
  );
  assert.ok(
    (result.resources.find((resource) => resource.item === 'Desc_OreIron_C')?.rate || 0) <=
      20 + 2e-5,
  );
  assert.ok(
    result.resources.every((resource) => resource.type !== 'external'),
    'No locked manual source can bypass caps',
  );
}

const blockedOptions = {
  targets: [{ item: 'Desc_SteelIngot_C', rate: 60 }],
  resourceSettings: { Desc_Coal_C: { limit: 50 } },
};
const blocked = await solve(simple, blockedOptions);
assert.equal(blocked.status, 'infeasible');
assert.ok(
  blocked.shortages.some(
    (shortage) => shortage.item === 'Desc_SteelIngot_C' && shortage.shortage >= 9.999,
  ),
);

console.log(
  `PASS solver + flow integration; ${checks} numeric graph/material comparisons, 15 focused scenarios`,
);
