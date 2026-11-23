const EPSILON = 1e-6;
const MAX_ENTRIES = 5000;
const STATUSES = new Set(['built', 'connected']);
const NUMBER_FIELDS = ['rate', 'machines', 'clock', 'capacity', 'purity'];
const NODE_ID = /^(recipe|resource|import|target|surplus):[A-Za-z0-9_.-]+$/;
const ITEM_ID = /^[A-Za-z0-9_.-]+$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nodeId = (value) => typeof value === 'string' && value.length <= 512 && NODE_ID.test(value);
const itemId = (value) => typeof value === 'string' && value.length <= 512 &&
  ITEM_ID.test(value) && !RESERVED.has(value);
const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const equalNumber = (a, b) => a === b || (a !== null && b !== null &&
  Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b)));

export function normalizeProgress(value) {
  const result = {};
  if (!record(value)) return result;
  let count = 0;
  for (const [id, status] of Object.entries(value)) {
    if (nodeId(id) && STATUSES.has(status)) {
      result[id] = status;
      count++;
    }
    if (count >= MAX_ENTRIES) break;
  }
  return result;
}

export function setNodeProgress(progress, id, status) {
  const next = normalizeProgress(progress);
  if (!nodeId(id)) return next;
  if (status === 'unstarted') delete next[id];
  else if (STATUSES.has(status)) next[id] = status;
  return next;
}

export function progressCounts(progress, nodeIds) {
  const states = normalizeProgress(progress);
  const ids = new Set((Array.isArray(nodeIds) ? nodeIds : []).filter(nodeId));
  let built = 0;
  let connected = 0;
  for (const id of ids) {
    if (states[id] === 'built') built++;
    if (states[id] === 'connected') connected++;
  }
  return { total: ids.size, built, connected, unfinished: ids.size - connected };
}

export function progressFilterValue(value) {
  return value === 'all' ? 'all' : 'unfinished';
}

function flows(value) {
  if (!record(value)) return null;
  const pairs = [];
  for (const [id, amount] of Object.entries(value)) {
    if (!itemId(id) || number(amount) === null) return null;
    if (amount > 0) pairs.push([id, amount]);
  }
  pairs.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(pairs);
}

function connections(value) {
  if (!Array.isArray(value)) return null;
  const grouped = new Map();
  for (const edge of value) {
    if (!record(edge) || !nodeId(edge.source) || !nodeId(edge.target) ||
      !itemId(edge.itemId) || number(edge.rate) === null) return null;
    if (edge.rate === 0) continue;
    const key = JSON.stringify([edge.source, edge.target, edge.itemId]);
    const previous = grouped.get(key);
    if (previous) {
      previous.rate += edge.rate;
      if (!Number.isFinite(previous.rate)) return null;
    }
    else grouped.set(key, {
      source: edge.source, target: edge.target, itemId: edge.itemId, rate: edge.rate,
    });
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([, edge]) => edge);
}

function signature(value, id) {
  if (!record(value) || value.kind !== id.split(':')[0] ||
    !(value.buildingId === null || typeof value.buildingId === 'string')) return null;
  const inputs = flows(value.inputs);
  const outputs = flows(value.outputs);
  if (!inputs || !outputs) return null;
  const result = { version: 1, kind: value.kind, buildingId: value.buildingId };
  for (const field of NUMBER_FIELDS) {
    if (value[field] !== undefined && value[field] !== null && number(value[field]) === null)
      return null;
    result[field] = number(value[field]);
  }
  result.inputs = inputs;
  result.outputs = outputs;
  const links = connections(value.connections);
  if (links) result.connections = links;
  return result;
}

export function normalizeProgressSignatures(value) {
  const result = {};
  if (!record(value)) return result;
  let count = 0;
  for (const [id, entry] of Object.entries(value)) {
    if (!nodeId(id)) continue;
    const normalized = signature(entry, id);
    if (normalized) {
      result[id] = normalized;
      count++;
    }
    if (count >= MAX_ENTRIES) break;
  }
  return result;
}

function equalFlows(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .every((id) => equalNumber(before[id] || 0, after[id] || 0));
}

function equalSignature(before, after) {
  return before.kind === after.kind && before.buildingId === after.buildingId &&
    NUMBER_FIELDS.every((field) => equalNumber(before[field], after[field])) &&
    equalFlows(before.inputs, after.inputs) && equalFlows(before.outputs, after.outputs);
}

function equalConnections(before, after) {
  const rates = (entries) => Object.fromEntries(entries.map((edge) => [
    JSON.stringify([edge.source, edge.target, edge.itemId]), edge.rate,
  ]));
  return equalFlows(rates(before), rates(after));
}

export function reconcileProgress(progress, previousSignatures, nodes, edges = []) {
  const states = normalizeProgress(progress);
  const previous = normalizeProgressSignatures(previousSignatures);
  const currentNodes = new Map((Array.isArray(nodes) ? nodes : [])
    .filter((node) => record(node) && nodeId(node.id))
    .map((node) => [node.id, node]));
  const incident = new Map();
  for (const edge of connections(edges) || []) {
    if (!currentNodes.has(edge.source) || !currentNodes.has(edge.target)) continue;
    for (const id of new Set([edge.source, edge.target])) {
      if (!incident.has(id)) incident.set(id, []);
      incident.get(id).push(edge);
    }
  }
  const next = {};
  const signatures = {};
  const resetIds = [];
  const downgradedIds = [];
  for (const [id, status] of Object.entries(states)) {
    const node = currentNodes.get(id);
    if (!node) continue;
    const entry = signature({
      kind: node.kind,
      buildingId: node.buildingId ?? node.data?.buildingId ?? null,
      rate: node.rate,
      machines: node.data?.machines ?? node.machines,
      clock: node.data?.clock,
      capacity: node.data?.capacity,
      purity: node.data?.purity,
      inputs: node.inputs ?? node.data?.inputs ?? {},
      outputs: node.outputs ?? node.data?.outputs ?? {},
      connections: incident.get(id) || [],
    }, id);
    if (!entry || (previous[id] && !equalSignature(previous[id], entry))) {
      resetIds.push(id);
      continue;
    }
    const rewired = previous[id]?.connections &&
      !equalConnections(previous[id].connections, entry.connections);
    next[id] = status === 'connected' && rewired ? 'built' : status;
    if (next[id] !== status) downgradedIds.push(id);
    signatures[id] = previous[id]
      ? { ...previous[id], connections: entry.connections }
      : entry;
  }
  return { progress: next, signatures, resetIds, downgradedIds };
}
