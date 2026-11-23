import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { solve } from '../dist/solver.js';
import { buildFlowData, buildOverviewData, layoutFlow } from '../dist/graph.js';

const data = JSON.parse(
  await readFile(new URL('../dist/data/game-data.json', import.meta.url), 'utf8'),
);
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-5, `${message}: ${a} != ${b}`);
const totals = (edges) => {
  const result = new Map();
  for (const e of edges) result.set(e.itemId, (result.get(e.itemId) || 0) + e.rate);
  return result;
};

for (const [item, rate, alternates] of [
  ['Desc_NuclearFuelRod_C', 4, false],
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
    overview = buildOverviewData(full);
  assert.deepEqual(full.diagnostics, []);

  // Each stream belongs to an external edge or one module's internal flows

  const originalTotals = totals(full.edges),
    retainedTotals = totals(overview.edges);
  for (const node of overview.nodes.filter((n) => n.kind === 'module')) {
    for (const stream of node.data.internalFlows) {
      retainedTotals.set(stream.item, (retainedTotals.get(stream.item) || 0) + stream.rate);
    }
  }
  assert.deepEqual([...retainedTotals.keys()].sort(), [...originalTotals.keys()].sort());
  for (const [material, quantity] of originalTotals)
    near(quantity, retainedTotals.get(material), `Retained ${material}`);
  for (const node of overview.nodes) {
    for (const [material, quantity] of Object.entries(node.inputs))
      near(
        quantity,
        overview.edges
          .filter((e) => e.target === node.id && e.itemId === material)
          .reduce((s, e) => s + e.rate, 0),
        `Input ${node.id}`,
      );
    for (const [material, quantity] of Object.entries(node.outputs))
      near(
        quantity,
        overview.edges
          .filter((e) => e.source === node.id && e.itemId === material)
          .reduce((s, e) => s + e.rate, 0),
        `Output ${node.id}`,
      );
  }

  const layout = layoutFlow(overview.nodes, overview.edges, { maximumColumns: 4 });
  assert.ok(new Set(layout.nodes.map((n) => n.rank)).size <= 4);
  for (const value of Object.values(layout.bounds)) assert.ok(Number.isFinite(value));
  assert.ok(layout.bounds.width > 0 && layout.bounds.height > 0);
  for (const edge of layout.edges) assert.ok(edge.path && !/NaN|Infinity/.test(edge.path));
  for (let i = 0; i < layout.nodes.length; i++)
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i],
        b = layout.nodes[j];
      assert.ok(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
        `Overlapping ${a.id} / ${b.id}`,
      );
    }

  const expanded = buildOverviewData(
    full,
    new Set(overview.nodes.filter((n) => n.kind === 'module').map((n) => n.id)),
  );
  assert.deepEqual(expanded.nodes.map((n) => n.id).sort(), full.nodes.map((n) => n.id).sort());
  assert.equal(
    expanded.nodes.some((n) => n.kind === 'module'),
    false,
  );
  const expandedTotals = totals(expanded.edges);
  for (const [material, quantity] of originalTotals)
    near(quantity, expandedTotals.get(material), `Expanded ${material}`);
  console.log(
    `PASS overview ${item}: ${full.nodes.length} -> ${overview.nodes.length} nodes, ${layout.bounds.width} × ${Math.ceil(layout.bounds.height)}, max 4 columns`,
  );
}
