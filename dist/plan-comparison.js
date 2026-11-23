import { primaryProduct } from './recipe-policy.js';

const EPSILON = 1e-6;
const finite = (value) => Number.isFinite(value) ? value : 0;
const near = (before, after) =>
  Math.abs(after - before) <= EPSILON * Math.max(1, Math.abs(before), Math.abs(after));

function values(before, after) {
  const delta = near(before, after) ? 0 : after - before;
  return { before, after, delta, percent: before === 0 ? null : delta / before * 100 };
}

function aggregateRates(rows = []) {
  const rates = new Map();
  for (const row of rows) {
    const item = row.itemId || row.item;
    const rate = finite(row.rate);
    if (item && rate > 0) rates.set(item, (rates.get(item) || 0) + rate);
  }
  return rates;
}

function rateChanges(beforeRows, afterRows) {
  const before = aggregateRates(beforeRows);
  const after = aggregateRates(afterRows);
  return [...new Set([...before.keys(), ...after.keys()])]
    .map((item) => {
      const comparison = values(before.get(item) || 0, after.get(item) || 0);
      const change = comparison.before === 0 ? 'added'
        : comparison.after === 0 ? 'removed'
          : comparison.delta > 0 ? 'increased' : 'decreased';
      return { item, ...comparison, change };
    })
    .filter((row) => row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) ||
      (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
}

export function comparePlans(before, after) {
  const metrics = Object.fromEntries(
    Object.entries({ resources: 'weightedResources', energy: 'powerMW', buildings: 'machines' })
      .map(([name, field]) => [
        name,
        values(finite(before?.totals?.[field]), finite(after?.totals?.[field])),
      ]),
  );
  if (before?.totals?.generationMW > 0 || after?.totals?.generationMW > 0)
    metrics.generation = values(finite(before?.totals?.generationMW), finite(after?.totals?.generationMW));
  return {
    metrics,
    resourceChanges: rateChanges(before?.resources, after?.resources),
    importChanges: rateChanges(before?.imports, after?.imports),
    surplusChanges: rateChanges(before?.surplus, after?.surplus),
  };
}

function positiveOutput(rate) {
  if (!Number.isFinite(rate) || rate <= 0)
    throw new RangeError('Output rate must be a positive finite number');
}

function scaled(value, multiplier) {
  const result = value * multiplier;
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(result))
    throw new RangeError('Production rates must be finite and nonnegative');
  return result;
}

function scaleFlows(flows, multiplier) {
  return Object.fromEntries(
    Object.entries(flows || {}).map(([item, rate]) => [item, scaled(rate, multiplier)]),
  );
}

export function recipeForOutput(recipe, itemId, outputRate) {
  positiveOutput(outputRate);
  const capacity = recipe?.outputs?.[itemId];
  positiveOutput(capacity);
  const machines = outputRate / capacity;
  positiveOutput(machines);
  return {
    machines,
    inputs: scaleFlows(recipe.inputs, machines),
    outputs: scaleFlows(recipe.outputs, machines),
    powerMW: scaled(recipe.powerMW, machines),
    ...(recipe.generationMW > 0 ? { generationMW: scaled(recipe.generationMW, machines) } : {}),
  };
}

export function currentProductionForOutput(data, result, itemId, outputRate) {
  positiveOutput(outputRate);
  const recipes = new Map((data.recipes || []).map((recipe) => [recipe.id, recipe]));
  const rows = (result?.recipes || []).filter((row) =>
    primaryProduct(recipes.get(row.recipeId || row.id)) === itemId,
  );
  if (!rows.length) return null;
  const total = { machines: 0, inputs: {}, outputs: {}, powerMW: 0 };
  let generationMW = 0;
  for (const row of rows) {
    total.machines += scaled(row.machines, 1);
    total.powerMW += scaled(row.powerMW, 1);
    generationMW += scaled(row.generationMW || 0, 1);
    for (const field of ['inputs', 'outputs']) {
      for (const [item, rate] of Object.entries(row[field] || {}))
        total[field][item] = (total[field][item] || 0) + scaled(rate, 1);
    }
  }
  const currentOutput = total.outputs[itemId];
  if (!currentOutput) return null;
  positiveOutput(currentOutput);
  const multiplier = outputRate / currentOutput;
  positiveOutput(multiplier);
  return {
    machines: scaled(total.machines, multiplier),
    inputs: scaleFlows(total.inputs, multiplier),
    outputs: scaleFlows(total.outputs, multiplier),
    powerMW: scaled(total.powerMW, multiplier),
    ...(generationMW > 0 ? { generationMW: scaled(generationMW, multiplier) } : {}),
  };
}
