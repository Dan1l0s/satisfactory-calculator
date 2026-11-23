import { planTransport, transportLoadsLabel, transportSummary } from './transport.js';
import { resourceColor } from './resource-colors.js';
const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 320;
const HEIGHT = 282;
const COLUMN = 680;
const GAP = 120;
const PORT_HEADER = 218;
const PORT_STEP = 112;
const LABEL_WIDTH = 300;
const LABEL_HEIGHT = 112;
const COMPACT_LABEL_HEIGHT = 64;
const LANE_WIDTH = 9;
const LANE_PITCH = 13;
const MAX_DRAWN_LANES = 6;
const EPSILON = 1e-7;
const buildingRu = {
  Smelter: 'Плавильня',
  Foundry: 'Литейная',
  Constructor: 'Конструктор',
  Assembler: 'Сборщик',
  Manufacturer: 'Изготовитель',
  Refinery: 'НПЗ',
  Blender: 'Смеситель',
  Packager: 'Упаковщик',
  'Particle Accelerator': 'Ускоритель частиц',
  Converter: 'Конвертер',
  'Quantum Encoder': 'Квантовый кодировщик',
};

function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs))
    if (value != null) el.setAttribute(key, String(value));
  if (text != null) el.textContent = String(text);
  return el;
}
function num(value, digits = 2) {
  const v = Number(value) || 0;
  if (Math.abs(v) > 0 && Math.abs(v) < 10 ** -digits)
    return new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 3 }).format(v);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(v);
}
function entries(value) {
  if (Array.isArray(value))
    return value.map((v) => [v.itemId || v.item || v.id, Number(v.rate ?? v.amount ?? 0)]);
  return Object.entries(value || {}).map(([key, value]) => [key, Number(value)]);
}
function label(item) {
  return item?.nameRu || item?.name || item?.id || 'Материал';
}
function safeIcon(url) {
  if (typeof url !== 'string') return '';
  return /^(https?:\/\/|\.\/|\.\.\/|\/|data:image\/(png|webp|jpeg|gif);base64,)/i.test(url) ||
    /^[\w-]+\//.test(url)
    ? url
    : '';
}
function colorFor(itemId, item) {
  return resourceColor(itemId, item?.name || '');
}
function textLines(value, limit = 25) {
  const words = String(value).split(/\s+/);
  const lines = [''];
  for (const word of words) {
    const last = lines.length - 1;
    if (lines[last] && lines[last].length + word.length + 1 > limit) {
      if (lines.length === 2) {
        lines[last] = lines[last].slice(0, limit - 1) + '…';
        break;
      }
      lines.push(word.length > limit ? word.slice(0, limit - 1) + '…' : word);
    } else lines[last] += (lines[last] ? ' ' : '') + word;
  }
  return lines;
}
function trim(value, max = 29) {
  const s = String(value || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function fitLabel(element, maxWidth) {
  if (typeof element.getComputedTextLength !== 'function') return;
  const original = element.getAttribute('data-full-text') || element.textContent;
  element.setAttribute('data-full-text', original);
  element.textContent = original;
  if (element.getComputedTextLength() <= maxWidth) return;
  const characters = Array.from(original);
  let low = 0,
    high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    element.textContent = characters.slice(0, middle).join('').trimEnd() + '…';
    if (element.getComputedTextLength() <= maxWidth) low = middle;
    else high = middle - 1;
  }
  element.textContent = characters.slice(0, low).join('').trimEnd() + '…';
}
function finiteRate(value) {
  return Number.isFinite(Number(value)) && Number(value) > EPSILON ? Number(value) : 0;
}

export function buildFlowData(data, result) {
  const itemMap = new Map((data.items || []).map((v) => [v.id, v]));
  const recipeMap = new Map((data.recipes || []).map((v) => [v.id, v]));
  const buildingMap = new Map((data.buildings || []).map((v) => [v.id, v]));
  const nodes = [],
    edges = [],
    supplies = new Map(),
    demands = new Map();
  const addPool = (pool, item, node, rate) => {
    if (!item || !finiteRate(rate)) return;
    if (!pool.has(item)) pool.set(item, []);
    pool.get(item).push({ node, remaining: Number(rate) });
  };
  const addNode = (node) => {
    node.width = WIDTH;
    node.height = HEIGHT;
    node.color = colorFor(node.itemId, itemMap.get(node.itemId));
    node.nameRu = itemMap.get(node.itemId)?.nameRu || node.name;
    node.nameEn = itemMap.get(node.itemId)?.name || node.name;
    nodes.push(node);
    return node;
  };
  const aggregate = (list) => {
    const map = new Map();
    for (const record of list || []) {
      const item = record.itemId || record.item || record.id;
      if (!item || !finiteRate(record.rate)) continue;
      if (!map.has(item))
        map.set(item, { ...record, item, itemId: item, rate: Number(record.rate) });
      else map.get(item).rate += Number(record.rate);
    }
    return [...map.values()];
  };
  for (const record of aggregate(result.resources)) {
    const itemId = record.itemId;
    const buildingId =
      record.type === 'miner'
        ? `Build_MinerMk${record.tier || 3}_C`
        : record.type === 'water'
          ? 'Build_WaterPump_C'
          : record.type === 'oil'
            ? 'Build_OilPump_C'
            : record.type === 'well'
              ? 'Build_FrackingExtractor_C'
              : null;
    const building = buildingMap.get(buildingId);
    const node = addNode({
      id: `resource:${itemId}`,
      kind: 'resource',
      itemId,
      name: label(itemMap.get(itemId)),
      buildingId,
      buildingName: building?.nameRu || building?.name,
      buildingNameEn: building?.name,
      buildingIcon: building?.icon || (buildingId ? `icons/${buildingId}.png` : null),
      data: record,
      rate: record.rate,
      inputs: {},
      outputs: { [itemId]: record.rate },
    });
    addPool(supplies, itemId, node.id, record.rate);
  }
  for (const record of aggregate(result.imports)) {
    const itemId = record.itemId;
    const node = addNode({
      id: `import:${itemId}`,
      kind: 'import',
      itemId,
      name: label(itemMap.get(itemId)),
      data: record,
      rate: record.rate,
      inputs: {},
      outputs: { [itemId]: record.rate },
    });
    addPool(supplies, itemId, node.id, record.rate);
  }
  for (const record of result.recipes || []) {
    const recipeId = record.recipeId || record.id;
    const recipe = recipeMap.get(recipeId) || record;
    const output = entries(record.outputs).filter(([, v]) => finiteRate(v));
    const input = entries(record.inputs).filter(([, v]) => finiteRate(v));
    if (!recipeId || !output.length) continue;
    const itemId = recipe.primaryItem || recipe.primaryProduct || output[0][0];
    const building = buildingMap.get(record.buildingId || recipe.buildingId);
    const node = addNode({
      id: `recipe:${recipeId}`,
      kind: 'recipe',
      recipeId,
      itemId,
      name: label(itemMap.get(itemId)),
      recipeName: recipe.nameRu || recipe.name || record.name,
      recipeNameEn: recipe.name || record.name,
      buildingId: record.buildingId || recipe.buildingId || 'unknown',
      buildingName:
        building?.nameRu ||
        buildingRu[building?.name] ||
        building?.name ||
        record.buildingId ||
        'Производство',
      buildingNameEn: building?.name || record.buildingId || 'Production',
      buildingIcon: building?.icon,
      alternate: !!(recipe.alternate || recipe.isAlternate),
      data: record,
      rate: output.find((v) => v[0] === itemId)?.[1] || output[0][1],
      inputs: Object.fromEntries(input),
      outputs: Object.fromEntries(output),
    });
    for (const [item, rate] of input) addPool(demands, item, node.id, rate);
    for (const [item, rate] of output) addPool(supplies, item, node.id, rate);
  }
  for (const [kind, list] of [
    ['target', result.targets],
    ['surplus', result.surplus],
  ]) {
    for (const record of aggregate(list)) {
      const itemId = record.itemId;
      const node = addNode({
        id: `${kind}:${itemId}`,
        kind,
        itemId,
        name: label(itemMap.get(itemId)),
        data: record,
        rate: record.rate,
        inputs: { [itemId]: record.rate },
        outputs: {},
      });
      addPool(demands, itemId, node.id, record.rate);
    }
  }
  const addEdge = (source, target, itemId, rate) => {
    if (rate <= EPSILON) return;
    edges.push({
      id: `edge:${edges.length}`,
      source,
      target,
      itemId,
      form: itemMap.get(itemId)?.form || 'solid',
      rate,
      color: colorFor(itemId, itemMap.get(itemId)),
      width: Math.min(8, Math.max(2.6, 0.7 * Math.sqrt(rate))),
    });
  };
  const diagnostics = [];
  for (const itemId of new Set([...supplies.keys(), ...demands.keys()])) {
    const sources = supplies.get(itemId) || [],
      consumers = demands.get(itemId) || [];
    // Match recycled output before fresh extraction
    for (const source of sources) {
      const target = consumers.find((v) => v.node === source.node);
      if (!target) continue;
      const flow = Math.min(source.remaining, target.remaining);
      addEdge(source.node, target.node, itemId, flow);
      source.remaining -= flow;
      target.remaining -= flow;
    }
    let i = 0,
      j = 0;
    while (i < sources.length && j < consumers.length) {
      const source = sources[i],
        target = consumers[j];
      const flow = Math.min(source.remaining, target.remaining);
      addEdge(source.node, target.node, itemId, flow);
      source.remaining -= flow;
      target.remaining -= flow;
      if (source.remaining < EPSILON) i++;
      if (target.remaining < EPSILON) j++;
    }
    const supplyLeft = sources.reduce((sum, v) => sum + v.remaining, 0);
    const demandLeft = consumers.reduce((sum, v) => sum + v.remaining, 0);
    const tolerance = Math.max(
      1e-5,
      (sources.reduce((sum, v) => sum + v.remaining, 0) +
        consumers.reduce((sum, v) => sum + v.remaining, 0)) *
        1e-8,
    );
    if (supplyLeft > tolerance) {
      const id = `unallocated:${itemId}`;
      addNode({
        id,
        kind: 'surplus',
        itemId,
        name: label(itemMap.get(itemId)),
        rate: supplyLeft,
        inputs: { [itemId]: supplyLeft },
        outputs: {},
        data: { item: itemId, rate: supplyLeft, unresolved: true },
      });
      for (const source of sources) addEdge(source.node, id, itemId, source.remaining);
      diagnostics.push({ item: itemId, type: 'unallocated', rate: supplyLeft });
    }
    if (demandLeft > tolerance) {
      const id = `missing:${itemId}`;
      addNode({
        id,
        kind: 'resource',
        itemId,
        name: label(itemMap.get(itemId)),
        rate: demandLeft,
        inputs: {},
        outputs: { [itemId]: demandLeft },
        data: { item: itemId, rate: demandLeft, unresolved: true },
      });
      for (const consumer of consumers) addEdge(id, consumer.node, itemId, consumer.remaining);
      diagnostics.push({ item: itemId, type: 'missing', rate: demandLeft });
    }
  }
  return { nodes, edges, itemMap, buildingMap, diagnostics };
}

export function buildOverviewData(flow, expanded = new Set()) {
  const groups = new Map(),
    membership = new Map(),
    nodes = [],
    edges = [];
  for (const node of flow.nodes) {
    let groupId = null;
    if (node.kind === 'recipe')
      groupId = `module:${node.buildingId || node.data.buildingId || 'unknown'}`;
    else if (node.kind === 'resource' && !node.data.unresolved) groupId = 'module:resources';
    if (!groupId || expanded.has(groupId)) {
      nodes.push({ ...node });
      membership.set(node.id, node.id);
      continue;
    }
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(node);
    membership.set(node.id, groupId);
  }
  const modules = new Map();
  for (const [id, members] of groups) {
    const raw = id === 'module:resources',
      buildingId = raw ? 'resources' : members[0].buildingId;
    const building = flow.buildingMap?.get(buildingId);
    const nameRu = raw
      ? 'Добыча сырья'
      : building?.nameRu || buildingRu[building?.name] || building?.name || members[0].buildingName;
    const nameEn = raw ? 'Resource extraction' : building?.name || members[0].buildingName;
    const totalmachines = members.reduce((sum, n) => sum + (Number(n.data.machines) || 0), 0);
    const powerMW = members.reduce((sum, n) => sum + (Number(n.data.powerMW) || 0), 0);
    const generationMW = members.reduce((sum, n) => sum + (Number(n.data.generationMW) || 0), 0);
    const node = {
      id,
      kind: 'module',
      buildingId,
      itemId: members[0].itemId,
      name: nameRu,
      nameRu,
      nameEn,
      icon: raw ? 'icons/Build_MinerMk3_C.png' : building?.icon,
      color: raw ? '#91aaa4' : '#b8a58f',
      width: WIDTH,
      height: HEIGHT,
      rate: 0,
      inputs: {},
      outputs: {},
      data: {
        buildingId,
        recipes: raw ? [] : members.map((n) => n.data),
        resources: raw ? members.map((n) => n.data) : [],
        totalmachines,
        machines: totalmachines,
        powerMW,
        generationMW,
        recipeCount: raw ? 0 : members.length,
        resourceCount: raw ? members.length : 0,
        internalFlows: [],
        internalFlowCount: 0,
        inputs: {},
        outputs: {},
        memberIds: members.map((n) => n.id),
      },
    };
    nodes.push(node);
    modules.set(id, node);
  }
  const streams = new Map(),
    internal = new Map();
  for (const edge of flow.edges) {
    const source = membership.get(edge.source),
      target = membership.get(edge.target);
    if (source === target && modules.has(source)) {
      if (!internal.has(source)) internal.set(source, new Map());
      const map = internal.get(source);
      map.set(edge.itemId, (map.get(edge.itemId) || 0) + edge.rate);
      modules.get(source).data.internalFlowCount++;
      continue;
    }
    const key = `${source}\u0000${target}\u0000${edge.itemId}`;
    if (!streams.has(key))
      streams.set(key, {
        ...edge,
        source,
        target,
        rate: 0,
        aggregated: modules.has(source) || modules.has(target),
      });
    streams.get(key).rate += edge.rate;
  }
  for (const edge of streams.values()) {
    edge.id = `overview-edge:${edges.length}`;
    edge.width = Math.min(27, Math.max(3.5, 2.2 * Math.sqrt(edge.rate)));
    edges.push(edge);
    if (modules.has(edge.source)) {
      const m = modules.get(edge.source);
      m.outputs[edge.itemId] = (m.outputs[edge.itemId] || 0) + edge.rate;
    }
    if (modules.has(edge.target)) {
      const m = modules.get(edge.target);
      m.inputs[edge.itemId] = (m.inputs[edge.itemId] || 0) + edge.rate;
    }
  }
  for (const [id, module] of modules) {
    module.data.inputs = { ...module.inputs };
    module.data.outputs = { ...module.outputs };
    module.data.internalFlows = [...(internal.get(id) || new Map())].map(([item, rate]) => ({
      item,
      itemId: item,
      rate,
    }));
  }
  return { ...flow, nodes, edges, modules, membership };
}

function strongComponents(nodes, edges) {
  const adjacency = new Map(nodes.map((v) => [v.id, []]));
  for (const e of edges) adjacency.get(e.source)?.push(e.target);
  let counter = 0;
  const stack = [],
    onStack = new Set(),
    indices = new Map(),
    low = new Map(),
    components = [],
    componentFor = new Map();
  function visit(id) {
    indices.set(id, counter);
    low.set(id, counter++);
    stack.push(id);
    onStack.add(id);
    for (const next of adjacency.get(id) || []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id), low.get(next)));
      } else if (onStack.has(next)) low.set(id, Math.min(low.get(id), indices.get(next)));
    }
    if (low.get(id) !== indices.get(id)) return;
    const group = [];
    let v;
    do {
      v = stack.pop();
      onStack.delete(v);
      componentFor.set(v, components.length);
      group.push(v);
    } while (v !== id);
    components.push(group);
  }
  for (const node of nodes) if (!indices.has(node.id)) visit(node.id);
  return { components, componentFor };
}

// Dummy slots keep long forward links out of cards
function layoutLegacyFlow(nodesInput, edgesInput, { maximumColumns } = {}) {
  const nodes = nodesInput.map((v) => ({ ...v })),
    edges = edgesInput.map((v) => ({ ...v }));
  if (!nodes.length) return { nodes, edges, bounds: { x: 0, y: 0, width: 600, height: 400 } };
  const nodeMap = new Map(nodes.map((v) => [v.id, v]));
  const { components, componentFor } = strongComponents(nodes, edges);
  const dag = components.map(() => new Set()),
    degrees = components.map(() => 0),
    ranks = components.map(() => 0);
  for (const edge of edges) {
    const a = componentFor.get(edge.source),
      b = componentFor.get(edge.target);
    if (a !== b && !dag[a].has(b)) {
      dag[a].add(b);
      degrees[b]++;
    }
  }
  const queue = degrees.map((v, i) => (v === 0 ? i : -1)).filter((v) => v >= 0);
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q];
    for (const v of dag[u]) {
      ranks[v] = Math.max(ranks[v], ranks[u] + 1);
      if (--degrees[v] === 0) queue.push(v);
    }
  }
  const compact = Number.isFinite(maximumColumns) && maximumColumns >= 3;
  const columnLimit = compact ? Math.max(3, Math.floor(maximumColumns)) : null;
  const productionNodes = nodes.filter(
    (n) => n.kind === 'recipe' || (n.kind === 'module' && n.id !== 'module:resources'),
  );
  const productionOrder = [...productionNodes].sort(
    (a, b) =>
      ranks[componentFor.get(a.id)] - ranks[componentFor.get(b.id)] || a.id.localeCompare(b.id),
  );
  const compactRank = new Map(
    productionOrder.map((n, i) => [
      n.id,
      1 +
        Math.min(
          (columnLimit || 3) - 3,
          Math.floor((i * ((columnLimit || 3) - 2)) / Math.max(1, productionOrder.length)),
        ),
    ]),
  );
  const mappedRank = (node) => {
    const original = ranks[componentFor.get(node.id)];
    if (!compact) return original;
    if (node.kind === 'resource' || node.kind === 'import' || node.id === 'module:resources')
      return 0;
    if (node.kind === 'target' || node.kind === 'surplus') return columnLimit - 1;
    return compactRank.get(node.id) || 1;
  };
  const maxRank = compact ? columnLimit - 1 : Math.max(...ranks);
  let layers = Array.from({ length: maxRank + 1 }, () => []);
  const columnStep = compact ? WIDTH + 88 : COLUMN;
  const originX = compact ? 42 : 64,
    originY = compact ? 44 : 64;
  const unitMap = new Map();
  for (const node of nodes) {
    node.rank = mappedRank(node);
    node.component = componentFor.get(node.id);
    node.height = HEIGHT;
    node.width = WIDTH;
    node.isCycle = components[node.component].length > 1;
    layers[node.rank].push(node);
    unitMap.set(node.id, node);
  }
  if (compact) {
    layers = layers.filter((layer) => layer.length);
    layers.forEach((layer, rank) => layer.forEach((node) => (node.rank = rank)));
  }
  const orderingEdges = [];
  for (const edge of edges) {
    const a = nodeMap.get(edge.source),
      b = nodeMap.get(edge.target);
    edge.dummies = [];
    if (b.rank <= a.rank) {
      edge.backward = true;
      continue;
    }
    if (compact && b.rank > a.rank + 1) {
      edge.longForward = true;
      orderingEdges.push({ source: a.id, target: b.id, weight: Math.sqrt(edge.rate) });
      continue;
    }
    let previous = a.id;
    for (let rank = a.rank + 1; rank < b.rank; rank++) {
      const dummy = {
        id: `dummy:${edge.id}:${rank}`,
        rank,
        height: Math.max(18, edge.width + 7),
        width: WIDTH,
        dummy: true,
      };
      layers[rank].push(dummy);
      unitMap.set(dummy.id, dummy);
      edge.dummies.push(dummy);
      orderingEdges.push({ source: previous, target: dummy.id, weight: Math.sqrt(edge.rate) });
      previous = dummy.id;
    }
    orderingEdges.push({ source: previous, target: b.id, weight: Math.sqrt(edge.rate) });
  }
  const incoming = new Map(),
    outgoing = new Map();
  for (const e of orderingEdges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    if (!outgoing.has(e.source)) outgoing.set(e.source, []);
    incoming.get(e.target).push(e);
    outgoing.get(e.source).push(e);
  }
  const kindSort = { resource: 0, import: 1, recipe: 2, target: 3, surplus: 4 };
  for (const layer of layers)
    layer.sort(
      (a, b) =>
        (kindSort[a.kind] ?? 2) - (kindSort[b.kind] ?? 2) ||
        String(a.name || a.id).localeCompare(String(b.name || b.id), 'ru'),
    );
  function assignY() {
    const layerHeights = layers.map(
      (layer) => layer.reduce((sum, v) => sum + v.height, 0) + Math.max(0, layer.length - 1) * GAP,
    );
    const maxHeight = Math.max(...layerHeights);
    layers.forEach((layer, rank) => {
      let y = (maxHeight - layerHeights[rank]) / 2 + originY;
      for (const node of layer) {
        node.x = rank * columnStep + originX;
        node.y = y;
        node.center = y + node.height / 2;
        y += node.height + GAP;
      }
    });
  }
  assignY();
  for (let iteration = 0; iteration < 8; iteration++) {
    const forward = iteration % 2 === 0;
    for (let step = 0; step < layers.length; step++) {
      const rank = forward ? step : layers.length - step - 1;
      const layer = layers[rank];
      const barycenter = (node) => {
        const links = (forward ? incoming : outgoing).get(node.id) || [];
        if (!links.length) return node.center;
        let sum = 0,
          weight = 0;
        for (const edge of links) {
          const other = unitMap.get(forward ? edge.source : edge.target);
          sum += other.center * edge.weight;
          weight += edge.weight;
        }
        return sum / weight;
      };
      const order = new Map(layer.map((v, i) => [v.id, i]));
      layer.sort((a, b) => barycenter(a) - barycenter(b) || order.get(a.id) - order.get(b.id));
      assignY();
    }
  }
  const inLinks = new Map(),
    outLinks = new Map();
  for (const edge of edges) {
    if (!outLinks.has(edge.source)) outLinks.set(edge.source, []);
    if (!inLinks.has(edge.target)) inLinks.set(edge.target, []);
    outLinks.get(edge.source).push(edge);
    inLinks.get(edge.target).push(edge);
  }
  for (const [map, side] of [
    [inLinks, 'targetY'],
    [outLinks, 'sourceY'],
  ]) {
    for (const [id, links] of map) {
      const node = nodeMap.get(id);
      links.sort((a, b) => {
        const otherA = nodeMap.get(side === 'targetY' ? a.source : a.target);
        const otherB = nodeMap.get(side === 'targetY' ? b.source : b.target);
        return otherA.center - otherB.center || a.itemId.localeCompare(b.itemId);
      });
      const usable = HEIGHT - 30;
      links.forEach(
        (edge, i) => (edge[side] = node.y + 15 + (usable * (i + 1)) / (links.length + 1)),
      );
    }
  }
  let bottom = Math.max(...nodes.map((v) => v.y + HEIGHT));
  const graphRight = Math.max(...nodes.map((v) => v.x + WIDTH));
  let backIndex = 0,
    compactLaneIndex = 0;
  for (const edge of edges) {
    const source = nodeMap.get(edge.source),
      target = nodeMap.get(edge.target);
    const x0 = source.x + WIDTH,
      y0 = edge.sourceY,
      x1 = target.x,
      y1 = edge.targetY;
    if (compact && edge.longForward) {
      const y = bottom + 23 + (compactLaneIndex++ % 3) * 9,
        right = x0 + 30,
        left = x1 - 30,
        r = 12;
      edge.path = `M ${x0} ${y0} Q ${right} ${y0} ${right} ${y0 + r} L ${right} ${y - r} Q ${right} ${y} ${right + r} ${y} L ${left - r} ${y} Q ${left} ${y} ${left} ${y - r} L ${left} ${y1 + r} Q ${left} ${y1} ${x1} ${y1}`;
      edge.labelX = (right + left) / 2;
      edge.labelY = y;
    } else if (!edge.backward) {
      const points = [
        { x: x0, y: y0 },
        ...edge.dummies.map((v) => ({ x: v.x + WIDTH / 2, y: v.center })),
        { x: x1, y: y1 },
      ];
      let path = `M ${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
          b = points[i],
          middle = (a.x + b.x) / 2;
        path += ` C ${middle} ${a.y}, ${middle} ${b.y}, ${b.x} ${b.y}`;
      }
      edge.path = path;
      const p = points[Math.floor((points.length - 1) / 2)],
        q = points[Math.ceil((points.length - 1) / 2)];
      edge.labelX = (p.x + q.x) / 2;
      edge.labelY = (p.y + q.y) / 2;
    } else if (source.id === target.id) {
      const y = source.y - 31,
        r = 14,
        right = x0 + 42,
        left = x1 - 39;
      edge.path = `M ${x0} ${y0} C ${right} ${y0}, ${right} ${y0}, ${right} ${y0 - r} L ${right} ${y + r} Q ${right} ${y} ${right - r} ${y} L ${left + r} ${y} Q ${left} ${y} ${left} ${y + r} L ${left} ${y1 - r} Q ${left} ${y1} ${x1} ${y1}`;
      edge.labelX = source.x + WIDTH / 2;
      edge.labelY = y;
      edge.loop = true;
    } else if (compact && source.rank === target.rank) {
      const slot = backIndex++ % 3,
        right = x0 + 29 + slot * 6,
        left = x1 - 27 - slot * 6,
        r = 12;
      const crossY =
        source.center < target.center ? target.y - GAP / 2 : target.y + HEIGHT + GAP / 2;
      const outgoingSign = crossY > y0 ? 1 : -1,
        incomingSign = y1 > crossY ? 1 : -1;
      edge.path = `M ${x0} ${y0} Q ${right} ${y0} ${right} ${y0 + outgoingSign * r} L ${right} ${crossY - outgoingSign * r} Q ${right} ${crossY} ${right - r} ${crossY} L ${left + r} ${crossY} Q ${left} ${crossY} ${left} ${crossY + incomingSign * r} L ${left} ${y1 - incomingSign * r} Q ${left} ${y1} ${x1} ${y1}`;
      edge.labelX = source.x + WIDTH / 2;
      edge.labelY = crossY;
      edge.loop = true;
      edge.withinColumn = true;
    } else {
      const lane = backIndex++,
        y = compact ? bottom + 23 + (compactLaneIndex++ % 3) * 9 : bottom + 55 + lane * 31,
        right = x0 + (compact ? 29 : 47) + (lane % 3) * (compact ? 6 : 12),
        left = x1 - (compact ? 27 : 45) - (lane % 3) * (compact ? 6 : 12),
        r = compact ? 12 : 18;
      edge.path = `M ${x0} ${y0} Q ${right} ${y0} ${right} ${y0 + r} L ${right} ${y - r} Q ${right} ${y} ${right - r} ${y} L ${left + r} ${y} Q ${left} ${y} ${left} ${y - r} L ${left} ${y1 + r} Q ${left} ${y1} ${x1} ${y1}`;
      edge.labelX = (left + right) / 2;
      edge.labelY = y;
      edge.loop = true;
    }
  }
  const outerLoops = edges.filter((e) => e.loop && !e.withinColumn && e.source !== e.target).length;
  return {
    nodes,
    edges,
    bounds: {
      x: 0,
      y: 0,
      width: graphRight + (compact ? 56 : 90),
      height: bottom + (compact ? 64 : outerLoops ? 86 + backIndex * 31 : 64),
    },
    componentCount: components.length,
  };
}

// Prefer primary products when ordering cycles; keep every return edge
function orderComponent(ids, nodeMap, edges) {
  const remaining = new Set(ids),
    head = [],
    tail = [];
  const local = edges.filter(
    (e) => remaining.has(e.source) && remaining.has(e.target) && e.source !== e.target,
  );
  while (remaining.size) {
    const score = (id) => {
      let incoming = 0,
        outgoing = 0;
      for (const e of local) {
        if (!remaining.has(e.source) || !remaining.has(e.target)) continue;
        const weight = nodeMap.get(e.source)?.itemId === e.itemId ? 4 : 1;
        if (e.source === id) outgoing += weight;
        if (e.target === id) incoming += weight;
      }
      return { id, incoming, outgoing };
    };
    const scored = [...remaining].map(score);
    const source = scored.find((n) => !n.incoming),
      sink = scored.find((n) => !n.outgoing);
    const chosen =
      source ||
      sink ||
      scored.sort(
        (a, b) => b.outgoing - b.incoming - (a.outgoing - a.incoming) || a.id.localeCompare(b.id),
      )[0];
    if (!source && sink) tail.unshift(chosen.id);
    else head.push(chosen.id);
    remaining.delete(chosen.id);
  }
  return [...head, ...tail];
}

function makeRoute(start) {
  const points = [{ ...start }],
    commands = [`M ${start.x} ${start.y}`];
  return {
    points,
    line(end) {
      const previous = points[points.length - 1],
        length = Math.hypot(end.x - previous.x, end.y - previous.y),
        steps = Math.max(1, Math.ceil(length / 16));
      for (let i = 1; i <= steps; i++)
        points.push({
          x: previous.x + ((end.x - previous.x) * i) / steps,
          y: previous.y + ((end.y - previous.y) * i) / steps,
        });
      commands.push(`L ${end.x} ${end.y}`);
    },
    curve(c1, c2, end) {
      const start = points[points.length - 1];
      const length =
        Math.hypot(c1.x - start.x, c1.y - start.y) +
        Math.hypot(c2.x - c1.x, c2.y - c1.y) +
        Math.hypot(end.x - c2.x, end.y - c2.y);
      const steps = Math.max(18, Math.ceil(length / 12));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps,
          u = 1 - t;
        points.push({
          x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
          y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
        });
      }
      commands.push(`C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`);
    },
    get path() {
      return commands.join(' ');
    },
  };
}

function offsetRoute(points, offset) {
  return points.map((point, i) => {
    const previous = points[Math.max(0, i - 1)],
      next = points[Math.min(points.length - 1, i + 1)];
    const endpoint = i === 0 || i === points.length - 1;
    const dx = endpoint ? 1 : next.x - previous.x,
      dy = endpoint ? 0 : next.y - previous.y,
      length = Math.hypot(dx, dy) || 1;
    return { x: point.x - (dy / length) * offset, y: point.y + (dx / length) * offset };
  });
}
function pointsPath(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
}
function routeDirections(points, step = 154) {
  const result = [];
  let distance = 0,
    next = 60;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = Math.hypot(b.x - a.x, b.y - a.y);
    while (length && distance + length >= next) {
      const t = (next - distance) / length;
      result.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      });
      next += step;
    }
    distance += length;
  }
  return result;
}

function routeCrossings(edges) {
  const buckets = new Map(),
    crossings = [],
    seen = new Set(),
    cell = 128;
  const order = [...edges].sort((a, b) => Number(b.loop) - Number(a.loop));
  for (const edge of order) {
    edge.crossings = [];
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1],
        b = edge.points[i];
      const gx0 = Math.floor(Math.min(a.x, b.x) / cell),
        gx1 = Math.floor(Math.max(a.x, b.x) / cell),
        gy0 = Math.floor(Math.min(a.y, b.y) / cell),
        gy1 = Math.floor(Math.max(a.y, b.y) / cell);
      const checked = new Set();
      for (let gx = gx0; gx <= gx1; gx++)
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = `${gx}:${gy}`,
            existing = buckets.get(key) || [];
          for (const other of existing) {
            if (other.edge.id === edge.id || checked.has(other)) continue;
            checked.add(other);
            const c = other.a,
              d = other.b,
              rx = b.x - a.x,
              ry = b.y - a.y,
              sx = d.x - c.x,
              sy = d.y - c.y,
              den = rx * sy - ry * sx;
            if (Math.abs(den) < 1e-7) continue;
            const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den,
              u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            const point = { x: a.x + rx * t, y: a.y + ry * t },
              pair = [edge.id, other.edge.id].sort().join('|');
            const fingerprint = `${pair}:${Math.round(point.x / 12)}:${Math.round(point.y / 12)}`;
            if (seen.has(fingerprint)) continue;
            seen.add(fingerprint);
            const crossing = {
              ...point,
              over: edge.id,
              under: other.edge.id,
              angle: (Math.atan2(ry, rx) * 180) / Math.PI,
            };
            crossings.push(crossing);
            edge.crossings.push(crossing);
          }
        }
      const segment = { edge, a, b };
      for (let gx = gx0; gx <= gx1; gx++)
        for (let gy = gy0; gy <= gy1; gy++) {
          const key = `${gx}:${gy}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(segment);
        }
    }
  }
  return crossings;
}

// Reserve label bays and external return lanes without shrinking the cards
export function layoutFlow(nodesInput, edgesInput, options = {}) {
  if (options.maximumColumns) return layoutLegacyFlow(nodesInput, edgesInput, options);
  const gap = Number.isFinite(options.gap) ? Math.max(340, options.gap) : 360;
  const transportOptions = { beltTier: 5, pipeTier: 2, ...options.transport };
  const compact = options.compact === true;
  const labelHeight = compact ? COMPACT_LABEL_HEIGHT : LABEL_HEIGHT;
  const nodes = nodesInput.map((n) => ({ ...n, width: WIDTH, compact }));
  const edges = edgesInput.map((e) => {
    const transport = planTransport(e.form || 'solid', e.rate, transportOptions),
      drawnLanes = Math.min(MAX_DRAWN_LANES, transport.count);
    const bundleWidth = LANE_WIDTH + Math.max(0, drawnLanes - 1) * LANE_PITCH;
    return {
      ...e,
      width: Math.min(8, Math.max(2.6, 0.7 * Math.sqrt(e.rate))),
      transport,
      drawnLanes,
      bundleWidth,
      portPitch: labelHeight + bundleWidth + 18,
    };
  });
  if (!nodes.length)
    return {
      nodes,
      edges,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
      crossings: [],
      verticalTracks: [],
      columnGap: gap,
    };
  const map = new Map(nodes.map((n) => [n.id, n])),
    incoming = new Map(),
    outgoing = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    incoming.get(edge.target).push(edge);
    outgoing.get(edge.source).push(edge);
  }
  for (const node of nodes) {
    const input = incoming.get(node.id) || [],
      output = outgoing.get(node.id) || [];
    node.portCount = Math.max(1, input.length, output.length);
    node.portHeader = compact ? 142 : node.buildingId ? PORT_HEADER : 174;
    node.portArea = Math.max(
      compact ? 82 : PORT_STEP,
      input.reduce((sum, e) => sum + e.portPitch, 0),
      output.reduce((sum, e) => sum + e.portPitch, 0),
    );
    node.height = node.portHeader + node.portArea + 24;
  }
  const { components, componentFor } = strongComponents(nodes, edges);
  const componentOrders = components.map((ids) => orderComponent(ids, map, edges));
  const dag = components.map(() => new Set()),
    degrees = components.map(() => 0),
    starts = components.map(() => 0);
  for (const edge of edges) {
    const a = componentFor.get(edge.source),
      b = componentFor.get(edge.target);
    if (a !== b && !dag[a].has(b)) {
      dag[a].add(b);
      degrees[b]++;
    }
  }
  const queue = degrees.map((v, i) => (v === 0 ? i : -1)).filter((v) => v >= 0);
  for (let i = 0; i < queue.length; i++)
    for (const next of dag[queue[i]]) {
      starts[next] = Math.max(starts[next], starts[queue[i]] + componentOrders[queue[i]].length);
      if (--degrees[next] === 0) queue.push(next);
    }
  for (const node of nodes) {
    node.component = componentFor.get(node.id);
    node.rank = starts[node.component] + componentOrders[node.component].indexOf(node.id);
  }
  const layers = Array.from({ length: Math.max(...nodes.map((n) => n.rank)) + 1 }, () => []),
    units = new Map();
  for (const node of nodes) {
    layers[node.rank].push(node);
    units.set(node.id, node);
  }
  const orderEdges = [];
  for (const edge of edges) {
    const source = map.get(edge.source),
      target = map.get(edge.target);
    edge.dummies = [];
    edge.backward = target.rank <= source.rank;
    edge.loop = edge.backward;
    if (edge.backward) continue;
    let previous = source.id;
    for (let rank = source.rank + 1; rank < target.rank; rank++) {
      const dummy = {
        id: `route:${edge.id}:${rank}`,
        rank,
        width: WIDTH,
        height: edge.bundleWidth + 12,
        dummy: true,
      };
      layers[rank].push(dummy);
      units.set(dummy.id, dummy);
      edge.dummies.push(dummy);
      orderEdges.push({ source: previous, target: dummy.id });
      previous = dummy.id;
    }
    orderEdges.push({ source: previous, target: target.id });
  }
  const adjacentIn = new Map(),
    adjacentOut = new Map();
  for (const e of orderEdges) {
    if (!adjacentIn.has(e.target)) adjacentIn.set(e.target, []);
    if (!adjacentOut.has(e.source)) adjacentOut.set(e.source, []);
    adjacentIn.get(e.target).push(e.source);
    adjacentOut.get(e.source).push(e.target);
  }
  for (const layer of layers)
    layer.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'ru'));
  function place() {
    const heights = layers.map(
        (layer) =>
          layer.reduce((sum, n) => sum + n.height, 0) + Math.max(0, layer.length - 1) * GAP,
      ),
      maxHeight = Math.max(...heights);
    layers.forEach((layer, rank) => {
      let y = 80 + (maxHeight - heights[rank]) / 2;
      for (const n of layer) {
        n.x = 360 + rank * (WIDTH + gap);
        n.y = y;
        n.center = y + n.height / 2;
        y += n.height + GAP;
      }
    });
  }
  place();
  for (let iteration = 0; iteration < 10; iteration++) {
    const forward = iteration % 2 === 0;
    for (let step = 0; step < layers.length; step++) {
      const rank = forward ? step : layers.length - step - 1,
        layer = layers[rank],
        oldOrder = new Map(layer.map((n, i) => [n.id, i]));
      const barycenter = (n) => {
        const ids = (forward ? adjacentIn : adjacentOut).get(n.id) || [];
        return ids.length
          ? ids.reduce((sum, id) => sum + units.get(id).center, 0) / ids.length
          : n.center;
      };
      layer.sort(
        (a, b) => barycenter(a) - barycenter(b) || oldOrder.get(a.id) - oldOrder.get(b.id),
      );
      place();
    }
  }
  const pairCost = (upper, lower) => {
    let cost = 0;
    for (const pool of [adjacentIn, adjacentOut])
      for (const a of pool.get(upper.id) || [])
        for (const b of pool.get(lower.id) || [])
          if (units.get(a).center > units.get(b).center) cost++;
    return cost;
  };
  for (let pass = 0; pass < 4; pass++)
    for (const layer of layers) {
      for (let i = 0; i < layer.length - 1; i++)
        if (pairCost(layer[i], layer[i + 1]) > pairCost(layer[i + 1], layer[i])) {
          [layer[i], layer[i + 1]] = [layer[i + 1], layer[i]];
          place();
        }
    }
  for (const [pool, side] of [
    [incoming, 'targetY'],
    [outgoing, 'sourceY'],
  ])
    for (const [id, list] of pool) {
      const node = map.get(id);
      const neighboringY = (edge) => {
        if (!edge.backward && edge.dummies.length)
          return (side === 'targetY' ? edge.dummies.at(-1) : edge.dummies[0]).center;
        return map.get(side === 'targetY' ? edge.source : edge.target).center;
      };
      list.sort((a, b) => neighboringY(a) - neighboringY(b) || a.itemId.localeCompare(b.itemId));
      let cursor =
        node.y +
        node.portHeader +
        (node.portArea - list.reduce((sum, e) => sum + e.portPitch, 0)) / 2;
      list.forEach((edge, index) => {
        edge[side] = cursor + labelHeight + 14 + edge.bundleWidth / 2;
        edge[side === 'targetY' ? 'targetSlot' : 'sourceSlot'] = index;
        cursor += edge.portPitch;
      });
    }
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  let outerHeight = 0;
  const corridorIntervals = new Map();
  function step(edge, gapIndex, fromY, toY) {
    const value = { edgeId: edge.id, gapIndex, fromY, toY, track: 0, width: edge.bundleWidth };
    if (!corridorIntervals.has(gapIndex)) corridorIntervals.set(gapIndex, []);
    corridorIntervals.get(gapIndex).push(value);
    return value;
  }
  for (const edge of edges) {
    const source = map.get(edge.source),
      target = map.get(edge.target),
      sy = edge.sourceY,
      ty = edge.targetY;
    edge.routeSteps = [];
    if (!edge.backward) {
      let previousRank = source.rank,
        previousY = sy;
      for (const dummy of edge.dummies) {
        edge.routeSteps.push(step(edge, previousRank, previousY, dummy.center));
        previousRank = dummy.rank;
        previousY = dummy.center;
      }
      edge.routeSteps.push(step(edge, previousRank, previousY, ty));
    } else {
      outerHeight += edge.bundleWidth + 48;
      edge.returnY = bottom + 80 + outerHeight;
      edge.routeSteps.push(
        step(edge, source.rank, sy, edge.returnY),
        step(edge, target.rank - 1, edge.returnY, ty),
      );
    }
  }
  const corridorSizes = new Map(),
    trackOffsets = new Map();
  for (const [corridor, intervals] of corridorIntervals) {
    intervals.sort(
      (a, b) =>
        Math.min(a.fromY, a.toY) - Math.min(b.fromY, b.toY) ||
        Math.max(a.fromY, a.toY) - Math.max(b.fromY, b.toY),
    );
    const ends = [],
      widths = [];
    for (const segment of intervals) {
      const lo = Math.min(segment.fromY, segment.toY) - segment.width / 2 - 18,
        hi = Math.max(segment.fromY, segment.toY) + segment.width / 2 + 18;
      let track = ends.findIndex((end) => end < lo);
      if (track < 0) track = ends.length;
      segment.track = track;
      ends[track] = hi;
      widths[track] = Math.max(widths[track] || 0, segment.width);
    }
    let x = 72;
    const offsets = [];
    for (const width of widths) {
      const slot = Math.max(34, (width + 20) / 0.7);
      offsets.push(x + slot / 2);
      x += slot;
    }
    corridorSizes.set(corridor, Math.max(270, x + 72) + (gap - 360));
    trackOffsets.set(corridor, offsets);
  }
  const routingWidth = (index) => corridorSizes.get(index) || 270 + (gap - 360);
  const columnGaps = Array.from(
    { length: Math.max(0, layers.length - 1) },
    (_, i) => LABEL_WIDTH + 46 + routingWidth(i),
  );
  const columnX = [360];
  for (let i = 1; i < layers.length; i++) columnX[i] = columnX[i - 1] + WIDTH + columnGaps[i - 1];
  for (const layer of layers) for (const unit of layer) unit.x = columnX[unit.rank];
  const corridorLeft = (index) =>
    index < 0 ? columnX[0] - LABEL_WIDTH - 46 - routingWidth(index) : columnX[index] + WIDTH;
  const corridorX = (segment) =>
    corridorLeft(segment.gapIndex) +
    LABEL_WIDTH + 46 +
    (trackOffsets.get(segment.gapIndex)?.[segment.track] || routingWidth(segment.gapIndex) / 2);
  const verticalTracks = [];
  for (const edge of edges) {
    const source = map.get(edge.source),
      target = map.get(edge.target),
      sx = source.x + WIDTH,
      tx = target.x,
      sy = edge.sourceY,
      ty = edge.targetY;
    edge.targetX = tx;
    edge.sourceX = sx;
    edge.labelBox = {
      x: sx + 20,
      y: sy - edge.bundleWidth / 2 - labelHeight - 9,
      width: LABEL_WIDTH,
      height: labelHeight,
    };
    edge.labelX = edge.labelBox.x + LABEL_WIDTH / 2;
    edge.labelY = edge.labelBox.y + labelHeight / 2;
    const route = makeRoute({ x: sx, y: sy });
    if (!edge.backward) {
      for (let i = 0; i < edge.routeSteps.length; i++) {
        const segment = edge.routeSteps[i],
          dummy = edge.dummies[i],
          endpointX = (dummy ? dummy.x : tx) - 36,
          startX = i ? edge.dummies[i - 1].x + WIDTH : sx;
        const middleX = corridorX(segment);
        route.line({ x: startX + LABEL_WIDTH + 36, y: segment.fromY });
        route.curve(
          { x: middleX, y: segment.fromY },
          { x: middleX, y: segment.toY },
          { x: endpointX, y: segment.toY },
        );
        route.line({ x: dummy ? dummy.x + WIDTH : tx, y: segment.toY });
        verticalTracks.push({ ...segment, x: middleX });
      }
    } else {
      const exit = edge.routeSteps[0],
        enter = edge.routeSteps[1],
        rx = corridorX(exit),
        lx = corridorX(enter),
        by = edge.returnY,
        ex = tx - 36,
        exitX = sx + LABEL_WIDTH + 36;
      const r = Math.min(54, (rx - exitX) / 2, (ex - lx) / 2, (by - sy) / 4, (by - ty) / 4);
      route.line({ x: exitX, y: sy });
      route.curve({ x: rx, y: sy }, { x: rx, y: sy + r }, { x: rx, y: sy + 2 * r });
      route.line({ x: rx, y: by - 2 * r });
      route.curve({ x: rx, y: by }, { x: rx - r, y: by }, { x: rx - 2 * r, y: by });
      route.line({ x: lx + 2 * r, y: by });
      route.curve({ x: lx, y: by }, { x: lx, y: by - r }, { x: lx, y: by - 2 * r });
      route.line({ x: lx, y: ty + 2 * r });
      route.curve({ x: lx, y: ty }, { x: ex - r, y: ty }, { x: ex, y: ty });
      route.line({ x: tx, y: ty });
      verticalTracks.push({ ...exit, x: rx }, { ...enter, x: lx });
    }
    edge.points = route.points;
    edge.path = route.path;
    edge.lanes = Array.from({ length: edge.drawnLanes }, (_, i) => {
      const offset = (i - (edge.drawnLanes - 1) / 2) * LANE_PITCH,
        points = offsetRoute(edge.points, offset);
      return {
        index: i,
        number: i === edge.drawnLanes - 1 ? edge.transport.count : i + 1,
        load: i === edge.drawnLanes - 1 ? edge.transport.lastLoad : edge.transport.capacity,
        offset,
        points,
        path: pointsPath(points),
        directions: routeDirections(points),
      };
    });
  }
  const crossings = routeCrossings(edges);
  let minX = Math.min(...nodes.map((n) => n.x), ...edges.map((e) => e.labelBox.x)),
    right = Math.max(...nodes.map((n) => n.x + n.width), ...edges.map((e) => e.labelBox.x + e.labelBox.width));
  for (const edge of edges)
    for (const lane of edge.lanes)
      for (const point of lane.points) {
        minX = Math.min(minX, point.x);
        right = Math.max(right, point.x);
      }
  minX -= 44;
  right += 70;
  return {
    nodes,
    edges,
    bounds: { x: minX, y: 0, width: right - minX, height: bottom + outerHeight + 180 },
    componentCount: components.length,
    columnGap: gap,
    columnGaps,
    verticalTracks,
    crossings,
  };
}

// Keep the scale and prioritize the final machine when the target is too far away
export function outputCamera(layout, dimensions, scale = 1) {
  const target = layout.nodes.find((node) => node.kind === 'target') || layout.nodes.at(-1);
  if (!target) return null;
  const padding = 40,
    width = dimensions.width,
    height = dimensions.height,
    nodeMap = new Map(layout.nodes.map((node) => [node.id, node]));
  const producers = layout.edges
    .filter((edge) => edge.target === target.id && edge.source !== target.id)
    .map((edge) => ({ edge, node: nodeMap.get(edge.source) }))
    .filter((value) => value.node)
    .sort(
      (a, b) =>
        Number(b.node.kind === 'recipe') - Number(a.node.kind === 'recipe') ||
        b.edge.rate - a.edge.rate,
    );
  const producer = producers[0]?.node || target;
  const producerRight = Math.max(producer.x + producer.width, ...layout.edges
    .filter((edge) => edge.source === producer.id && edge.labelBox)
    .map((edge) => edge.labelBox.x + edge.labelBox.width));
  const left = Math.min(producer.x, target.x),
    right = Math.max(producerRight, target.x + target.width);
  const top = Math.min(producer.y, target.y),
    bottom = Math.max(producer.y + producer.height, target.y + target.height);
  const showsTarget =
    (right - left) * scale <= width - padding * 2 && (bottom - top) * scale <= height - padding * 2;
  const anchor = showsTarget ? target : producer;
  const regionTop = showsTarget ? top : producer.y,
    regionBottom = showsTarget ? bottom : producer.y + producer.height;
  const y =
    (regionBottom - regionTop) * scale <= height - padding * 2
      ? height / 2 - ((regionTop + regionBottom) / 2) * scale
      : padding - regionTop * scale;
  return {
    x: width - padding - (showsTarget ? target.x + target.width : producerRight) * scale,
    y,
    scale,
    anchorId: anchor.id,
    targetId: target.id,
    showsTarget,
  };
}

const styles = `
.fl-graph{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e5eaf0;outline:none;touch-action:none;user-select:none;display:block;width:100%;height:100%;min-height:320px;background:#10151a}
.fl-graph .flow-shadow{stroke:#10151a;fill:none;opacity:1;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.fl-graph .flow{fill:none;stroke-linecap:round;stroke-linejoin:round;opacity:.88;transition:opacity .15s;pointer-events:none}
.fl-graph .flow-hit{fill:none;stroke:transparent;pointer-events:stroke;cursor:crosshair}
.fl-graph .belt-bed{fill:none;stroke:#21313b;stroke-width:6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.fl-graph .belt-treads{fill:none;stroke-width:4;stroke-dasharray:2 7;opacity:.65;pointer-events:none}
.fl-graph .pipe-core{fill:none;stroke:#122b35;stroke-width:5;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.fl-graph .pipe-gloss{fill:none;stroke:#b0dfea;stroke-width:1;opacity:.58;pointer-events:none}
.fl-graph .flow-direction{fill:none;stroke:#e5edf2;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;opacity:.85;pointer-events:none}
.fl-graph .flow-bridge{fill:none;stroke-width:1.8;opacity:.95;pointer-events:none}
.fl-graph .return-guide{fill:none;stroke-width:1;stroke-dasharray:5 8;opacity:.4;pointer-events:none}
.fl-graph .flow-group.fl-highlight .flow{opacity:.9}
.fl-graph.fl-hover .flow-group:not(.fl-highlight){opacity:.1}
.fl-graph.fl-hover .node:not(.fl-highlight){opacity:.22}
.fl-graph .node{cursor:pointer;transition:opacity .15s;outline:none}
.fl-graph .node-card{fill:#192129;stroke:#34414b;stroke-width:1.3;filter:url(#fl-node-shadow)}
.fl-graph .node:hover .node-card,.fl-graph .node:focus .node-card{stroke:#e3b37e;stroke-width:2}
.fl-graph .node.fl-selected .node-card{stroke:#f39b44;stroke-width:2.7}
.fl-graph .node.fl-target .node-card{fill:#23251f;stroke:#7b704a}
.fl-graph .node.fl-surplus .node-card{fill:#252127;stroke:#655064;stroke-dasharray:5 4}
.fl-graph .node.fl-module .node-card{fill:#1e2831;stroke:#5e7584;stroke-width:1.6}
.fl-graph .node.fl-unresolved .node-card{stroke:#df807a;stroke-dasharray:5 4}
.fl-graph .node-title{fill:#edf2f6;font-size:17px;font-weight:650;letter-spacing:-.1px;pointer-events:none}
.fl-graph .node-subtitle{fill:#adbbc7;font-size:14px;pointer-events:none}
.fl-graph .node-english{fill:#b6c3cf;font-size:14px;pointer-events:none}
.fl-graph .node-building{fill:#d5dfe7;font-size:15px;font-weight:600;pointer-events:none}
.fl-graph .node-building-en{fill:#a9b9c6;font-size:14px;pointer-events:none}
.fl-graph .node-rate{fill:#edf2f6;font-size:22px;font-weight:650;pointer-events:none}
.fl-graph .node-machines{fill:#f6dfbb;font-size:30px;font-weight:750;font-variant-numeric:tabular-nums;pointer-events:none}
.fl-graph .compact-machines{font-size:40px}
.fl-graph .compact-title{font-size:19px}
.fl-graph .compact-secondary{font-size:13px}
.fl-graph .compact-total{font-size:34px}
.fl-graph .node-unit{fill:#adbbc7;font-size:14px;pointer-events:none}
.fl-graph .node-kind{fill:#b8c6cf;font-size:14px;font-weight:650;letter-spacing:.6px;pointer-events:none}
.fl-graph .port-name{fill:#b8c6cf;font-size:14px;pointer-events:none}
.fl-graph .port-rate{fill:#edf2f6;font-size:26px;font-weight:750;font-variant-numeric:tabular-nums;pointer-events:none}
.fl-graph .port-unit{fill:#9cacba;font-size:12px;pointer-events:none}
.fl-graph .node-divider{stroke:#34404a;stroke-width:1;pointer-events:none}
.fl-graph .node-port{stroke:#10151a;stroke-width:2;pointer-events:none}
.fl-graph .edge-label{opacity:1;cursor:pointer}
.fl-graph .edge-label .label-panel{fill:#121b23;stroke:#35434e;stroke-width:1;rx:7}
.fl-graph .edge-label text{fill:#edf2f6;font-size:14px;font-weight:600;pointer-events:none}
.fl-graph .edge-label .label-title{font-size:17px}
.fl-graph .edge-label .label-en{fill:#a9b9c6;font-size:12px;font-weight:400}
.fl-graph .edge-label .label-rate{font-size:32px;font-weight:750;font-variant-numeric:tabular-nums}
.fl-graph .edge-label .label-unit{fill:#b5c5d2;font-size:13px;font-weight:500}
.fl-graph .edge-label .label-transport{fill:#cbd8e1;font-size:13px;font-weight:600}
.fl-graph .edge-label .label-loads{fill:#a9bac8;font-size:12px;font-weight:400}
.fl-graph .edge-label .label-summary{display:none}
.fl-graph .edge-label .summary-rate{font-size:26px;font-weight:750;font-variant-numeric:tabular-nums}
.fl-graph.fl-distant .edge-label .label-full{display:none}
.fl-graph.fl-distant .edge-label .label-summary{display:inline}
.fl-graph.fl-distant .port-unit,.fl-graph.fl-distant .node-subtitle,.fl-graph.fl-distant .node-building-en,.fl-graph.fl-distant .compact-secondary{display:none}
.fl-graph.fl-hover .edge-label:not(.fl-highlight){opacity:.35}
.fl-graph .column-label{fill:#60717d;font-size:11px;font-weight:650;letter-spacing:1.3px}
.fl-graph .fl-empty{fill:#a2b1be;font-size:16px;text-anchor:middle}
.fl-graph .fl-minimap{cursor:crosshair}
.fl-graph .fl-mini-bg{fill:#12191f;stroke:#34414b;stroke-width:1}
.fl-graph .fl-mini-view{fill:#f39b44;fill-opacity:.07;stroke:#f39b44;stroke-opacity:.7;stroke-width:1}
@media(prefers-reduced-motion:reduce){.fl-graph .flow,.fl-graph .node{transition:none}}
`;

export function createGraph(
  container,
  { onSelect, onViewChange, language: initialLanguage = 'both', compact: initialCompact = false } = {},
) {
  if (!container) throw new Error('Graph container is required');
  let full = { nodes: [], edges: [], itemMap: new Map(), diagnostics: [] },
    layout = { nodes: [], edges: [], bounds: { x: 0, y: 0, width: 600, height: 400 } };
  let projected = full,
    overview = false,
    expandedModules = new Set(),
    topology = '';
  let spacing = 360,
    compact = initialCompact === true,
    transportSettings = { beltTier: 5, pipeTier: 2 },
    outputAnchorId = null;
  let selectedId = null,
    focus = null,
    language = initialLanguage,
    view = { x: 0, y: 0, scale: 1 },
    dimensions = { width: 900, height: 600 };
  let drawnOnce = false,
    readabilityScale = null,
    pointer = null,
    destroyed = false,
    lastClickMoved = false;
  const abort = new AbortController();
  const svg = svgEl('svg', {
    class: 'fl-graph',
    tabindex: '0',
    'aria-label': 'Схема производства: колесо меняет масштаб, перетаскивание фона перемещает схему',
  });
  svg.append(svgEl('style', {}, styles));
  const defs = svgEl('defs');
  const filter = svgEl('filter', {
    id: 'fl-node-shadow',
    x: '-20%',
    y: '-30%',
    width: '140%',
    height: '170%',
  });
  filter.append(
    svgEl('feDropShadow', {
      dx: 0,
      dy: 4,
      stdDeviation: 5,
      'flood-color': '#000',
      'flood-opacity': '.18',
    }),
  );
  defs.append(filter);
  const pattern = svgEl('pattern', {
    id: 'fl-dot-grid',
    width: 26,
    height: 26,
    patternUnits: 'userSpaceOnUse',
  });
  pattern.append(svgEl('circle', { cx: 1, cy: 1, r: 1, fill: '#29353e', opacity: 0.55 }));
  defs.append(pattern);
  svg.append(defs);
  const backdrop = svgEl('rect', {
    class: 'fl-backdrop',
    width: '100%',
    height: '100%',
    fill: 'url(#fl-dot-grid)',
  });
  svg.append(backdrop);
  const world = svgEl('g', { class: 'fl-world' }),
    edgeLayer = svgEl('g', { class: 'fl-edges' }),
    labelLayer = svgEl('g', { class: 'fl-labels' }),
    nodeLayer = svgEl('g', { class: 'fl-nodes' });
  world.append(edgeLayer, labelLayer, nodeLayer);
  svg.append(world);
  const mini = svgEl('g', { class: 'fl-minimap', 'aria-hidden': 'true' });
  svg.append(mini);
  container.replaceChildren(svg);
  const nodesById = new Map(),
    edgeElements = new Map(),
    nodeElements = new Map(),
    labelElements = new Map();
  const iconCache = new Map(),
    iconTasks = new Map();
  function cacheIcon(url) {
    if (!url || url.startsWith('data:') || iconTasks.has(url)) return;
    const task = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error('Icon unavailable');
        return response.blob();
      })
      .then(
        (blob) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          }),
      )
      .then((encoded) => iconCache.set(url, encoded))
      .catch(() => {});
    iconTasks.set(url, task);
  }
  const units = (itemId) => {
    const form = String(full.itemMap.get(itemId)?.form || '').toLowerCase();
    return /liquid|gas|fluid/.test(form) ? 'м³/мин' : 'шт/мин';
  };
  const payload = (node) => ({
    id: node.id,
    kind: node.kind,
    recipeId: node.recipeId,
    buildingId: node.buildingId,
    itemId: node.itemId,
    name: node.name,
    data: node.data,
  });
  function updateView() {
    world.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`);
    updateReadability();
    pattern.setAttribute(
      'patternTransform',
      `translate(${view.x % (26 * view.scale)} ${view.y % (26 * view.scale)}) scale(${view.scale})`,
    );
    updateMini();
    onViewChange?.({
      zoom: view.scale,
      x: view.x,
      y: view.y,
      width: dimensions.width,
      height: dimensions.height,
    });
  }
  function fitValue(element, width, size) {
    element.style.fontSize = `${size}px`;
    if (typeof element.getComputedTextLength !== 'function') return;
    const length = element.getComputedTextLength();
    if (length > width) element.style.fontSize = `${Math.max(12, size * width / length)}px`;
  }
  function updateReadability() {
    if (readabilityScale === view.scale) return;
    const revealDetails = svg.classList.contains('fl-distant') && view.scale >= 0.55;
    svg.classList.toggle('fl-distant', view.scale < 0.55);
    if (revealDetails) fitVisibleLabels();
    readabilityScale = view.scale;
    const factor = Math.min(2, Math.max(1, 0.5 / view.scale));
    for (const edge of layout.edges) {
      const element = labelElements.get(edge.id)?.querySelector('.label-summary');
      if (element)
        element.setAttribute('transform', `translate(${(edge.labelBox.width - 144 * factor) / 2} ${edge.labelBox.height - 32 * factor}) scale(${factor})`);
    }
    for (const element of nodeLayer.querySelectorAll('.port-rate'))
      fitValue(element, (WIDTH - 40) / 2, Math.min(48, Math.max(compact ? 30 : 26, 12 / view.scale)));
    for (const element of nodeLayer.querySelectorAll('.node-machines'))
      fitValue(element, compact ? 164 : 140, Math.min(48, Math.max(compact ? 40 : 30, 12 / view.scale)));
  }
  function resize() {
    if (destroyed) return;
    const rect = container.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return;
    const previous = dimensions;
    dimensions = { width: rect.width, height: Math.max(320, rect.height) };
    svg.setAttribute('viewBox', `0 0 ${dimensions.width} ${dimensions.height}`);
    if (drawnOnce) {
      view.x += (dimensions.width - previous.width) / 2;
      view.y += (dimensions.height - previous.height) / 2;
    }
    fitVisibleLabels();
    updateView();
  }
  function fitVisibleLabels() {
    for (const text of nodeLayer.querySelectorAll('.node-title tspan')) fitLabel(text, WIDTH - 96);
    for (const text of nodeLayer.querySelectorAll('.node-subtitle,.node-english,.compact-title,.compact-secondary'))
      fitLabel(text, WIDTH - 32);
    for (const text of nodeLayer.querySelectorAll('.node-building,.node-building-en'))
      fitLabel(text, WIDTH - 90);
    for (const text of nodeLayer.querySelectorAll('.port-name'))
      fitLabel(text, (WIDTH - 32) / 2 - 38);
    for (const text of labelLayer.querySelectorAll('[data-fit-width]'))
      fitLabel(text, Number(text.getAttribute('data-fit-width')));
    for (const text of labelLayer.querySelectorAll('.summary-rate')) fitValue(text, 101, 26);
    for (const text of labelLayer.querySelectorAll('.label-rate')) fitValue(text, LABEL_WIDTH - 24, 32);
    readabilityScale = null;
  }
  function zoom(factor, point = { x: dimensions.width / 2, y: dimensions.height / 2 }) {
    const old = view.scale;
    view.scale = Math.max(0.055, Math.min(2.6, old * factor));
    view.x = point.x - ((point.x - view.x) * view.scale) / old;
    view.y = point.y - ((point.y - view.y) * view.scale) / old;
    updateView();
  }
  function fit() {
    resize();
    const b = layout.bounds;
    const padding = 34;
    view.scale = Math.min(
      1.1,
      Math.max(
        0.055,
        Math.min(
          (dimensions.width - padding * 2) / b.width,
          (dimensions.height - padding * 2) / b.height,
        ),
      ),
    );
    view.x = (dimensions.width - b.width * view.scale) / 2 - b.x * view.scale;
    view.y = (dimensions.height - b.height * view.scale) / 2 - b.y * view.scale;
    updateView();
  }
  function centerTarget() {
    resize();
    const camera = outputCamera(layout, dimensions, view.scale);
    if (!camera) return;
    outputAnchorId = camera.anchorId;
    view.x = camera.x;
    view.y = camera.y;
    updateView();
  }
  function centerStart() {
    resize();
    const starts = layout.nodes.filter((n) => n.rank === 0);
    if (!starts.length) return;
    view.x = 40 - Math.min(...starts.map((n) => n.x)) * view.scale;
    view.y = 40 - Math.min(...starts.map((n) => n.y)) * view.scale;
    updateView();
  }
  function resetView() {
    view.scale = 1;
    centerTarget();
  }
  function centerNode(id, { readable = false } = {}) {
    const node = layout.nodes.find((n) => n.id === id);
    if (!node) return false;
    if (readable && view.scale < 0.65) view.scale = 1;
    view.x = dimensions.width / 2 - (node.x + node.width / 2) * view.scale;
    view.y = dimensions.height / 2 - (node.y + node.height / 2) * view.scale;
    updateView();
    return true;
  }
  function captureAnchor(id) {
    const node = layout.nodes.find((n) => n.id === id);
    return node
      ? {
          id,
          x: view.x + (node.x + node.width / 2) * view.scale,
          y: view.y + (node.y + node.height / 2) * view.scale,
        }
      : null;
  }
  function restoreAnchor(anchor) {
    const node = anchor && layout.nodes.find((n) => n.id === anchor.id);
    if (!node) return false;
    view.x = anchor.x - (node.x + node.width / 2) * view.scale;
    view.y = anchor.y - (node.y + node.height / 2) * view.scale;
    updateView();
    return true;
  }
  function related(id, mode = 'neighbors') {
    const visible = new Set([id]);
    if (mode === 'neighbors') {
      for (const edge of projected.edges)
        if (edge.source === id || edge.target === id) {
          visible.add(edge.source);
          visible.add(edge.target);
        }
      return visible;
    }
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      for (const edge of projected.edges) {
        const next =
          mode === 'upstream' && edge.target === queue[i]
            ? edge.source
            : mode === 'downstream' && edge.source === queue[i]
              ? edge.target
              : null;
        if (next && !visible.has(next)) {
          visible.add(next);
          queue.push(next);
        }
      }
    }
    return visible;
  }
  function clearHighlight() {
    svg.classList.remove('fl-hover');
    for (const el of nodeElements.values()) el.classList.remove('fl-highlight');
    for (const el of edgeElements.values()) el.classList.remove('fl-highlight');
    for (const el of labelElements.values()) el.classList.remove('fl-highlight');
  }
  function highlightNode(id) {
    clearHighlight();
    svg.classList.add('fl-hover');
    const chain = new Set([...related(id, 'upstream'), ...related(id, 'downstream')]);
    for (const [nodeId, el] of nodeElements)
      if (chain.has(nodeId)) el.classList.add('fl-highlight');
    for (const edge of layout.edges)
      if (chain.has(edge.source) && chain.has(edge.target)) {
        edgeElements.get(edge.id)?.classList.add('fl-highlight');
        labelElements.get(edge.id)?.classList.add('fl-highlight');
      }
  }
  function highlightEdge(edge) {
    clearHighlight();
    svg.classList.add('fl-hover');
    for (const e of layout.edges)
      if (e.itemId === edge.itemId) {
        edgeElements.get(e.id)?.classList.add('fl-highlight');
        labelElements.get(e.id)?.classList.add('fl-highlight');
        nodeElements.get(e.source)?.classList.add('fl-highlight');
        nodeElements.get(e.target)?.classList.add('fl-highlight');
      }
  }
  function selectNode(node) {
    selectedId = node.id;
    for (const [id, el] of nodeElements) el.classList.toggle('fl-selected', id === selectedId);
    onSelect?.(payload(node));
  }
  function makeEdge(edge) {
    const plan = edge.transport,
      pipe = plan.kind === 'pipe';
    const group = svgEl('g', {
      class: `flow-group fl-${plan.kind}${edge.loop ? ' fl-loop' : ''}`,
      'data-edge': edge.id,
      'data-transport-count': plan.count,
    });
    // Separate crossing routes visually; crossings do not merge material flows
    group.append(
      svgEl('path', { class: 'flow-shadow', d: edge.path, 'stroke-width': edge.bundleWidth + 10 }),
    );
    if (edge.loop)
      group.append(
        svgEl('path', {
          class: 'return-guide',
          d: edge.path,
          stroke: edge.color,
          'stroke-width': edge.bundleWidth + 5,
        }),
      );
    for (const lane of edge.lanes) {
      const laneGroup = svgEl('g', { 'data-lane': lane.number, 'data-load': lane.load });
      laneGroup.append(
        svgEl('path', {
          class: 'flow',
          d: lane.path,
          stroke: edge.color,
          'stroke-width': LANE_WIDTH,
        }),
      );
      if (pipe) {
        laneGroup.append(svgEl('path', { class: 'pipe-core', d: lane.path }));
        laneGroup.append(svgEl('path', { class: 'pipe-gloss', d: lane.path }));
      } else {
        laneGroup.append(svgEl('path', { class: 'belt-bed', d: lane.path }));
        laneGroup.append(svgEl('path', { class: 'belt-treads', d: lane.path, stroke: edge.color }));
      }
      for (const point of lane.directions)
        laneGroup.append(
          svgEl('path', {
            class: 'flow-direction',
            d: 'M -4 -2.4 L 0 0 L -4 2.4',
            transform: `translate(${point.x} ${point.y}) rotate(${point.angle})`,
          }),
        );
      laneGroup.append(
        svgEl(
          'title',
          {},
          `${pipe ? 'Труба' : 'Конвейер'} ${lane.number}: ${num(lane.load)} / ${num(plan.capacity)} ${units(edge.itemId)}`,
        ),
      );
      group.append(laneGroup);
    }
    for (const crossing of edge.crossings) {
      const bridge = svgEl('g', {
        class: 'flow-bridge',
        stroke: edge.color,
        transform: `translate(${crossing.x} ${crossing.y}) rotate(${crossing.angle})`,
      });
      const side = edge.bundleWidth / 2 + 3;
      bridge.append(
        svgEl('path', { d: `M -13 ${-side} L 13 ${-side} M -13 ${side} L 13 ${side}` }),
      );
      bridge.append(
        svgEl('title', {}, 'Эстакада: трассы проходят на разных уровнях, соединения нет'),
      );
      group.append(bridge);
    }
    const targetNode = nodesById.get(edge.target);
    const text = `${label(full.itemMap.get(edge.itemId))} / ${num(edge.rate)} ${units(edge.itemId)}${edge.loop ? ' / возврат' : ''}\n→ ${targetNode?.nameRu || targetNode?.name || edge.target}`;
    const details = `${text}\n${transportSummary(plan)}\nЗагрузка: ${transportLoadsLabel(plan)}${plan.loadsTruncated ? `\nНа схеме показано ${edge.drawnLanes} из ${num(plan.count)} линий; последняя соответствует линии № ${num(plan.count)}` : ''}`;
    const hit = svgEl('path', {
      class: 'flow-hit',
      d: edge.path,
      'stroke-width': Math.max(20, edge.bundleWidth + 10),
    });
    hit.append(svgEl('title', {}, details));
    group.append(hit);
    const box = edge.labelBox,
      item = full.itemMap.get(edge.itemId) || {},
      englishFirst = language === 'en' || language === 'en-ru';
    const primary = englishFirst ? item.name : label(item),
      secondary = language === 'both' ? item.name : language === 'en-ru' ? label(item) : '';
    const lab = svgEl('g', {
      class: 'edge-label',
      transform: `translate(${box.x},${box.y})`,
      'data-label-edge': edge.id,
      'aria-label': details,
    });
    const content = svgEl('g', { class: 'label-full' });
    content.append(svgEl('rect', { class: 'label-panel', width: box.width, height: box.height }));
    content.append(
      svgEl('rect', {
        x: 0,
        y: 9,
        width: 3,
        height: box.height - 18,
        style: `fill:${edge.color};stroke:none`,
        rx: 1.5,
      }),
    );
    const icon = safeIcon(item.icon);
    if (icon) {
      cacheIcon(icon);
      content.append(svgEl('image', { href: icon, x: 10, y: compact ? 5 : 10, width: 28, height: 28 }));
    }
    content.append(
      svgEl(
        'text',
        { class: 'label-title', x: 45, y: compact ? 20 : 25, 'data-fit-width': box.width - 57 },
        trim(`${edge.loop ? (englishFirst ? '↶ Return / ' : '↶ Возврат / ') : ''}${primary}`, 36),
      ),
    );
    if (!compact && secondary && secondary !== primary)
      content.append(svgEl('text', { class: 'label-en', x: 45, y: 43, 'data-fit-width': box.width - 57 }, secondary));
    const type = pipe ? (englishFirst ? 'pipes' : 'труб') : englishFirst ? 'belts' : 'конв.';
    const rateText = svgEl('text', { class: 'label-rate', x: 11, y: compact ? 53 : 77 });
    rateText.append(svgEl('tspan', { style: `fill:${edge.color}` }, num(edge.rate)));
    rateText.append(svgEl('tspan', { class: 'label-unit', dx: 8 }, units(edge.itemId)));
    content.append(rateText);
    const loads = transportLoadsLabel(plan).replace(/ (шт\/мин|м³\/мин)$/, '');
    const capacity =
      plan.count > 1
        ? `${loads} / ${englishFirst ? 'each' : 'по'} ${num(plan.capacity)}${plan.loadsTruncated ? (englishFirst ? ' / 6 shown' : ' / 6 видно') : ''}`
        : `${englishFirst ? 'Capacity' : 'Ёмкость'}: ${num(plan.capacity)} ${units(edge.itemId)}`;
    if (!compact)
      content.append(svgEl('text', { class: 'label-transport', x: 11, y: 101, 'data-fit-width': box.width - 22 }, `${num(plan.count)} ${type} Mk.${plan.tier} / ${capacity}`));
    const summary = svgEl('g', { class: 'label-summary' });
    summary.append(svgEl('rect', { class: 'label-panel', width: 144, height: 32, style: `stroke:${edge.color}` }));
    if (icon) summary.append(svgEl('image', { href: icon, x: 5, y: 4, width: 24, height: 24 }));
    else summary.append(svgEl('circle', { cx: 17, cy: 16, r: 8, fill: edge.color }));
    summary.append(svgEl('text', { class: 'summary-rate', x: 36, y: 25, style: `fill:${edge.color}` }, num(edge.rate)));
    lab.append(content, summary);
    lab.append(svgEl('title', {}, `${label(item)}\n${item.name || ''}\n${details}`));
    lab.addEventListener('pointerenter', () => highlightEdge(edge));
    lab.addEventListener('pointerleave', clearHighlight);
    lab.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!lastClickMoved) {
        const target = nodesById.get(edge.target);
        if (target) selectNode(target);
      }
    });
    labelLayer.append(lab);
    labelElements.set(edge.id, lab);
    hit.addEventListener('pointerenter', () => highlightEdge(edge));
    hit.addEventListener('pointerleave', clearHighlight);
    hit.addEventListener('click', (event) => {
      event.stopPropagation();
      if (lastClickMoved) return;
      const target = nodesById.get(edge.target);
      if (target) selectNode(target);
    });
    edgeElements.set(edge.id, group);
    return group;
  }
  function makeNode(node) {
    const record = node.data || {},
      item = full.itemMap.get(node.itemId),
      unresolved = record.unresolved;
    const group = svgEl('g', {
      class: `node fl-${node.kind}${selectedId === node.id ? ' fl-selected' : ''}${unresolved ? ' fl-unresolved' : ''}`,
      transform: `translate(${node.x} ${node.y})`,
      tabindex: 0,
      role: 'button',
      'aria-label': `${node.name}, ${num(node.rate)} ${units(node.itemId)}`,
      'data-node-id': node.id,
    });
    group.append(
      svgEl('rect', { class: 'node-card', width: node.width, height: node.height, rx: 12 }),
    );
    group.append(
      svgEl('rect', {
        x: 0,
        y: 20,
        width: 3,
        height: node.height - 40,
        rx: 1.5,
        fill: node.kind === 'target' ? '#f39b44' : node.color,
      }),
    );
    const icon = safeIcon(item?.icon),
      building = full.buildingMap?.get(node.buildingId),
      buildingIcon = safeIcon(node.buildingIcon || building?.icon);
    const addIcon = (url, y, type, x = 14) => {
      group.append(
        svgEl('rect', {
          x,
          y,
          width: 52,
          height: 52,
          rx: 9,
          fill: node.color,
          'fill-opacity': '.12',
        }),
      );
      if (url) {
        cacheIcon(url);
        group.append(
          svgEl('image', {
            href: url,
            x: x + 4,
            y: y + 4,
            width: 44,
            height: 44,
            preserveAspectRatio: 'xMidYMid meet',
            'data-icon-kind': type,
          }),
        );
      } else
        group.append(
          svgEl(
            'text',
            {
              x: x + 26,
              y: y + 33,
              'text-anchor': 'middle',
              fill: node.color,
              'font-size': 18,
              'font-weight': 700,
            },
            node.name.slice(0, 2).toUpperCase(),
          ),
        );
    };
    addIcon(icon, 14, 'item');
    const englishFirst = language === 'en' || language === 'en-ru',
      primary = englishFirst ? node.nameEn : node.nameRu,
      secondary = language === 'both' ? node.nameEn : language === 'en-ru' ? node.nameRu : '';
    const machines = node.kind === 'recipe' || node.kind === 'resource' ? record.machines : null,
      hasBuilding = !!node.buildingId;
    let subtitle = [node.buildingName, node.buildingNameEn, node.recipeName, node.recipeNameEn].filter(Boolean).join(' / ');
    if (compact) {
      if (hasBuilding) addIcon(buildingIcon, 14, 'building', 80);
      group.append(svgEl('text', {
        class: machines != null ? 'node-machines compact-machines' : 'node-rate compact-total',
        x: node.width - 16,
        y: 50,
        'text-anchor': 'end',
      }, num(machines ?? node.rate)));
      group.append(svgEl('text', {
        class: 'node-unit', x: node.width - 16, y: 70, 'text-anchor': 'end',
      }, machines != null ? (englishFirst ? 'buildings' : 'зданий') : units(node.itemId)));
      group.append(svgEl('text', { class: 'node-title compact-title', x: 16, y: 95 }, primary));
      if (secondary && secondary !== primary)
        group.append(svgEl('text', { class: 'node-english compact-secondary', x: 16, y: 115 }, secondary));
    } else {
      const title = svgEl('text', { class: 'node-title', x: 80, y: 32 });
      textLines(primary, 21).forEach((line, i) =>
        title.append(svgEl('tspan', { x: 80, dy: i ? 21 : 0 }, line)),
      );
      group.append(title);
      if (secondary && secondary !== primary)
        group.append(svgEl('text', { class: 'node-english', x: 16, y: 85 }, trim(secondary, 38)));
      subtitle = '';
      if (unresolved)
        subtitle = node.kind === 'resource' ? 'НЕЗАКРЫТЫЙ ДЕФИЦИТ' : 'НЕРАСПРЕДЕЛЁННЫЙ ВЫХОД';
      else if (node.kind === 'resource') subtitle = 'ДОБЫЧА';
      else if (node.kind === 'import') subtitle = 'ВНЕШНЯЯ ПОСТАВКА';
      else if (node.kind === 'target') subtitle = 'ЦЕЛЕВОЙ ВЫПУСК';
      else if (node.kind === 'surplus')
        subtitle = record.sinkable ? 'ИЗЛИШЕК / УТИЛИЗАЦИЯ' : 'ПОБОЧНЫЙ ПРОДУКТ';
      if (hasBuilding) {
        addIcon(buildingIcon, 96, 'building');
        const fallbackRu =
          record.type === 'miner'
            ? `Бур Mk.${record.tier || 3}`
            : record.type === 'water'
              ? 'Водяная помпа'
              : record.type === 'oil'
                ? 'Нефтяная помпа'
                : 'Добыча ресурса';
        const fallbackEn =
          record.type === 'miner'
            ? `Miner Mk.${record.tier || 3}`
            : record.type === 'water'
              ? 'Water Extractor'
              : record.type === 'oil'
                ? 'Oil Extractor'
                : 'Resource extraction';
        const buildingRuName = node.buildingName || building?.nameRu || fallbackRu,
          buildingEnName = node.buildingNameEn || building?.name || fallbackEn;
        const first = englishFirst ? buildingEnName : buildingRuName,
          second = language === 'both' ? buildingEnName : language === 'en-ru' ? buildingRuName : '';
        group.append(svgEl('text', { class: 'node-building', x: 78, y: 115 }, first));
        if (second && second !== first)
          group.append(svgEl('text', { class: 'node-building-en', x: 78, y: 137 }, second));
        subtitle = `${buildingRuName} / ${buildingEnName}`;
        if (node.kind === 'recipe') {
          const recipeLabel = String(
            (englishFirst ? node.recipeNameEn : node.recipeName) || '',
          ).replace(
            /^(?:(?:Alternate|Alternative|Альт(?:ернативный)?|Альтернатива)\.?\s*[:\u00b7-]?\s*)+/i,
            '',
          );
          group.append(
            svgEl(
              'text',
              { class: 'node-subtitle', x: 16, y: 164 },
              `${node.alternate ? 'ALT / ' : ''}${recipeLabel}`,
            ),
          );
          subtitle += ` / ${node.recipeName}`;
        } else
          group.append(
            svgEl(
              'text',
              { class: 'node-subtitle', x: 16, y: 164 },
              record.type === 'miner'
                ? `Добыча / ${record.purity === 'pure' ? 'чистая' : record.purity === 'impure' ? 'бедная' : 'обычная'} залежь`
                : 'ДОБЫЧА СЫРЬЯ',
            ),
          );
      } else group.append(svgEl('text', { class: 'node-subtitle', x: 16, y: 112 }, subtitle));
      const rateY = hasBuilding ? 190 : 142;
      group.append(
        svgEl(
          'text',
          { class: 'node-rate', x: 16, y: rateY },
          `${num(node.rate)} ${units(node.itemId)}`,
        ),
      );
      if (machines != null)
        group.append(
          svgEl(
            'text',
            { class: 'node-machines', x: node.width - 16, y: rateY, 'text-anchor': 'end' },
            `${num(machines)} зд`,
          ),
        );
    }
    const dividerY = node.portHeader - 20,
      headingY = node.portHeader;
    group.append(
      svgEl('line', {
        class: 'node-divider',
        x1: 16,
        x2: node.width - 16,
        y1: dividerY,
        y2: dividerY,
      }),
    );
    const inEdges = layout.edges.filter((e) => e.target === node.id),
      outEdges = layout.edges.filter((e) => e.source === node.id);
    if (inEdges.length)
      group.append(svgEl('text', { class: 'node-kind', x: 16, y: headingY }, 'ВХОД'));
    if (outEdges.length)
      group.append(
        svgEl(
          'text',
          { class: 'node-kind', x: node.width - 16, y: headingY, 'text-anchor': 'end' },
          'ВЫХОД',
        ),
      );
    const port = (edge, input) => {
      const y = (input ? edge.targetY : edge.sourceY) - node.y,
        material = full.itemMap.get(edge.itemId),
        name = englishFirst ? material?.name : label(material);
      group.append(
        svgEl('rect', {
          class: 'node-port',
          x: (input ? 0 : node.width) - 3.5,
          y: y - edge.bundleWidth / 2 - 2,
          width: 7,
          height: edge.bundleWidth + 4,
          rx: 3,
          fill: edge.color,
        }),
      );
      const x = input ? 16 : node.width - 16,
        anchor = input ? 'start' : 'end';
      const portIcon = safeIcon(material?.icon);
      if (portIcon) {
        cacheIcon(portIcon);
        group.append(svgEl('image', { href: portIcon, x: input ? 16 : node.width - 40, y: y - 65, width: 24, height: 24 }));
      }
      group.append(
        svgEl(
          'text',
          { class: 'port-rate', x, y: y - 9, 'text-anchor': anchor, style: `fill:${edge.color}` },
          num(edge.rate),
        ),
      );
      group.append(
        svgEl('text', { class: 'port-name', x: input ? 46 : node.width - 46, y: y - 46, 'text-anchor': anchor }, name),
        svgEl('text', { class: 'port-unit', x, y: y + 18, 'text-anchor': anchor }, units(edge.itemId)),
      );
    };
    for (const edge of inEdges) port(edge, true);
    for (const edge of outEdges) port(edge, false);
    group.append(
      svgEl(
        'title',
        {},
        `${node.nameRu}\n${node.nameEn}\n${subtitle}\n${num(node.rate)} ${units(node.itemId)}${record.generationMW > 0 ? `\nВыработка: ${num(record.generationMW)} МВт` : record.powerMW != null ? `\nПотребление: ${num(record.powerMW)} МВт` : ''}${machines != null ? `\nЗдания: ${num(machines)}` : ''}`,
      ),
    );
    group.addEventListener('pointerenter', () => highlightNode(node.id));
    group.addEventListener('pointerleave', clearHighlight);
    group.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!lastClickMoved) selectNode(node);
    });
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectNode(node);
      }
    });
    nodeElements.set(node.id, group);
    return group;
  }
  let miniTransform = null;
  function updateMini() {
    mini.replaceChildren();
    if (layout.nodes.length < 5 || dimensions.width < 650) {
      miniTransform = null;
      return;
    }
    const w = 150,
      h = 92,
      p = 9,
      x = dimensions.width - w - 18,
      y = dimensions.height - h - 18;
    mini.setAttribute('transform', `translate(${x} ${y})`);
    mini.append(svgEl('rect', { class: 'fl-mini-bg', width: w, height: h, rx: 9 }));
    const s = Math.min((w - p * 2) / layout.bounds.width, (h - p * 2) / layout.bounds.height),
      ox = (w - layout.bounds.width * s) / 2 - layout.bounds.x * s,
      oy = (h - layout.bounds.height * s) / 2 - layout.bounds.y * s;
    for (const n of layout.nodes)
      mini.append(
        svgEl('rect', {
          x: ox + n.x * s,
          y: oy + n.y * s,
          width: Math.max(2, n.width * s),
          height: Math.max(1.5, n.height * s),
          fill: n.kind === 'target' ? '#f39b44' : n.color,
          opacity: 0.65,
          rx: 0.5,
        }),
      );
    const vx = ox + (-view.x / view.scale) * s,
      vy = oy + (-view.y / view.scale) * s,
      vw = (dimensions.width / view.scale) * s,
      vh = (dimensions.height / view.scale) * s;
    mini.append(
      svgEl('rect', {
        class: 'fl-mini-view',
        x: Math.max(1, vx),
        y: Math.max(1, vy),
        width: Math.max(0, Math.min(w - 1, vx + vw) - Math.max(1, vx)),
        height: Math.max(0, Math.min(h - 1, vy + vh) - Math.max(1, vy)),
        rx: 2,
      }),
    );
    miniTransform = { x, y, ox, oy, s };
  }
  function render() {
    clearHighlight();
    projected = full;
    if (focus && !projected.nodes.some((n) => n.id === focus.id)) focus = null;
    if (selectedId && !projected.nodes.some((n) => n.id === selectedId)) selectedId = null;
    const visible = focus ? related(focus.id, focus.mode) : null;
    const nodes = projected.nodes.filter((n) => !visible || visible.has(n.id));
    const edges = projected.edges.filter(
      (e) => !visible || (visible.has(e.source) && visible.has(e.target)),
    );
    layout = layoutFlow(nodes, edges, { gap: spacing, transport: transportSettings, compact });
    svg.classList.toggle('fl-compact', compact);
    svg.setAttribute('data-detail', compact ? 'compact' : 'full');
    nodesById.clear();
    nodeElements.clear();
    edgeElements.clear();
    labelElements.clear();
    edgeLayer.replaceChildren();
    labelLayer.replaceChildren();
    nodeLayer.replaceChildren();
    if (!layout.nodes.length) {
      nodeLayer.append(
        svgEl(
          'text',
          { class: 'fl-empty', x: 300, y: 200 },
          'Добавьте цель и рассчитайте производство',
        ),
      );
    }
    for (const node of layout.nodes) nodesById.set(node.id, node);
    for (const edge of [...layout.edges].sort((a, b) => Number(b.loop) - Number(a.loop)))
      edgeLayer.append(makeEdge(edge));
    for (const node of layout.nodes) nodeLayer.append(makeNode(node));
    fitVisibleLabels();
    updateView();
    drawnOnce = true;
  }
  const eventOptions = { signal: abort.signal };
  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoom(Math.exp(-event.deltaY * 0.0013), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    },
    { ...eventOptions, passive: false },
  );
  svg.addEventListener(
    'pointerdown',
    (event) => {
      if (
        event.button !== 0 ||
        event.target.closest('.node') ||
        event.target.closest('.fl-minimap')
      )
        return;
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
      };
      lastClickMoved = false;
      svg.setPointerCapture(event.pointerId);
      svg.style.cursor = 'grabbing';
      clearHighlight();
    },
    eventOptions,
  );
  svg.addEventListener(
    'pointermove',
    (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x,
        dy = event.clientY - pointer.y;
      view.x += dx;
      view.y += dy;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 3)
        lastClickMoved = true;
      updateView();
    },
    eventOptions,
  );
  const finishPointer = (event) => {
    if (pointer?.id !== event.pointerId) return;
    pointer = null;
    svg.style.cursor = '';
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch {}
    setTimeout(() => {
      lastClickMoved = false;
    }, 0);
  };
  svg.addEventListener('pointerup', finishPointer, eventOptions);
  svg.addEventListener('pointercancel', finishPointer, eventOptions);
  svg.addEventListener(
    'keydown',
    (event) => {
      if (event.target !== svg) return;
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoom(1.25);
      } else if (event.key === '-') {
        event.preventDefault();
        zoom(0.8);
      } else if (event.key === '0') {
        event.preventDefault();
        resetView();
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fit();
      } else if (event.key.startsWith('Arrow')) {
        event.preventDefault();
        view.x += event.key === 'ArrowLeft' ? 60 : event.key === 'ArrowRight' ? -60 : 0;
        view.y += event.key === 'ArrowUp' ? 60 : event.key === 'ArrowDown' ? -60 : 0;
        updateView();
      }
    },
    eventOptions,
  );
  mini.addEventListener(
    'click',
    (event) => {
      event.stopPropagation();
      if (!miniTransform) return;
      const rect = svg.getBoundingClientRect(),
        m = miniTransform;
      const wx = (event.clientX - rect.left - m.x - m.ox) / m.s,
        wy = (event.clientY - rect.top - m.y - m.oy) / m.s;
      view.x = dimensions.width / 2 - wx * view.scale;
      view.y = dimensions.height / 2 - wy * view.scale;
      updateView();
    },
    eventOptions,
  );
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  observer?.observe(container);
  resize();
  function expandModule(id) {
    const moduleId = id.startsWith('module:') ? id : `module:${id}`;
    if (!overview || !projected.nodes.some((n) => n.id === moduleId && n.kind === 'module'))
      return false;
    expandedModules.add(moduleId);
    if (focus?.id === moduleId) focus = null;
    if (selectedId === moduleId) selectedId = null;
    render(true);
    return true;
  }
  function exportSvg() {
    clearHighlight();
    let clone;
    svg.classList.remove('fl-distant');
    try {
      fitVisibleLabels();
      for (const text of nodeLayer.querySelectorAll('.port-rate'))
        fitValue(text, (WIDTH - 40) / 2, compact ? 30 : 26);
      for (const text of nodeLayer.querySelectorAll('.node-machines'))
        fitValue(text, compact ? 164 : 140, compact ? 40 : 30);
      clone = svg.cloneNode(true);
    } finally {
      readabilityScale = null;
      updateReadability();
    }
    const b = layout.bounds;
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('width', String(Math.ceil(b.width)));
    clone.setAttribute('height', String(Math.ceil(b.height)));
    clone.setAttribute('viewBox', `${b.x} ${b.y} ${b.width} ${b.height}`);
    clone.querySelector('.fl-world').removeAttribute('transform');
    clone.querySelector('.fl-minimap')?.remove();
    clone.querySelector('.fl-backdrop')?.setAttribute('fill', '#10151a');
    clone.querySelector('pattern')?.remove();
    clone.classList.remove('fl-hover', 'fl-distant');
    for (const image of clone.querySelectorAll('image')) {
      const href = image.getAttribute('href');
      image.setAttribute('href', iconCache.get(href) || new URL(href, document.baseURI).href);
    }
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)
    );
  }
  return {
    setData(data, result) {
      const hadContent = full.nodes.length > 0;
      const previousTargets = full.nodes
        .filter((n) => n.kind === 'target')
        .map((n) => n.id)
        .sort()
        .join('|');
      const targetAnchor =
        captureAnchor(selectedId) ||
        captureAnchor(focus?.id) ||
        captureAnchor(outputAnchorId) ||
        captureAnchor(layout.nodes.find((n) => n.kind === 'target')?.id);
      full = buildFlowData(data, result);
      const nextTargets = full.nodes
        .filter((n) => n.kind === 'target')
        .map((n) => n.id)
        .sort()
        .join('|');
      const signature =
        full.nodes
          .map((n) => n.id)
          .sort()
          .join('|') +
        ';' +
        full.edges
          .map((e) => `${e.source}>${e.target}:${e.itemId}`)
          .sort()
          .join('|');
      const changed = signature !== topology;
      topology = signature;
      if (changed) {
        focus = null;
        expandedModules = new Set();
      }
      const isFirst = !hadContent && full.nodes.length > 0;
      render();
      if (isFirst || previousTargets !== nextTargets) resetView();
      else if (!restoreAnchor(targetAnchor)) centerTarget();
    },
    fit,
    resetView,
    centerStart,
    centerTarget,
    centerNode,
    setSpacing(value = 'wide') {
      const chosen = value === 'extra' ? 540 : value === 'wide' ? 360 : Number(value);
      const next = Number.isFinite(chosen) ? Math.max(340, Math.min(1200, chosen)) : 360;
      if (next === spacing) return;
      const anchor =
        layout.nodes.find((n) => n.id === selectedId) ||
        layout.nodes.find((n) => n.id === outputAnchorId) ||
        layout.nodes.find((n) => n.kind === 'target');
      const screen = anchor
        ? { x: view.x + anchor.x * view.scale, y: view.y + anchor.y * view.scale, id: anchor.id }
        : null;
      spacing = next;
      render();
      const moved = screen && layout.nodes.find((n) => n.id === screen.id);
      if (moved) {
        view.x = screen.x - moved.x * view.scale;
        view.y = screen.y - moved.y * view.scale;
        updateView();
      }
    },
    setTransport(settings = {}) {
      const next = { ...transportSettings, ...settings };
      planTransport('solid', 0, next);
      planTransport('liquid', 0, next);
      if (
        next.beltTier === transportSettings.beltTier &&
        next.pipeTier === transportSettings.pipeTier
      )
        return;
      const anchor =
        captureAnchor(selectedId) ||
        captureAnchor(focus?.id) ||
        captureAnchor(outputAnchorId) ||
        captureAnchor(layout.nodes.find((n) => n.kind === 'target')?.id);
      transportSettings = next;
      render();
      restoreAnchor(anchor);
    },
    setCompact(value = false) {
      const next = value === true;
      if (next === compact) return;
      const anchor = captureAnchor(selectedId) || captureAnchor(focus?.id) ||
        captureAnchor(outputAnchorId) || captureAnchor(layout.nodes.find((n) => n.kind === 'target')?.id);
      compact = next;
      render();
      restoreAnchor(anchor);
    },
    zoomIn() {
      zoom(1.3);
    },
    zoomOut() {
      zoom(1 / 1.3);
    },
    setFocus(nodeId, mode = 'neighbors') {
      if (!projected.nodes.some((n) => n.id === nodeId)) {
        const original = full.nodes.find((n) => n.id === nodeId);
        if (!original) return false;
        if (overview) {
          const groupId =
            original.kind === 'resource'
              ? 'module:resources'
              : original.kind === 'recipe'
                ? `module:${original.buildingId}`
                : null;
          if (groupId) expandedModules.add(groupId);
          projected = buildOverviewData(full, expandedModules);
        }
      }
      focus = {
        id: nodeId,
        mode: ['neighbors', 'upstream', 'downstream'].includes(mode) ? mode : 'neighbors',
      };
      selectedId = nodeId;
      render();
      centerNode(nodeId, { readable: true });
      return true;
    },
    clearFocus() {
      if (!focus) return;
      const anchor = captureAnchor(selectedId) || captureAnchor(focus.id);
      focus = null;
      render();
      if (!restoreAnchor(anchor)) centerTarget();
    },
    setLanguage(mode = 'both') {
      const next = ['both', 'ru', 'en', 'en-ru'].includes(mode) ? mode : 'both';
      if (next === language) return;
      language = next;
      render();
    },
    setOverview() {
      overview = false;
      return false;
    },
    expandModule,
    collapseModules() {
      expandedModules = new Set();
      focus = null;
      render(true);
    },
    getCounts() {
      return {
        nodes: full.nodes.length,
        edges: full.edges.length,
        visibleNodes: layout.nodes.length,
        visibleEdges: layout.edges.length,
        cycles: layout.edges.filter((e) => e.loop).length,
        crossings: layout.crossings?.length || 0,
        belts: layout.edges
          .filter((e) => e.transport?.kind === 'belt')
          .reduce((sum, e) => sum + e.transport.count, 0),
        pipes: layout.edges
          .filter((e) => e.transport?.kind === 'pipe')
          .reduce((sum, e) => sum + e.transport.count, 0),
        transport: { ...transportSettings },
        diagnostics: full.diagnostics,
        zoom: view.scale,
        overview: false,
        compact,
        expandedModules: [],
        focus: focus ? { ...focus } : null,
        modules: 0,
        spacing,
      };
    },
    getView() {
      return {
        zoom: view.scale,
        x: view.x,
        y: view.y,
        width: dimensions.width,
        height: dimensions.height,
      };
    },
    exportSVG: exportSvg,
    async exportSVGAsync() {
      await Promise.allSettled([...iconTasks.values()]);
      return exportSvg();
    },
    destroy() {
      destroyed = true;
      abort.abort();
      observer?.disconnect();
      svg.remove();
    },
  };
}
