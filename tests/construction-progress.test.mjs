import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProgress,
  normalizeProgressSignatures,
  setNodeProgress,
  progressCounts,
  progressFilterValue,
  reconcileProgress,
} from '../dist/construction-progress.js';

const water = 'resource:Desc_Water_C';
const recipe = 'recipe:Recipe_Alternate_WetConcrete_C';
const target = 'target:Desc_Cement_C';
const nodes = () => [
  {
    id: water, kind: 'resource', buildingId: 'Build_WaterPump_C', rate: 100,
    inputs: {}, outputs: { Desc_Water_C: 100 },
    data: { machines: 5 / 6, clock: 100, capacity: 120, purity: 1 },
  },
  {
    id: recipe, kind: 'recipe', buildingId: 'Build_OilRefinery_C', rate: 80,
    inputs: { Desc_Stone_C: 120, Desc_Water_C: 100 }, outputs: { Desc_Cement_C: 80 },
    data: { machines: 1, clock: 100 },
  },
  { id: target, kind: 'target', rate: 80, inputs: { Desc_Cement_C: 80 }, outputs: {}, data: {} },
];
const edges = () => [
  { id: 'first', source: water, target: recipe, itemId: 'Desc_Water_C', rate: 100 },
  { id: 'second', source: recipe, target, itemId: 'Desc_Cement_C', rate: 80 },
];

test('progress accepts only known node identities and explicit construction statuses', () => {
  const input = JSON.parse(`{
    "__proto__": {"polluted": true},
    "constructor": "connected",
    "module:factory": "connected",
    "recipe:bad<script>": "built",
    "${water}": "built",
    "${recipe}": "connected",
    "${target}": "unstarted",
    "import:Desc_Stone_C": true,
    "surplus:Desc_Cement_C": "unknown"
  }`);
  assert.deepEqual(normalizeProgress(input), { [water]: 'built', [recipe]: 'connected' });
  assert.equal({}.polluted, undefined);
  for (const input of [null, [], 1, 'connected']) assert.deepEqual(normalizeProgress(input), {});
  const inherited = Object.create({ [recipe]: 'connected' });
  inherited[water] = 'built';
  assert.deepEqual(normalizeProgress(inherited), { [water]: 'built' });
});

test('status edits are immutable and unfinished remains the default filter', () => {
  const before = { [recipe]: 'built' };
  const ready = setNodeProgress(before, recipe, 'connected');
  assert.deepEqual(before, { [recipe]: 'built' });
  assert.deepEqual(ready, { [recipe]: 'connected' });
  assert.deepEqual(setNodeProgress(ready, recipe, 'unstarted'), {});
  assert.deepEqual(setNodeProgress(ready, recipe, 'unknown'), ready);
  assert.deepEqual(setNodeProgress(ready, '__proto__', 'connected'), ready);
  assert.equal(progressFilterValue('all'), 'all');
  for (const value of ['unfinished', undefined, null, 'unknown'])
    assert.equal(progressFilterValue(value), 'unfinished');
});

test('counts include current real nodes once and keep built nodes unfinished', () => {
  const progress = { [water]: 'built', [recipe]: 'connected', 'recipe:removed': 'connected' };
  assert.deepEqual(progressCounts(progress, [water, recipe, target, recipe, 'boundary:old']), {
    total: 3, built: 1, connected: 1, unfinished: 2,
  });
  assert.deepEqual(progressCounts(progress, null), {
    total: 0, built: 0, connected: 0, unfinished: 0,
  });
});

test('new marks survive reload and signatures are kept only for tracked nodes', () => {
  const result = reconcileProgress({ [recipe]: 'connected' }, {}, nodes(), edges());
  assert.deepEqual(result.progress, { [recipe]: 'connected' });
  assert.deepEqual(Object.keys(result.signatures), [recipe]);
  assert.deepEqual(result.resetIds, []);
  assert.deepEqual(result.downgradedIds, []);
  const restored = JSON.parse(JSON.stringify(result));
  assert.deepEqual(normalizeProgressSignatures(restored.signatures), result.signatures);
  assert.deepEqual(reconcileProgress(restored.progress, restored.signatures, nodes(), edges()), result);
});

test('positions, language, ordering and solver roundoff do not reset progress', () => {
  const initial = reconcileProgress({ [water]: 'built', [recipe]: 'connected' }, {}, nodes(), edges());
  const current = nodes().reverse();
  const production = current.find((node) => node.id === recipe);
  production.nameEn = 'Wet Concrete';
  production.nameRu = 'Сырой бетон';
  production.x = 5000;
  production.width = 800;
  production.data.machines += 1e-9;
  production.inputs = { Desc_Water_C: 100 + 1e-8, Desc_Stone_C: 120 };
  production.outputs.Desc_Cement_C += 1e-8;
  const links = edges().reverse().map((edge, i) => ({
    ...edge, id: `different-${i}`, route: [{ x: 1, y: 2 }], rate: edge.rate + 1e-8,
  }));
  const result = reconcileProgress(initial.progress, initial.signatures, current, links);
  assert.deepEqual(result.progress, initial.progress);
  assert.deepEqual(result.resetIds, []);
  assert.deepEqual(result.downgradedIds, []);
  assert.equal(result.signatures[recipe].inputs.Desc_Water_C, 100);
});

test('changed machinery and material needs reset only affected construction marks', () => {
  const initial = reconcileProgress({ [water]: 'built', [recipe]: 'connected' }, {}, nodes(), edges());
  for (const change of [
    (node) => { node.data.machines = 1.5; },
    (node) => { node.buildingId = 'Build_AssemblerMk1_C'; },
    (node) => { node.inputs.Desc_Water_C = 200; },
    (node) => { node.outputs.Desc_Cement_C = 160; },
    (node) => { node.rate = 160; },
    (node) => { node.data.clock = 200; },
  ]) {
    const current = nodes();
    change(current.find((node) => node.id === recipe));
    const result = reconcileProgress(initial.progress, initial.signatures, current, edges());
    assert.deepEqual(result.progress, { [water]: 'built' });
    assert.deepEqual(result.resetIds, [recipe]);
    assert.deepEqual(result.downgradedIds, []);
  }
  const current = nodes();
  current[0].data.purity = 2;
  const result = reconcileProgress(initial.progress, initial.signatures, current, edges());
  assert.deepEqual(result.progress, { [recipe]: 'connected' });
  assert.deepEqual(result.resetIds, [water]);
});

test('a changed supplier requires reconnecting an otherwise unchanged process', () => {
  const replacement = 'import:Desc_Water_C';
  const current = nodes().map((node) => node.id === water
    ? { id: replacement, kind: 'import', rate: 100, inputs: {}, outputs: { Desc_Water_C: 100 }, data: {} }
    : node);
  const links = edges().map((edge) => edge.source === water ? { ...edge, source: replacement } : edge);
  for (const status of ['connected', 'built']) {
    const initial = reconcileProgress({ [recipe]: status, [target]: 'connected' }, {}, nodes(), edges());
    const result = reconcileProgress(initial.progress, initial.signatures, current, links);
    assert.deepEqual(result.progress, { [recipe]: 'built', [target]: 'connected' });
    assert.deepEqual(result.resetIds, []);
    assert.deepEqual(result.downgradedIds, status === 'connected' ? [recipe] : []);
    const again = reconcileProgress(result.progress, result.signatures, current, links);
    assert.deepEqual(again.downgradedIds, []);
  }
});

test('parallel edges are aggregated and edge identifiers do not represent connection changes', () => {
  const initial = reconcileProgress({ [recipe]: 'connected' }, {}, nodes(), edges());
  const links = [
    { source: water, target: recipe, itemId: 'Desc_Water_C', rate: 40 },
    { source: recipe, target, itemId: 'Desc_Cement_C', rate: 80 },
    { source: water, target: recipe, itemId: 'Desc_Water_C', rate: 60 },
  ];
  const result = reconcileProgress(initial.progress, initial.signatures, nodes(), links);
  assert.deepEqual(result.progress, initial.progress);
  assert.deepEqual(result.downgradedIds, []);
});

test('older signatures without connections are migrated without losing explicit marks', () => {
  const initial = reconcileProgress({ [recipe]: 'connected' }, {}, nodes(), edges());
  delete initial.signatures[recipe].connections;
  const result = reconcileProgress(initial.progress, initial.signatures, nodes(), edges());
  assert.deepEqual(result.progress, initial.progress);
  assert.equal(result.signatures[recipe].connections.length, 2);
  assert.deepEqual(result.downgradedIds, []);
});

test('removed nodes are pruned and returning recipes do not revive obsolete progress', () => {
  const initial = reconcileProgress({ [water]: 'built', [recipe]: 'connected' }, {}, nodes(), edges());
  const reduced = reconcileProgress(initial.progress, initial.signatures, [nodes()[0]], []);
  assert.deepEqual(reduced.progress, { [water]: 'built' });
  assert.deepEqual(Object.keys(reduced.signatures), [water]);
  const restored = reconcileProgress(reduced.progress, reduced.signatures, nodes(), edges());
  assert.equal(restored.progress[recipe], undefined);
  assert.equal(restored.signatures[recipe], undefined);
});

test('signature restoration rejects malformed numbers, unsafe flows and prototype keys', () => {
  const initial = reconcileProgress({ [recipe]: 'connected' }, {}, nodes(), edges());
  const malformed = JSON.parse(JSON.stringify(initial.signatures));
  malformed[recipe].machines = '1';
  assert.deepEqual(normalizeProgressSignatures(malformed), {});
  malformed[recipe].machines = 1;
  malformed[recipe].inputs = JSON.parse('{"__proto__":10}');
  assert.deepEqual(normalizeProgressSignatures(malformed), {});
  assert.deepEqual(normalizeProgressSignatures(JSON.parse('{"__proto__":{}}')), {});
  assert.deepEqual(normalizeProgressSignatures([]), {});
});
