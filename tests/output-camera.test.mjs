import test from 'node:test';
import assert from 'node:assert/strict';
import { outputCamera } from '../dist/graph.js';

const producer = { id: 'factory', kind: 'recipe', x: 1000, y: 100, width: 320, height: 650 };
const target = { id: 'goal', kind: 'target', x: 1922, y: 256.5, width: 320, height: 337 };
const label = { x: 694, y: 400, width: 286, height: 102 };
const layout = {
  nodes: [producer, target],
  edges: [{ source: 'factory', target: 'goal', rate: 10 }],
};
const screenBox = (box, camera) => ({
  x: box.x * camera.scale + camera.x,
  y: box.y * camera.scale + camera.y,
  width: box.width * camera.scale,
  height: box.height * camera.scale,
});

test('At 100%, a normal-width canvas opens on the final machine and its labels', () => {
  const size = { width: 1035, height: 800 },
    camera = outputCamera(layout, size, 1);
  assert.equal(camera.scale, 1);
  assert.equal(camera.anchorId, 'factory');
  assert.equal(camera.showsTarget, false);
  for (const box of [producer, label]) {
    const visible = screenBox(box, camera);
    assert.ok(visible.x >= 40 && visible.x + visible.width <= size.width - 40);
    assert.ok(visible.y >= 40 && visible.y + visible.height <= size.height - 40);
  }
  assert.ok(
    screenBox(target, camera).x > size.width,
    'The output marker may remain beyond the right edge',
  );
});

test('A large enough canvas shows the final machine, incoming labels and target without zooming', () => {
  const size = { width: 1700, height: 800 },
    camera = outputCamera(layout, size, 1);
  assert.equal(camera.scale, 1);
  assert.equal(camera.showsTarget, true);
  for (const box of [producer, label, target]) {
    const visible = screenBox(box, camera);
    assert.ok(visible.x >= 40 && visible.x + visible.width <= size.width - 40);
    assert.ok(visible.y >= 40 && visible.y + visible.height <= size.height - 40);
  }
});

test('A tall machine keeps its header visible; an explicit zoom is never changed', () => {
  const camera = outputCamera(layout, { width: 1035, height: 500 }, 1);
  assert.equal(camera.scale, 1);
  assert.equal(screenBox(producer, camera).y, 40);
  const zoomed = outputCamera(layout, { width: 1035, height: 800 }, 0.75);
  assert.equal(zoomed.scale, 0.75);
  assert.equal(outputCamera({ nodes: [], edges: [] }, { width: 1035, height: 800 }, 1), null);
});
