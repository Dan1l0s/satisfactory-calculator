import { buildFlowData } from './graph.js';
import { planTransport, transportLoadsLabel } from './transport.js';

// Project solved flows without duplicating shared processes or return cycles
export function buildDependencyForest(data, result) {
  const flow = buildFlowData(data, result);
  const nodeMap = new Map(flow.nodes.map((node) => [node.id, node]));
  const incoming = new Map();
  for (const edge of flow.edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge);
  }
  const originals = new Map(),
    entries = new Map(),
    representedEdges = new Set();
  let serial = 0;
  function visit(nodeId, connection, parentId, depth, ancestors) {
    const originalId = originals.get(nodeId);
    const kind = ancestors.has(nodeId) ? 'return' : originalId ? 'shared' : 'node';
    const entry = {
      id: `dependency-${serial++}`,
      nodeId,
      node: nodeMap.get(nodeId),
      kind,
      originalId: originalId || null,
      connection,
      parentId,
      depth,
      children: [],
    };
    entries.set(entry.id, entry);
    if (connection) representedEdges.add(connection.id);
    if (kind !== 'node') return entry;
    originals.set(nodeId, entry.id);
    ancestors.add(nodeId);
    for (const edge of incoming.get(nodeId) || []) {
      entry.children.push(visit(edge.source, edge, entry.id, depth + 1, ancestors));
    }
    ancestors.delete(nodeId);
    return entry;
  }
  const roots = flow.nodes
    .filter((node) => node.kind === 'target')
    .map((node) => visit(node.id, null, null, 0, new Set()));
  return {
    roots,
    entries,
    originals,
    nodeMap,
    flow,
    // Surplus stays in full process outputs and the balance view
    outsideEdges: flow.edges.filter((edge) => !representedEdges.has(edge.id)),
    processCount: [...originals.keys()].filter((id) => nodeMap.get(id)?.kind === 'recipe').length,
    sharedCount: [...entries.values()].filter((entry) => entry.kind === 'shared').length,
    returnCount: [...entries.values()].filter((entry) => entry.kind === 'return').length,
  };
}

export function dependencyNames(object, language = 'both') {
  const en = object?.name || object?.nameEn || object?.id || 'Material';
  const ru = object?.nameRu || en;
  if (language === 'en') return [en, ''];
  if (language === 'ru') return [ru, ''];
  if (language === 'en-ru') return [en, en === ru ? '' : ru];
  return [ru, ru === en ? '' : en];
}

let viewSerial = 0;

export function createDependencyView(container, { onShowGraph } = {}) {
  const doc = container.ownerDocument;
  const prefix = `dependency-view-${++viewSerial}`;
  let forest = null,
    previousResult = null,
    highlighted = null;
  let options = { language: 'both', beltTier: 5, pipeTier: 2 };
  let expanded = new Set();
  const cards = new Map(),
    toggles = new Map();
  const make = (tag, className, text) => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  const button = (text, action, entryId, className = 'dependency-button') => {
    const element = make('button', className, text);
    element.type = 'button';
    element.dataset.dependencyAction = action;
    if (entryId) element.dataset.dependencyEntry = entryId;
    return element;
  };
  const num = (value) => {
    const locale = options.language === 'en' || options.language === 'en-ru' ? 'en-US' : 'ru-RU';
    const small = value > 0 && value < 0.01;
    return new Intl.NumberFormat(
      locale,
      small ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 },
    ).format(value);
  };
  const units = (item) => (['liquid', 'gas', 'fluid'].includes(item?.form) ? 'м³/мин' : 'шт/мин');
  function names(object, className = '') {
    const [primary, secondary] = dependencyNames(object, options.language);
    const wrapper = make('span', `dependency-names ${className}`.trim());
    wrapper.append(make('strong', '', primary));
    if (secondary) wrapper.append(make('small', '', secondary));
    return wrapper;
  }
  function icon(object, extra = '') {
    const wrapper = make('span', `dependency-icon ${extra}`.trim());
    wrapper.setAttribute('aria-hidden', 'true');
    const url = object?.icon;
    if (typeof url === 'string' && /^(?:https?:\/\/|\.\.?\/|\/|[\w-]+\/)/.test(url)) {
      const image = make('img');
      image.src = url;
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => wrapper.replaceChildren(make('span', '', '◇')), {
        once: true,
      });
      wrapper.append(image);
    } else wrapper.append(make('span', '', '◇'));
    return wrapper;
  }

  container.classList.add('dependency-view');
  const header = make('div', 'dependency-header');
  const intro = make('div', 'dependency-intro');
  intro.append(make('h2', '', 'От выпуска к сырью'));
  intro.append(
    make(
      'p',
      '',
      'Карточка показывает здания и выпуск для всего плана, связь показывает долю для родителя. Общий процесс показан один раз; повторные ссылки не прибавляют здания',
    ),
  );
  const actions = make('div', 'dependency-actions');
  actions.append(button('Развернуть всё', 'expand-all'), button('Свернуть всё', 'collapse-all'));
  header.append(intro, actions);
  const summary = make('div', 'dependency-summary');
  summary.setAttribute('aria-live', 'polite');
  const scroller = make('div', 'dependency-scroll');
  const list = make('ul', 'dependency-forest');
  list.setAttribute('aria-label', 'Зависимости целей производства');
  const empty = make(
    'p',
    'dependency-empty',
    'Нет рассчитанного плана: проверьте цели производства и ограничения',
  );
  scroller.append(list, empty);
  container.replaceChildren(header, summary, scroller);

  function connectionRow(entry) {
    const edge = entry.connection;
    if (!edge) return null;
    const item = forest.flow.itemMap.get(edge.itemId) || { id: edge.itemId };
    const row = make('div', 'dependency-connection');
    row.append(make('span', 'dependency-connection-label', 'Родителю'), icon(item, 'compact'));
    row.append(names(item, 'connection-name'));
    row.append(make('strong', 'dependency-connection-rate', `${num(edge.rate)} ${units(item)}`));
    const transport = planTransport(item, edge.rate, options);
    const label = `${transport.count} × Mk.${transport.tier}`;
    const chip = make('span', `dependency-transport ${transport.kind}`, label);
    const locale = options.language === 'en' || options.language === 'en-ru' ? 'en-US' : 'ru-RU';
    chip.title = `${transport.kind === 'pipe' ? 'Трубы' : 'Конвейеры'}: ${transportLoadsLabel(transport, { locale })}`;
    row.append(chip);
    return row;
  }

  function processDetails(entry, card) {
    const node = entry.node;
    const building = forest.flow.buildingMap.get(node.buildingId) || {
      name: node.buildingNameEn || node.buildingName,
      nameRu: node.buildingName,
      icon: node.buildingIcon,
    };
    const body = make('div', 'dependency-details');
    if (node.kind === 'recipe') {
      const recipe = make('div', 'dependency-recipe');
      recipe.append(make('span', 'dependency-field', node.alternate ? 'Альт. рецепт' : 'Рецепт'));
      recipe.append(names({ name: node.recipeNameEn, nameRu: node.recipeName }));
      body.append(recipe);
    }
    if (node.kind === 'recipe' || node.kind === 'resource') {
      const machine = make('div', 'dependency-machine');
      machine.append(icon(building, 'building'), names(building));
      if (Number.isFinite(node.data?.machines)) {
        const count = make('strong', 'dependency-machine-count', `${num(node.data.machines)} зд`);
        count.title = 'Дробный эквивалент зданий для всего плана при 100%';
        machine.append(count);
      }
      body.append(machine);
    }
    const outputs = make('div', 'dependency-outputs');
    outputs.append(
      make('span', 'dependency-field', node.kind === 'target' ? 'Целевой выпуск' : 'Всего в плане'),
    );
    const quantities = node.kind === 'target' ? node.inputs : node.outputs;
    for (const [itemId, rate] of Object.entries(quantities || {})) {
      const item = forest.flow.itemMap.get(itemId) || { id: itemId };
      const output = make('span', 'dependency-output');
      output.append(icon(item, 'tiny'), make('strong', '', `${num(rate)} ${units(item)}`));
      if (Object.keys(quantities).length > 1)
        output.append(make('span', '', dependencyNames(item, options.language)[0]));
      output.title = dependencyNames(item, options.language).filter(Boolean).join(' / ');
      outputs.append(output);
    }
    body.append(outputs);
    card.append(body);
  }

  function entryElement(entry) {
    const node = entry.node;
    const li = make('li', 'dependency-entry');
    const edge = connectionRow(entry);
    if (edge) li.append(edge);
    const card = make(
      'article',
      `dependency-card ${entry.kind === 'node' ? '' : `is-${entry.kind}`} ${node.kind === 'target' ? 'is-target' : ''}`.trim(),
    );
    card.id = `${prefix}-${entry.id}`;
    card.dataset.nodeId = node.id;
    card.tabIndex = -1;
    if (highlighted === entry.id) card.classList.add('is-highlighted');
    cards.set(entry.id, card);
    const top = make('div', 'dependency-card-top');
    if (entry.children.length) {
      const toggle = button('›', 'toggle', entry.id, 'dependency-toggle');
      toggle.setAttribute('aria-expanded', String(expanded.has(entry.nodeId)));
      toggle.setAttribute('aria-controls', `${prefix}-children-${entry.id}`);
      toggle.setAttribute(
        'aria-label',
        expanded.has(entry.nodeId) ? 'Свернуть входы' : 'Раскрыть входы',
      );
      toggles.set(entry.id, toggle);
      top.append(toggle);
    } else top.append(make('span', 'dependency-toggle-placeholder'));
    const item = forest.flow.itemMap.get(node.itemId) || { name: node.nameEn, nameRu: node.nameRu };
    top.append(icon(item), names(item, 'dependency-title'));
    if (typeof onShowGraph === 'function')
      top.append(button('На схеме', 'graph', entry.id, 'dependency-link'));
    card.append(top);
    const badges = make('div', 'dependency-badges');
    if (entry.kind === 'return')
      badges.append(make('span', 'dependency-badge return', '↶ Возврат'));
    else if (entry.kind === 'shared')
      badges.append(
        make(
          'span',
          'dependency-badge shared',
          node.kind === 'recipe' ? 'Общий процесс' : 'Общий источник',
        ),
      );
    else if (node.kind === 'target')
      badges.append(make('span', 'dependency-badge target', 'Цель производства'));
    else if (node.kind === 'resource')
      badges.append(make('span', 'dependency-badge', 'Добыча сырья'));
    else if (node.kind === 'import')
      badges.append(make('span', 'dependency-badge', 'Готовый вход'));
    else badges.append(make('span', 'dependency-badge', 'Процесс / весь план'));
    if (entry.kind !== 'node') {
      badges.append(
        make(
          'span',
          'dependency-reference-note',
          entry.kind === 'return'
            ? 'Источник этого возврата уже показан выше'
            : 'Полный расчёт уже показан в другой ветви',
        ),
      );
      card.append(badges);
      const links = make('div', 'dependency-reference-actions');
      links.append(button('Открыть оригинал', 'original', entry.id, 'dependency-link'));
      card.append(links);
    } else {
      card.append(badges);
      processDetails(entry, card);
    }
    li.append(card);
    if (entry.children.length) {
      const children = make('ul', 'dependency-children');
      children.id = `${prefix}-children-${entry.id}`;
      children.hidden = !expanded.has(entry.nodeId);
      for (const child of entry.children) children.append(entryElement(child));
      li.append(children);
    }
    return li;
  }

  function paint() {
    const top = scroller.scrollTop,
      left = scroller.scrollLeft;
    cards.clear();
    toggles.clear();
    list.replaceChildren();
    empty.hidden = !!forest?.roots.length;
    if (forest) {
      for (const root of forest.roots) list.append(entryElement(root));
      summary.textContent = `Целей: ${forest.roots.length} / Процессов: ${forest.processCount} / Общих ссылок: ${forest.sharedCount} / Возвратов: ${forest.returnCount}`;
    } else summary.textContent = '';
    scroller.scrollTop = top;
    scroller.scrollLeft = left;
  }

  function reveal(nodeId) {
    const entryId = forest?.originals.get(nodeId);
    if (!entryId) return false;
    highlighted = entryId;
    let entry = forest.entries.get(entryId);
    while (entry) {
      expanded.add(entry.nodeId);
      entry = forest.entries.get(entry.parentId);
    }
    paint();
    const card = cards.get(entryId);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return true;
  }
  function expandAll() {
    if (!forest) return;
    expanded = new Set(
      [...forest.entries.values()]
        .filter((entry) => entry.children.length)
        .map((entry) => entry.nodeId),
    );
    paint();
  }
  function collapseAll() {
    expanded.clear();
    paint();
  }
  function handleClick(event) {
    const control = event.target.closest('[data-dependency-action]');
    if (!control || !container.contains(control)) return;
    const action = control.dataset.dependencyAction;
    const entry = forest?.entries.get(control.dataset.dependencyEntry);
    if (action === 'expand-all') expandAll();
    else if (action === 'collapse-all') collapseAll();
    else if (entry && action === 'graph') onShowGraph?.(entry.nodeId);
    else if (entry && action === 'original') reveal(entry.nodeId);
    else if (entry && action === 'toggle') {
      if (expanded.has(entry.nodeId)) expanded.delete(entry.nodeId);
      else expanded.add(entry.nodeId);
      highlighted = null;
      paint();
      toggles.get(entry.id)?.focus({ preventScroll: true });
    }
  }
  container.addEventListener('click', handleClick);

  return {
    render(data, result, nextOptions = {}) {
      options = { ...options, ...nextOptions };
      forest =
        result && (!result.status || result.status === 'optimal')
          ? buildDependencyForest(data, result)
          : null;
      if (result !== previousResult) {
        expanded = new Set(
          forest
            ? [...forest.entries.values()]
                .filter((entry) => entry.children.length && entry.depth < 2)
                .map((entry) => entry.nodeId)
            : [],
        );
        highlighted = null;
      }
      previousResult = result;
      paint();
      return forest;
    },
    expandAll,
    collapseAll,
    reveal,
    destroy() {
      container.removeEventListener('click', handleClick);
      container.classList.remove('dependency-view');
      container.replaceChildren();
      forest = null;
      cards.clear();
      toggles.clear();
      expanded.clear();
    },
  };
}
