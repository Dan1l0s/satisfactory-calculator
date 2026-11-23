import { solve, initSolver, MODEL_INFO } from './solver.js';

let dataset;

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  const id = message.id;
  try {
    if (message.type === 'init') {
      if (message.data) dataset = message.data;
      await initSolver();
      self.postMessage({ id, type: 'ready', model: MODEL_INFO });
      return;
    }
    if (message.data) dataset = message.data;
    if (!dataset) throw new Error('Сначала загрузите базу рецептов');
    const result = await solve(dataset, message.options || message.opts || {});
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    self.postMessage({
      id,
      type: 'result',
      result: { status: 'error', message: error instanceof Error ? error.message : String(error) },
    });
  }
});
