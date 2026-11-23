import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { solve } from '../dist/solver.js';
import { buildFlowData, layoutFlow } from '../dist/graph.js';

const data = JSON.parse(
  await readFile(new URL('../dist/data/game-data.json', import.meta.url), 'utf8'),
);
const overlap = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
// Liang-Barsky clipping checks the sampled lane geometry

function crosses(a, b, box) {
  const inset = 0.02,
    x0 = box.x + inset,
    x1 = box.x + box.width - inset,
    y0 = box.y + inset,
    y1 = box.y + box.height - inset;
  const dx = b.x - a.x,
    dy = b.y - a.y;
  if (
    Math.max(a.x, b.x) <= x0 ||
    Math.min(a.x, b.x) >= x1 ||
    Math.max(a.y, b.y) <= y0 ||
    Math.min(a.y, b.y) >= y1
  )
    return false;
  let low = 0,
    high = 1;
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y],
  ]) {
    if (Math.abs(p) < 1e-10) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) low = Math.max(low, t);
    else high = Math.min(high, t);
    if (low > high) return false;
  }
  return high >= low;
}
function inspectGeometry(layout) {
  for (let i = 0; i < layout.nodes.length; i++)
    for (let j = i + 1; j < layout.nodes.length; j++)
      assert.ok(!overlap(layout.nodes[i], layout.nodes[j]), 'Cards overlap');
  for (let i = 0; i < layout.edges.length; i++) {
    const edge = layout.edges[i];
    assert.ok(edge.path && !/NaN|Infinity/.test(edge.path));
    assert.ok(edge.path.includes('C'), 'Routes must contain smooth curves');
    assert.equal(edge.lanes.length, Math.min(6, edge.transport.count));
    assert.equal(edge.lanes.at(-1).load, edge.transport.lastLoad);
    assert.equal(edge.lanes.at(-1).number, edge.transport.count);
    assert.ok(edge.labelBox.width >= 280 && edge.labelBox.height === 82);
    for (const node of layout.nodes)
      assert.ok(!overlap(edge.labelBox, node), `Label ${edge.id} intersects card ${node.id}`);
    for (let j = i + 1; j < layout.edges.length; j++)
      assert.ok(
        !overlap(edge.labelBox, layout.edges[j].labelBox),
        `Labels ${edge.id} and ${layout.edges[j].id} overlap`,
      );
    for (const lane of edge.lanes) {
      assert.ok(lane.path && !/NaN|Infinity/.test(lane.path));
      assert.ok(lane.points.length > 10);
      for (let p = 1; p < lane.points.length; p++) {
        for (const node of layout.nodes)
          assert.ok(
            !crosses(lane.points[p - 1], lane.points[p], node),
            `Lane ${edge.id}/${lane.number} crosses card ${node.id}`,
          );
        for (const other of layout.edges)
          assert.ok(
            !crosses(lane.points[p - 1], lane.points[p], other.labelBox),
            `Lane ${edge.id}/${lane.number} crosses label ${other.id}`,
          );
      }
    }
  }
  for (const crossing of layout.crossings) {
    assert.notEqual(crossing.over, crossing.under);
    assert.ok(
      layout.edges.find((e) => e.id === crossing.over).crossings.includes(crossing),
      'Every crossing has an explicit upper deck',
    );
  }
  assert.ok(Object.values(layout.bounds).every(Number.isFinite));
}
for (const [item, rate, alternates] of [
  ['Desc_NuclearFuelRod_C', 4, false],
  ['Desc_NuclearFuelRod_C', 4, true],
  ['Desc_ModularFrameHeavy_C', 10, true],
  ['Desc_AluminumPlate_C', 120, true],
]) {
  const result = await solve(data, {
    objective: 'resources',
    targets: [{ item, rate }],
    minerTier: 3,
    minerClock: 100,
    clock: 100,
    alternates,
  });
  assert.equal(result.status, 'optimal', result.message);
  const full = buildFlowData(data, result),
    layout = layoutFlow(full.nodes, full.edges, { gap: 360 });
  assert.deepEqual(full.diagnostics, []);
  assert.equal(layout.nodes.length, full.nodes.length);
  assert.equal(
    layout.nodes.some((n) => n.kind === 'module'),
    false,
  );
  assert.equal(layout.columnGap, 360);
  assert.ok(layout.edges.every((e) => e.width <= 8));
  for (let i = 0; i < layout.verticalTracks.length; i++)
    for (let j = i + 1; j < layout.verticalTracks.length; j++) {
      const a = layout.verticalTracks[i],
        b = layout.verticalTracks[j];
      if (a.gapIndex !== b.gapIndex) continue;
      const overlapY =
        Math.min(Math.max(a.fromY, a.toY), Math.max(b.fromY, b.toY)) -
        Math.max(Math.min(a.fromY, a.toY), Math.min(b.fromY, b.toY));
      if (overlapY > 0)
        assert.ok(
          Math.abs(a.x - b.x) >= 16 - 1e-7,
          'Overlapping vertical tracks need 16 px separation',
        );
    }
  const extra = layoutFlow(full.nodes, full.edges, { gap: 540 });
  assert.equal(extra.columnGap, 540);
  assert.ok(extra.bounds.width > layout.bounds.width);
  for (const node of layout.nodes) {
    assert.equal(node.width, 320);
    assert.ok(node.height >= 282);
  }
  inspectGeometry(layout);
  for (const edge of layout.edges) {
    const original = full.edges.find((e) => e.id === edge.id);
    assert.equal(edge.rate, original.rate);
  }
  console.log(
    `PASS readable ${item}: ${layout.nodes.length} individual nodes, ${layout.edges.length} disjoint material labels, ${layout.crossings.length} explicit overpasses, ${layout.bounds.width} × ${Math.ceil(layout.bounds.height)}`,
  );
}

// Belt tiers change logistics without changing production

const fixtureNodes = [
  {
    id: 'producer',
    kind: 'recipe',
    itemId: 'screws',
    name: 'Producer',
    buildingId: 'Constructor',
    data: { machines: 4.3 },
  },
  { id: 'consumer', kind: 'target', itemId: 'screws', name: 'Consumer', data: {} },
];
const fixtureEdges = [
  {
    id: 'screws',
    source: 'producer',
    target: 'consumer',
    itemId: 'screws',
    form: 'solid',
    rate: 1400,
    color: '#88abc7',
  },
];
const mk5 = layoutFlow(fixtureNodes, fixtureEdges, { transport: { beltTier: 5 } });
assert.deepEqual(
  mk5.edges[0].lanes.map((l) => l.load),
  [780, 620],
);
assert.equal(mk5.nodes[0].data.machines, 4.3);
inspectGeometry(mk5);
const mk1 = layoutFlow(fixtureNodes, fixtureEdges, { transport: { beltTier: 1 } });
assert.equal(mk1.edges[0].transport.count, 24);
assert.equal(mk1.edges[0].lanes.length, 6);
assert.equal(mk1.edges[0].lanes.at(-1).number, 24);
assert.equal(mk1.edges[0].lanes.at(-1).load, 20);
assert.equal(mk1.edges[0].rate, mk5.edges[0].rate);
inspectGeometry(mk1);
const self = layoutFlow(
  [fixtureNodes[0]],
  [{ ...fixtureEdges[0], source: 'producer', target: 'producer', form: 'liquid', rate: 1400 }],
  { transport: { pipeTier: 1 } },
);
assert.ok(self.edges[0].loop);
assert.equal(self.edges[0].transport.kind, 'pipe');
assert.equal(self.edges[0].transport.count, 5);
assert.deepEqual(
  self.edges[0].lanes.map((l) => l.load),
  [300, 300, 300, 300, 200],
);
inspectGeometry(self);
console.log(
  'PASS physical conveyor and pipe lane geometry, compressed lanes, fractional machines, self-return',
);

const fourInputs = Array.from({ length: 4 }, (_, i) => ({
  id: `source-${i}`,
  kind: 'resource',
  itemId: `part-${i}`,
  name: `Part ${i}`,
  data: {},
}));
const fourInputLayout = layoutFlow(
  [...fourInputs, fixtureNodes[0]],
  fourInputs.map((node, i) => ({
    id: `input-${i}`,
    source: node.id,
    target: 'producer',
    itemId: node.itemId,
    form: 'solid',
    rate: 100,
    color: '#88abc7',
  })),
);
assert.equal(
  fourInputLayout.nodes.find((node) => node.id === 'producer').height,
  678,
  'A four-input machine must fit a readable fullscreen canvas',
);
inspectGeometry(fourInputLayout);
console.log('PASS four-line labels and compact four-input card (678 px), without shrinking type');
