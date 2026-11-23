import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDependencyForest, dependencyNames } from '../dist/dependencies.js';

const item = (id, nameRu = id, form = 'solid') => ({ id, name: id, nameRu, form });
const building = { id: 'constructor', name: 'Constructor', nameRu: 'Конструктор' };
const recipe = (id, output) => ({
  id,
  name: id,
  nameRu: `Рецепт ${id}`,
  buildingId: building.id,
  primaryItem: output,
});
const run = (id, inputs, outputs, machines = 1) => ({
  id,
  recipeId: id,
  buildingId: building.id,
  machines,
  inputs,
  outputs,
});
const entries = (forest) => [...forest.entries.values()];

function assertEdgeCoverage(forest) {
  const represented = entries(forest)
    .filter((entry) => entry.connection)
    .map((entry) => entry.connection.id);
  assert.equal(
    new Set(represented).size,
    represented.length,
    'Every represented flow appears exactly once',
  );
  const all = [...represented, ...forest.outsideEdges.map((edge) => edge.id)];
  assert.equal(new Set(all).size, all.length, 'No flow is counted both in a branch and outside it');
  assert.deepEqual(
    all.sort(),
    forest.flow.edges.map((edge) => edge.id).sort(),
    'Every original flow remains accounted for',
  );
  for (const entry of entries(forest)) {
    if (entry.kind === 'node') continue;
    assert.equal(entry.children.length, 0, 'References never recursively duplicate a process');
    const original = forest.entries.get(entry.originalId);
    assert.ok(original, 'Reference points to a real canonical entry');
    assert.equal(original.kind, 'node');
    assert.equal(original.nodeId, entry.nodeId);
  }
}

test('multiple targets share a supplier once while retaining each parent allocation', () => {
  const data = {
    items: [item('ore', 'Руда'), item('shared', 'Общий материал'), item('A'), item('B')],
    buildings: [building],
    recipes: [recipe('supply', 'shared'), recipe('makeA', 'A'), recipe('makeB', 'B')],
  };
  const result = {
    targets: [
      { item: 'A', rate: 10 },
      { item: 'B', rate: 20 },
    ],
    resources: [{ item: 'ore', rate: 30 }],
    recipes: [
      run('supply', { ore: 30 }, { shared: 30 }, 4.3),
      run('makeA', { shared: 10 }, { A: 10 }),
      run('makeB', { shared: 20 }, { B: 20 }),
    ],
  };
  const before = JSON.stringify(result);
  const forest = buildDependencyForest(data, result);
  assert.deepEqual(
    forest.roots.map((entry) => entry.nodeId),
    ['target:A', 'target:B'],
  );
  assert.equal(forest.processCount, 3);
  const supplier = entries(forest).filter((entry) => entry.nodeId === 'recipe:supply');
  assert.equal(supplier.length, 2);
  assert.deepEqual(
    supplier.map((entry) => entry.kind),
    ['node', 'shared'],
  );
  assert.deepEqual(
    supplier.map((entry) => entry.connection.rate),
    [10, 20],
  );
  assert.equal(
    supplier[0].node.outputs.shared,
    30,
    'Canonical production is the whole plan, not a branch-scaled copy',
  );
  assert.equal(
    supplier[0].node.data.machines,
    4.3,
    'Fractional building equivalents are preserved',
  );
  assert.equal(forest.sharedCount, 1);
  assert.equal(forest.returnCount, 0);
  assert.equal(forest.outsideEdges.length, 0);
  assert.equal(JSON.stringify(result), before, 'Projection does not change the solved plan');
  assertEdgeCoverage(forest);
});

test('a self-return is explicit and retains gross and fresh input rates', () => {
  const data = {
    items: [item('water', 'Вода', 'liquid'), item('scrap', 'Лом')],
    buildings: [building],
    recipes: [recipe('recycle', 'scrap')],
  };
  const result = {
    targets: [{ item: 'scrap', rate: 300 }],
    resources: [{ item: 'water', rate: 10 }],
    recipes: [run('recycle', { water: 60 }, { scrap: 300, water: 50 })],
  };
  const forest = buildDependencyForest(data, result);
  const returns = entries(forest).filter((entry) => entry.kind === 'return');
  assert.equal(returns.length, 1);
  assert.equal(returns[0].connection.itemId, 'water');
  assert.equal(returns[0].connection.rate, 50);
  assert.equal(returns[0].nodeId, 'recipe:recycle');
  const original = forest.entries.get(returns[0].originalId);
  assert.equal(original.node.inputs.water, 60);
  assert.equal(original.node.outputs.water, 50);
  assert.equal(
    original.children
      .filter((entry) => entry.connection.itemId === 'water')
      .reduce((sum, entry) => sum + entry.connection.rate, 0),
    60,
  );
  assert.equal(
    original.children.find((entry) => entry.nodeId === 'resource:water').connection.rate,
    10,
  );
  assert.equal(forest.processCount, 1);
  assert.equal(forest.returnCount, 1);
  assertEdgeCoverage(forest);
});

test('a two-process cycle closes with a return reference instead of infinite recursion', () => {
  const data = {
    items: [item('ore'), item('A'), item('B')],
    buildings: [building],
    recipes: [recipe('makeA', 'A'), recipe('makeB', 'B')],
  };
  const result = {
    targets: [{ item: 'A', rate: 3 }],
    resources: [{ item: 'ore', rate: 1 }],
    recipes: [run('makeA', { B: 2 }, { A: 4 }, 2), run('makeB', { A: 1, ore: 1 }, { B: 2 })],
  };
  const forest = buildDependencyForest(data, result);
  assert.equal(forest.entries.size, 5, 'Target, two processes, one resource, one return');
  assert.equal(forest.processCount, 2);
  assert.equal(forest.returnCount, 1);
  const back = entries(forest).find((entry) => entry.kind === 'return');
  assert.equal(back.nodeId, 'recipe:makeA');
  assert.equal(back.connection.itemId, 'A');
  assert.equal(back.connection.rate, 1);
  assert.equal(forest.entries.get(back.parentId).nodeId, 'recipe:makeB');
  const fullA = forest.entries.get(back.originalId);
  assert.equal(fullA.connection.rate, 3, 'Target receives only its required share');
  assert.equal(fullA.node.outputs.A, 4, 'Gross output retains both target and recycled share');
  assertEdgeCoverage(forest);
});

test('co-products retain full output amounts and explicitly identified surplus deliveries', () => {
  const data = {
    items: [item('ore'), item('product'), item('water', 'Вода', 'liquid')],
    buildings: [building],
    recipes: [recipe('coproduct', 'product')],
  };
  const result = {
    targets: [{ item: 'product', rate: 10 }],
    resources: [{ item: 'ore', rate: 20 }],
    recipes: [run('coproduct', { ore: 20 }, { product: 10, water: 30 })],
    surplus: [{ item: 'water', rate: 30 }],
  };
  const forest = buildDependencyForest(data, result);
  const process = forest.entries.get(forest.originals.get('recipe:coproduct'));
  assert.deepEqual(process.node.outputs, { product: 10, water: 30 });
  assert.equal(forest.outsideEdges.length, 1);
  assert.equal(forest.outsideEdges[0].target, 'surplus:water');
  assert.equal(forest.outsideEdges[0].rate, 30);
  assertEdgeCoverage(forest);
});

test('all existing language modes preserve the requested name order', () => {
  const water = item('Water', 'Вода', 'liquid');
  assert.deepEqual(dependencyNames(water, 'both'), ['Вода', 'Water']);
  assert.deepEqual(dependencyNames(water, 'en-ru'), ['Water', 'Вода']);
  assert.deepEqual(dependencyNames(water, 'ru'), ['Вода', '']);
  assert.deepEqual(dependencyNames(water, 'en'), ['Water', '']);
  assert.deepEqual(dependencyNames({ name: 'Same', nameRu: 'Same' }), ['Same', '']);
});

test('an empty solved plan has no invented goals or dependencies', () => {
  const forest = buildDependencyForest(
    { items: [], buildings: [], recipes: [] },
    { targets: [], recipes: [] },
  );
  assert.deepEqual(forest.roots, []);
  assert.equal(forest.processCount, 0);
  assert.equal(forest.entries.size, 0);
  assertEdgeCoverage(forest);
});
