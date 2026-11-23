import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraph, buildFlowData } from '../dist/graph.js';
import { Element, installSvgDOM } from './helpers/svg-dom.mjs';

installSvgDOM();
const icon = 'data:image/png;base64,iVBORw0KGgo=';
const data = {
  items: [
    { id: 'sulfur', name: 'Sulfur', nameRu: 'Сера', form: 'solid', icon },
    { id: 'acid', name: 'Sulfuric Acid', nameRu: 'Серная кислота', form: 'liquid', icon },
  ],
  buildings: [{ id: 'refinery', name: 'Refinery', nameRu: 'НПЗ', icon }],
  recipes: [{ id: 'acid', name: 'Sulfuric Acid', nameRu: 'Серная кислота', buildingId: 'refinery', primaryItem: 'acid' }],
};
const result = {
  resources: [{ itemId: 'sulfur', rate: 123456.78, machines: 4.3 }],
  recipes: [{ recipeId: 'acid', buildingId: 'refinery', machines: 13.33, inputs: { sulfur: 123456.78, acid: 133.33 }, outputs: { acid: 123590.11 } }],
  targets: [{ itemId: 'acid', rate: 123456.78 }],
  imports: [], surplus: [],
};
const flow = buildFlowData(data, result);
const node = (svg, id) => svg.querySelector(`[data-node-id="${id}"]`);
const mark = (svg, id) => svg.querySelector(`[data-progress-node="${id}"]`);
const rates = (element) => element.querySelectorAll('.port-rate').map((text) => text.textContent);

test('Progress filtering keeps rates, model and camera; connected neighbours leave transport stubs', () => {
  const container = new Element('div');
  const graph = createGraph(container, { compact: true });
  const svg = container.children[0];
  const unchanged = structuredClone(result);
  graph.setData(data, result);
  assert.equal(graph.getCounts().progressFilter, 'unfinished');
  assert.equal(node(svg, 'recipe:acid').querySelector('.compact-title').textContent, 'Sulfuric Acid');
  const beforeView = graph.getView();
  const beforePosition = node(svg, 'recipe:acid').getAttribute('transform');
  const beforeRates = rates(node(svg, 'recipe:acid'));
  graph.setProgress({ 'resource:sulfur': 'connected', 'recipe:acid': 'built' });
  assert.equal(graph.getCounts().nodes, flow.nodes.length);
  assert.equal(graph.getCounts().edges, flow.edges.length);
  assert.equal(graph.getCounts().visibleNodes, flow.nodes.length - 1);
  assert.equal(graph.getCounts().completedNodes, 1);
  assert.equal(graph.getCounts().hiddenNodes, 1);
  assert.equal(node(svg, 'resource:sulfur'), null);
  assert(node(svg, 'recipe:acid').classList.contains('fl-built'));
  assert(svg.querySelector('[data-completed-node="resource:sulfur"]'));
  assert.deepEqual(graph.getView(), beforeView);
  assert.equal(node(svg, 'recipe:acid').getAttribute('transform'), beforePosition);
  assert.deepEqual(rates(node(svg, 'recipe:acid')), beforeRates);
  assert.equal(graph.centerNode('resource:sulfur'), false);
  assert.equal(graph.setFocus('resource:sulfur'), false);
  graph.setProgressFilter('all');
  assert.equal(graph.getCounts().visibleNodes, flow.nodes.length);
  assert.equal(graph.getCounts().hiddenNodes, 0);
  assert(node(svg, 'resource:sulfur').classList.contains('fl-connected'));
  assert.equal(graph.centerNode('resource:sulfur'), true);
  const completed = Object.fromEntries(flow.nodes.map((entry) => [entry.id, 'connected']));
  graph.setData(data, result, { progress: completed, progressFilter: 'unfinished' });
  assert.equal(graph.getCounts().visibleNodes, 0);
  assert.equal(graph.getCounts().visibleEdges, 0);
  assert.equal(graph.centerTarget(), false);
  assert.equal(graph.centerStart(), false);
  graph.fit();
  const exported = graph.exportSVG();
  assert.match(exported, /All nodes are connected/);
  assert(!/\b(?:NaN|Infinity)\b/.test(exported));
  assert.deepEqual(result, unchanged);
  graph.destroy();
});

test('Quick progress is keyboard accessible and the app callback controls acceptance', () => {
  const container = new Element('div');
  const requested = [];
  const graph = createGraph(container, { progressFilter: 'all', progress: { 'recipe:acid': 'built' },
    onProgressChange: (id, status) => requested.push([id, status]) });
  graph.setData(data, result);
  const svg = container.children[0];
  const control = mark(svg, 'recipe:acid');
  assert.equal(control.getAttribute('tabindex'), '0');
  assert.equal(control.getAttribute('role'), 'button');
  let stopped = false, prevented = false;
  control.events.keydown[0]({ key: 'Enter', stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
  assert(stopped && prevented);
  assert.deepEqual(requested, [['recipe:acid', 'connected']]);
  assert.equal(graph.getCounts().completedNodes, 0, 'Rejected requests must not change the graph');
  assert(node(svg, 'recipe:acid').classList.contains('fl-built'));
  graph.setProgress({ 'recipe:acid': 'connected' });
  assert.equal(mark(svg, 'recipe:acid').getAttribute('aria-pressed'), 'true');
  mark(svg, 'recipe:acid').events.click[0]({ stopPropagation() {} });
  assert.deepEqual(requested.at(-1), ['recipe:acid', 'built']);
  assert.equal(graph.getCounts().completedNodes, 1);
  graph.setProgress({ 'recipe:acid': 'built' });
  assert.equal(graph.getCounts().completedNodes, 0);
  graph.destroy();
});

test('Full and compact numeric ports stay inside their half at every zoom', () => {
  const container = new Element('div');
  const graph = createGraph(container);
  graph.setData(data, result);
  const svg = container.children[0];
  for (const compact of [false, true]) {
    graph.setCompact(compact);
    graph.resetView();
    for (let step = 0; step < 8; step++) {
      for (const card of svg.querySelectorAll('[data-node-id]')) {
        const divider = card.querySelector('.port-divider');
        assert(divider);
        const middle = Number(divider.getAttribute('x1'));
        for (const rate of card.querySelectorAll('.port-rate')) {
          const x = Number(rate.getAttribute('x'));
          if (rate.getAttribute('text-anchor') === 'end')
            assert(x - rate.getComputedTextLength() >= middle + 10);
          else assert(x + rate.getComputedTextLength() <= middle - 10);
        }
        const numbers = card.querySelectorAll('.port-rate');
        card.querySelectorAll('.port-icon').forEach((image, index) => {
          const bottom = Number(image.getAttribute('y')) + Number(image.getAttribute('height'));
          const rateTop = Number(numbers[index].getAttribute('y')) - numbers[index].fontSize();
          assert(bottom + 5 <= rateTop, 'The icon must have its own row above the number');
        });
      }
      graph.zoomOut();
    }
  }
  const before = graph.getView();
  graph.exportSVG();
  assert.deepEqual(graph.getView(), before);
  graph.destroy();
});
