import { createGraph } from './graph.js';
import {
  BELT_TIERS,
  PIPE_TIERS,
  planTransport,
  transportSummary,
  transportLoadsLabel,
} from './transport.js';
import { createDependencyView } from './dependencies.js';
import {
  primaryProduct,
  recipePermission,
  effectiveDisabledRecipes,
  chooseRecipe,
  setRecipeEnabled,
  applyUnlockedRecipes,
  chooseAlternateMode,
  pinnedResourceItems,
} from './recipe-policy.js';
import { normalizeRecipeMode } from './recipe-mode.js';
import {
  getResourceWeights,
  getResourceWeightDetails,
  RESOURCE_WEIGHT_METADATA,
} from './resource-weights.js';

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const num = (value, precision = 2) => {
  const n = Number(value) || 0;
  return new Intl.NumberFormat(
    'ru-RU',
    Math.abs(n) > 0 && Math.abs(n) < 10 ** -precision
      ? { maximumSignificantDigits: 3 }
      : { maximumFractionDigits: precision },
  ).format(n);
};
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  close: 'm6 6 12 12M18 6 6 18',
  download: 'M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4',
  link: 'M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l2-2',
  info: 'M12 11v6M12 7h.01',
  resource: 'm12 3 8 5v8l-8 5-8-5V8zM4 8l8 5 8-5M12 13v8',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-8z',
  factory: 'M3 21V9l6 4V8l6 4V3h4l2 18zM7 17h1M12 17h1M17 17h1',
  recipe: 'M5 3h14v18H5zM9 7h6M9 11h6M9 15h4',
  graph: 'M3 4h5v5H3zM16 3h5v5h-5zM16 16h5v5h-5zM8 6h8M8 7h3v11h5',
  table: 'M3 4h18v16H3zM3 9h18M9 4v16M15 9v11M3 14h18',
  compare: 'M5 20V10M12 20V4M19 20v-8M3 20h19',
  search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  fit: 'M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6',
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  save: 'M4 3h13l3 3v15H4zM8 3v6h8V3M8 21v-8h8v8',
  import: 'M4 4h8v4M4 4v16h16v-8M14 4h6v6M20 4l-9 9',
  new: 'M5 3h9l5 5v13H5zM14 3v6h5M9 14h6M12 11v6',
  check: 'm5 12 4 4L19 6',
  warning: 'm12 3 10 18H2zM12 9v5M12 17h.01',
  refresh: 'M20 8a8 8 0 0 0-14-4L3 7M3 3v4h4M4 16a8 8 0 0 0 14 4l3-3M17 17h4v4',
  expand: 'M8 3H3v5m0-5 7 7M16 21h5v-5m0 5-7-7M16 3h5v5m0-5-7 7M8 21H3v-5m0 5 7-7',
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${name === 'info' ? '<circle cx="12" cy="12" r="9"/>' : ''}<path d="${ICONS[name] || ICONS.resource}"/></svg>`;
function hydrate(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
}

const STORAGE_KEY = 'factory-lens.project.v1';
const defaultState = () => ({
  version: 1,
  targets: [{ item: 'Desc_ModularFrameHeavy_C', rate: 10 }],
  objective: 'resources',
  alternates: false,
  alternateModeChosen: false,
  resourceConversions: false,
  enabledConversions: [],
  disabledRecipes: [],
  enabledAlternates: [],
  unlockedAlternates: null,
  recipeOverrides: {},
  recipeImport: null,
  seasonal: false,
  resourceProfile: 'scarce',
  resourceSettings: {},
  minerTier: 3,
  defaultPurity: 1,
  beltTier: 5,
  pipeTier: 2,
  clock: 100,
  minerClock: 100,
  imports: [],
  language: 'both',
});
let data,
  itemMap,
  recipeMap,
  buildingMap,
  state = defaultState(),
  result,
  graph,
  dependencies,
  selected,
  activeTab = 'graph';
let worker,
  nextRequest = 1,
  solveGeneration = 0,
  changeTimer,
  toastTimer,
  pickerMode = 'target',
  pickerIndex = null,
  drawerMode = null;
let comparisonCache = {},
  comparisonGeneration = 0,
  isSolving = true,
  workerReady = false;
let recipeChoiceItem = null,
  recipeChoiceGeneration = 0,
  saveImportBusy = false,
  pendingSaveImport = null;
const pending = new Map();

function names(object, language = state.language) {
  const en = object?.name || object?.id || 'Неизвестный предмет';
  const ru = object?.nameRu || en;
  if (language === 'en') return [en, ''];
  if (language === 'ru') return [ru, ''];
  return language === 'en-ru' ? [en, ru === en ? '' : ru] : [ru, en === ru ? '' : en];
}
function dual(object, extra = '') {
  const [primary, secondary] = names(object);
  return `<span class="dual-name ${extra}"><strong>${esc(primary)}</strong>${secondary ? `<small>${esc(secondary)}</small>` : ''}</span>`;
}
function itemIcon(object, size = '') {
  return object?.icon
    ? `<img class="item-art ${size}" src="./${esc(object.icon)}" alt="" loading="lazy">`
    : `<span class="item-art item-art-placeholder ${size}" aria-hidden="true">◇</span>`;
}
function itemName(item) {
  return names(itemMap?.get(item) || { id: item })[0];
}
function unit(item) {
  return itemMap.get(item)?.form === 'solid' ? 'шт/мин' : 'м³/мин';
}
function machineName(row) {
  if (row.type === 'miner')
    return {
      name: `Miner Mk.${row.tier || state.minerTier}`,
      nameRu: `Бур Mk.${row.tier || state.minerTier}`,
    };
  if (row.type === 'water') return { name: 'Water Extractor', nameRu: 'Водяной насос' };
  if (row.type === 'oil') return { name: 'Oil Extractor', nameRu: 'Нефтедобывающая установка' };
  if (row.type === 'well')
    return { name: 'Resource Well Extractor', nameRu: 'Экстрактор ресурсов' };
  return { name: 'External supply', nameRu: 'Внешняя поставка' };
}
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4200);
}
function download(content, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function persistentState() {
  return {
    ...state,
    version: 1,
    dataset: { version: data.meta.gameVersion, sha256: data.meta.sourceSha256 },
  };
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistentState()));
    $('save-status').textContent = 'Сохранено в этом браузере';
  } catch {
    $('save-status').textContent = 'Локальное сохранение недоступно';
  }
}

function normalizeState(raw, { source = 'json' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('В файле нет плана Factory Lens');
  if (raw.version !== undefined && raw.version !== 1)
    throw new Error('Этот формат плана пока не поддерживается');
  if (!Array.isArray(raw.targets) || !raw.targets.length || raw.targets.length > 50)
    throw new Error('В плане должно быть от 1 до 50 продуктов');
  const s = defaultState();
  s.targets = raw.targets.map((t) => {
    if (
      !itemMap.has(t.item) ||
      !Number.isFinite(Number(t.rate)) ||
      Number(t.rate) <= 0 ||
      Number(t.rate) > 1e8
    )
      throw new Error('В плане есть неизвестный предмет или неверная скорость');
    return { item: t.item, rate: Number(t.rate) };
  });
  s.objective = ['resources', 'energy', 'buildings'].includes(raw.objective)
    ? raw.objective
    : 'resources';
  Object.assign(s, normalizeRecipeMode(raw, { source }));
  s.seasonal = raw.seasonal === true;
  s.resourceConversions = raw.resourceConversions === true;
  s.enabledConversions = Array.isArray(raw.enabledConversions)
    ? [...new Set(raw.enabledConversions.filter((id) => recipeMap.get(id)?.conversion))]
    : [];
  s.disabledRecipes = Array.isArray(raw.disabledRecipes)
    ? [...new Set(raw.disabledRecipes.filter((id) => recipeMap.has(id)))]
    : [];
  s.enabledAlternates = Array.isArray(raw.enabledAlternates)
    ? [...new Set(raw.enabledAlternates.filter((id) => recipeMap.get(id)?.alternate))]
    : [];
  s.unlockedAlternates = Array.isArray(raw.unlockedAlternates)
    ? [...new Set(raw.unlockedAlternates.filter((id) => recipeMap.get(id)?.alternate))]
    : null;
  if (raw.recipeOverrides && typeof raw.recipeOverrides === 'object')
    for (const [item, id] of Object.entries(raw.recipeOverrides)) {
      const recipe = recipeMap.get(id);
      if (
        recipe &&
        primaryProduct(recipe) === item &&
        recipePermission(recipe, s).unlocked &&
        !s.disabledRecipes.includes(id)
      )
        s.recipeOverrides[item] = id;
    }
  if (raw.recipeImport && typeof raw.recipeImport === 'object')
    s.recipeImport = {
      saveName: String(raw.recipeImport.saveName || '').slice(0, 180),
      gameVersion: String(raw.recipeImport.gameVersion || '').slice(0, 80),
      importedAt: String(raw.recipeImport.importedAt || '').slice(0, 40),
      count: s.unlockedAlternates?.length || 0,
    };
  s.resourceProfile = raw.resourceProfile === 'equal' ? 'equal' : 'scarce';
  s.minerTier = [1, 2, 3].includes(Number(raw.minerTier)) ? Number(raw.minerTier) : 3;
  s.beltTier = BELT_TIERS.some((t) => t.tier === Number(raw.beltTier)) ? Number(raw.beltTier) : 5;
  s.pipeTier = PIPE_TIERS.some((t) => t.tier === Number(raw.pipeTier)) ? Number(raw.pipeTier) : 2;
  s.defaultPurity = [0.5, 1, 2].includes(Number(raw.defaultPurity)) ? Number(raw.defaultPurity) : 1;
  s.language = ['both', 'ru', 'en', 'en-ru'].includes(raw.language) ? raw.language : 'both';
  if (raw.resourceSettings && typeof raw.resourceSettings === 'object')
    for (const r of data.resources) {
      const source = raw.resourceSettings[r.itemId];
      if (!source || typeof source !== 'object') continue;
      const clean = {};
      if (
        source.limit !== null &&
        source.limit !== '' &&
        source.limit !== undefined &&
        Number.isFinite(Number(source.limit)) &&
        Number(source.limit) >= 0
      )
        clean.limit = Math.min(Number(source.limit), 1e9);
      if (
        source.weight !== undefined &&
        Number.isFinite(Number(source.weight)) &&
        Number(source.weight) >= 0
      )
        clean.weight = Math.min(Number(source.weight), 1e6);
      if ([0.5, 1, 2].includes(Number(source.purity))) clean.purity = Number(source.purity);
      s.resourceSettings[r.itemId] = clean;
    }
  s.imports = Array.isArray(raw.imports)
    ? raw.imports
        .filter((v) => itemMap.has(v.item) && Number.isFinite(Number(v.rate)) && Number(v.rate) > 0)
        .map((v) => ({ item: v.item, rate: Math.min(Number(v.rate), 1e8) }))
        .slice(0, 100)
    : [];
  return s;
}
function encodePlan(plan) {
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  let binary = '';
  bytes.forEach((v) => (binary += String.fromCharCode(v)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodePlan(text) {
  if (text.length > 150000) throw new Error('Ссылка на план слишком длинная');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
}
function loadState() {
  try {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.has('plan')) {
      state = normalizeState(decodePlan(hash.get('plan')), { source: 'hash' });
      toast('Открыт план из ссылки');
      return;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state = normalizeState(JSON.parse(saved), { source: 'localStorage' });
  } catch (error) {
    toast(`План не загружен: ${error.message} Открыт пример`);
    state = defaultState();
  }
}
function resourceWeightOptions(planState = state) {
  const overrides = {};
  for (const [id, setting] of Object.entries(planState.resourceSettings))
    if (setting.weight !== undefined) overrides[id] = setting.weight;
  return { profile: planState.resourceProfile, overrides };
}
function optionsFor(mode = state.objective, planState = state) {
  const settings = {},
    weights = getResourceWeights(data.resources, resourceWeightOptions(planState));
  for (const r of data.resources)
    settings[r.itemId] = {
      purity: planState.defaultPurity,
      ...planState.resourceSettings[r.itemId],
      weight: weights[r.itemId],
    };
  // A conversion pin overrides extraction without changing the saved limit
  for (const item of pinnedResourceItems(data, planState))
    settings[item] = { ...settings[item], limit: 0 };
  return {
    targets: planState.targets.map((t) => ({ ...t })),
    objective: mode,
    alternates: true,
    disabledRecipes: effectiveDisabledRecipes(data, planState),
    seasonal: planState.seasonal,
    resourceSettings: settings,
    minerTier: planState.minerTier,
    clock: 100,
    minerClock: 100,
    imports: planState.imports.map((i) => ({ ...i })),
  };
}
function requestWorker(type, options) {
  return new Promise((resolve, reject) => {
    const id = nextRequest++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          'Решатель не ответил за 30 секунд. Попробуйте уменьшить план или перезагрузить страницу',
        ),
      );
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    worker.postMessage(type === 'init' ? { id, type, data } : { id, type, options });
  });
}
async function initWorker() {
  worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: message }) => {
    const p = pending.get(message.id);
    if (!p) return;
    clearTimeout(p.timeout);
    pending.delete(message.id);
    p.resolve(message.result || message);
  };
  worker.onerror = (event) => {
    for (const p of pending.values()) {
      clearTimeout(p.timeout);
      p.reject(new Error(event.message || 'Не удалось запустить расчёт в браузере'));
    }
    pending.clear();
  };
  const reply = await requestWorker('init');
  if (reply.status === 'error') throw new Error(reply.message);
  workerReady = true;
}
function setStatus(message, busy = false, error = false) {
  isSolving = busy;
  $('solve-status').innerHTML =
    `${busy ? '<span class="spinner"></span>' : error ? icon('warning') : '<span class="live-dot"></span>'}${esc(message)}`;
  $('solve-status').classList.toggle('error', error);
  document.body.classList.toggle('busy', busy);
}
function persistChange() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has('plan')) {
    hash.delete('plan');
    history.replaceState(
      null,
      '',
      location.pathname + location.search + (hash.size ? '#' + hash.toString() : ''),
    );
  }
  save();
}
function showRecipeStart() {
  result = null;
  selected = null;
  comparisonCache = {};
  graph.setData(data, {});
  graph.clearFocus();
  $('inspector').hidden = true;
  $('graph-search-results').hidden = true;
  $('clear-focus').hidden = true;
  document.body.classList.add('awaiting-recipes');
  switchTab('graph');
  for (const id of ['metric-resources', 'metric-energy', 'metric-buildings', 'metric-recipes'])
    $(id).textContent = '-';
  $('metric-alternates').textContent = 'После выбора рецептов';
  $('energy-note').textContent = 'производство + добыча';
  $('plan-notes').innerHTML = '';
  $('graph-summary').textContent = 'Сначала выберите набор рецептов';
  for (const id of ['view-build', 'view-balance', 'view-compare']) $(id).innerHTML = '';
  dependencies.render(data, null, {
    language: state.language,
    beltTier: state.beltTier,
    pipeTier: state.pipeTier,
  });
  setStatus('Выберите набор рецептов');
  $('graph-empty').hidden = false;
  $('graph-empty').classList.add('recipe-start');
  $('graph-empty').innerHTML =
    `<div class="recipe-start-content"><span class="eyebrow">ПЕРЕД ПОСТРОЕНИЕМ СХЕМЫ</span><h2>Использовать альтернативные рецепты?</h2><p class="recipe-start-intro">Начните с обычного производства или сразу разрешите поиск среди открытых альтернатив</p><div class="recipe-start-options"><button class="recipe-start-option base-option" data-start-recipes="false">${icon('factory')}<strong>Начать с базовых</strong><span>Построим обычную цепочку. Затем можно выбрать нужную альтернативу прямо на вершине графа</span><em>Без автоматического выбора альтернатив ${icon('check')}</em></button><button class="recipe-start-option" data-start-recipes="true">${icon('compare')}<strong>Использовать доступные</strong><span>Сравним базовые и разрешённые альтернативы по выбранной цели оптимизации</span><em>${unlockedSummary()} ${icon('graph')}</em></button></div><div class="recipe-start-footer"><span>Преобразования сырья вроде «боксит → уран» выключены по умолчанию и настраиваются отдельно</span><button class="text-button" data-import-save>${icon('import')}Загрузить открытые из .sav</button></div></div>`;
}
function scheduleSolve() {
  persistChange();
  comparisonCache = {};
  comparisonGeneration++;
  recipeChoiceGeneration++;
  clearTimeout(changeTimer);
  solveGeneration++;
  if (!state.alternateModeChosen) {
    showRecipeStart();
    return;
  }
  if ($('graph-empty').classList.contains('recipe-start')) {
    $('graph-empty').classList.remove('recipe-start');
    $('graph-empty').innerHTML =
      '<span class="spinner large"></span><strong>Строим производственную цепочку</strong><p>Считаем только разрешённые вами рецепты</p>';
  }
  setStatus('Пересчитываем…', true);
  if (workerReady) changeTimer = setTimeout(calculate, 200);
}
async function calculate() {
  if (!state.alternateModeChosen) {
    showRecipeStart();
    return;
  }
  if (!workerReady) return;
  const generation = ++solveGeneration;
  const opts = optionsFor();
  setStatus('Пересчитываем…', true);
  try {
    const next = await requestWorker('solve', opts);
    if (generation !== solveGeneration) return;
    result = next;
    selected = null;
    $('inspector').hidden = true;
    $('clear-focus').hidden = true;
    if (result.status !== 'optimal') {
      showFailure(result.message || 'Не удалось построить план');
      return;
    }
    comparisonCache[state.objective] = result;
    graph.setData(data, result);
    graph.clearFocus();
    graph.setLanguage(state.language);
    $('graph-empty').hidden = true;
    setStatus('Баланс проверен');
    renderResult();
    if (activeTab === 'compare') renderComparison();
  } catch (error) {
    if (generation !== solveGeneration) return;
    showFailure(error.message);
  }
}
function showFailure(message) {
  comparisonGeneration++;
  comparisonCache = {};
  setStatus('Нет решения', false, true);
  result = null;
  $('metric-resources').textContent = '-';
  $('metric-energy').textContent = '-';
  $('metric-buildings').textContent = '-';
  $('metric-recipes').textContent = '-';
  $('metric-alternates').textContent = 'Проверьте ограничения';
  $('graph-empty').classList.remove('recipe-start');
  $('graph-empty').hidden = false;
  $('graph-empty').innerHTML =
    `${icon('warning')}<strong>План не сходится</strong><p>${esc(message)}</p><p>Проверьте лимиты сырья, доступные рецепты и внешние поставки. Нулевой лимит запрещает добычу; альтернативы и преобразования сами не включаются</p><button class="button ghost" id="failure-resources">Проверить ограничения</button>`;
  $('failure-resources').onclick = () => openSettings('resources');
  for (const id of ['view-build', 'view-balance', 'view-compare'])
    $(id).innerHTML =
      `<div class="failed-card"><strong>Нет выполнимого плана</strong><p>${esc(message)}</p></div>`;
  dependencies.render(data, null, {
    language: state.language,
    beltTier: state.beltTier,
    pipeTier: state.pipeTier,
  });
  $('plan-notes').innerHTML = '';
  renderUsedAlternates();
  if (drawerMode === 'recipes' && $('settings-dialog').open) fillRecipeList();
}
function renderControls() {
  $('targets').innerHTML = state.targets
    .map(
      (t, index) =>
        `<div class="target-card"><div class="target-head"><button class="icon-button target-change" data-index="${index}" title="Заменить предмет" style="width:34px;height:34px">${itemIcon(itemMap.get(t.item))}</button>${dual(itemMap.get(t.item))}<button class="icon-button target-remove" data-index="${index}" aria-label="Удалить ${esc(itemName(t.item))}" ${state.targets.length < 2 ? 'hidden' : ''}>${icon('close')}</button></div><div class="target-rate"><input type="number" min="0.001" max="100000000" step="any" value="${t.rate}" class="target-amount" data-index="${index}" aria-label="${esc(itemName(t.item))}: количество в минуту"><span>${unit(t.item)}</span></div></div>`,
    )
    .join('');
  document.querySelectorAll('[data-objective]').forEach((el) => {
    const active = el.dataset.objective === state.objective;
    el.classList.toggle('selected', active);
    el.setAttribute('aria-checked', String(active));
  });
  document.body.classList.toggle('awaiting-recipes', !state.alternateModeChosen);
  $('graph-canvas').setAttribute('aria-hidden', String(!state.alternateModeChosen));
  document.querySelectorAll('[data-alternates]').forEach((el) => {
    const active =
      state.alternateModeChosen && (el.dataset.alternates === 'true') === state.alternates;
    el.classList.toggle('active', active);
    el.setAttribute('aria-pressed', String(active));
  });
  document
    .querySelectorAll('[data-tab],[data-tab-link]')
    .forEach((el) => (el.disabled = !state.alternateModeChosen));
  $('resource-conversions').checked = state.resourceConversions;
  $('resource-conversions').disabled = !state.alternateModeChosen;
  $('language').value = state.language;
  $('miner-tier').value = state.minerTier;
  $('default-purity').value = state.defaultPurity;
  const belt = BELT_TIERS.find((t) => t.tier === state.beltTier),
    pipe = PIPE_TIERS.find((t) => t.tier === state.pipeTier);
  $('transport-hint').innerHTML =
    `Конвейеры <strong>Mk.${belt.tier}</strong> / ${num(belt.capacity)} шт/мин<br>Трубы <strong>Mk.${pipe.tier}</strong> / ${num(pipe.capacity)} м³/мин`;
  $('graph-transport').title =
    `Конвейеры Mk.${belt.tier}, трубы Mk.${pipe.tier}. Настроить пропускную способность`;
  graph.setTransport({ beltTier: state.beltTier, pipeTier: state.pipeTier });
  const allowed = data.recipes.filter((r) => recipePermission(r, state).enabled);
  const alts = allowed.filter((r) => r.alternate).length;
  const conversions = allowed.filter((r) => r.conversion).length;
  $('recipe-hint').textContent = state.alternateModeChosen
    ? `${state.alternates ? 'Доступные альтернативы' : alts ? 'Базовые + отдельные альтернативы' : 'Базовые рецепты'} / разрешено альтернатив: ${alts}${state.unlockedAlternates ? ' / открыто ' + state.unlockedAlternates.length : ''}${Object.keys(state.recipeOverrides).length ? ' / выбранных вручную: ' + Object.keys(state.recipeOverrides).length : ''}`
    : 'Сначала выберите набор для нового плана';
  $('conversion-hint').textContent = conversions
    ? `${conversions} преобразований разрешено${state.resourceConversions ? '' : ' отдельно'}. Сырьё может производиться из другого сырья`
    : 'Выключены. Руду добываем из залежей';
  $('imports-count').textContent = state.imports.length;
  $('objective-hint').textContent = {
    resources:
      state.resourceProfile === 'scarce'
        ? 'Добыча с учётом редкости на карте. Железо - 1, более редкое сырьё дороже. Свои веса - в настройках добычи'
        : 'Сумма добычи с заданными весами. Профиль: одинаковая цена сырья; вода - 0',
    energy: 'Минимум средней мощности производства и добычи при частоте 100%',
    buildings: 'Минимум суммы дробных эквивалентов производственных и добывающих зданий',
  }[state.objective];
}
function renderResult() {
  if (!result) return;
  $('metric-resources').textContent = num(result.totals.weightedResources, 1);
  $('metric-energy').innerHTML = `${num(result.totals.powerMW, 1)} <em>МВт</em>`;
  $('metric-buildings').textContent = num(result.totals.machines, 2);
  $('metric-recipes').textContent = result.recipes.length;
  const alts = result.recipes.filter((r) => recipeMap.get(r.recipeId)?.alternate).length;
  $('metric-alternates').textContent =
    `Альтернативы: ${alts} / обычные: ${result.recipes.length - alts}`;
  const variable = Math.abs(result.totals.powerMaxMW - result.totals.powerMinMW) > 0.01;
  $('energy-note').textContent = variable
    ? `${num(result.totals.powerMinMW, 0)}-${num(result.totals.powerMaxMW, 0)} МВт / диапазон`
    : 'производство + добыча';
  updateGraphSummary();
  const notes = [];
  if (!state.alternates && !alts)
    notes.push(
      `<div class="note-bar neutral">${icon('recipe')}<span>Базовая схема готова. Нажмите на нужное производство → «Сравнить и выбрать рецепт», чтобы попробовать одну альтернативу</span></div>`,
    );
  if (result.recipes.some((row) => recipeMap.get(row.recipeId)?.conversion))
    notes.push(
      `<div class="note-bar neutral">${icon('info')}<span>В этом плане используются разрешённые преобразования сырья с SAM. Их можно выключить по одному в каталоге рецептов или все сразу переключателем «Все преобразования сырья»</span><button data-open-catalog>Настроить</button></div>`,
    );
  if (result.surplus.length)
    notes.push(
      `<div class="note-bar">${icon('warning')}<span>Есть побочные продукты: ${result.surplus
        .slice(0, 3)
        .map((s) => `${esc(itemName(s.item))} ${num(s.rate)} ${unit(s.item)}`)
        .join(
          ' / ',
        )}${result.surplus.length > 3 ? ` и ещё ${result.surplus.length - 3}` : ''}. Их нужно потреблять или выводить</span><button data-tab-link="balance">Посмотреть баланс</button></div>`,
    );
  if (result.resources.some((r) => r.type === 'well' && r.rate > 0))
    notes.push(
      `<div class="note-bar neutral">${icon('info')}<span>Для скважин добавьте 150 МВт на каждый работающий прессуризатор. Их число зависит от выбранных скважин и здесь не рассчитывается</span></div>`,
    );
  $('plan-notes').innerHTML = notes.join('');
  renderBuild();
  renderBalance();
  renderDependencies();
  renderUsedAlternates();
  if (drawerMode === 'recipes' && $('settings-dialog').open) fillRecipeList();
}
function renderDependencies() {
  if (result?.status === 'optimal')
    dependencies.render(data, result, {
      language: state.language,
      beltTier: state.beltTier,
      pipeTier: state.pipeTier,
    });
}
function unlockedSummary() {
  const total = data.recipes.filter((r) => r.alternate).length;
  return state.unlockedAlternates === null
    ? `Открыты все ${total} альтернатив`
    : `Открыто ${state.unlockedAlternates.length} из ${total} альтернатив`;
}
function renderUsedAlternates() {
  const used =
    result?.status === 'optimal'
      ? result.recipes.filter((r) => recipeMap.get(r.recipeId)?.alternate)
      : [];
  const banned = state.disabledRecipes.map((id) => recipeMap.get(id)).filter((r) => r?.alternate);
  const pins = Object.entries(state.recipeOverrides).filter(([, id]) => recipeMap.has(id));
  $('view-alternates').innerHTML =
    `<div class="table-top"><div><h3>Альтернативные рецепты в плане</h3><p>Выключите неудобный рецепт - пересчитаем всю цепочку с оставшимися вариантами. Ручной запрет сохраняется при следующей загрузке открытых рецептов</p></div><button class="button small ghost" data-open-catalog>${icon('recipe')}Каталог</button></div><div class="unlocks-panel"><div><strong>${unlockedSummary()}</strong><span>${state.recipeImport ? `Источник: ${esc(state.recipeImport.saveName || 'сохранение игры')}` : 'Доступность можно задать вручную или прочитать из сохранения'}</span></div><button class="button subtle" data-import-save>${icon('import')}Загрузить доступные .sav</button></div><div class="used-alternates">${
      used.length
        ? used
            .map((row) => {
              const recipe = recipeMap.get(row.recipeId),
                item = itemMap.get(primaryProduct(recipe)),
                machine = buildingMap.get(row.buildingId);
              return `<article class="used-alternate"><div class="used-alternate-heading"><div class="paired-icons">${itemIcon(item)}${itemIcon(machine)}</div>${dual(recipe)}<span class="alternate-badge">ALT</span></div><div class="used-alternate-details"><span>${esc(names(machine)[0])} / <strong>${num(row.machines, 3)} зд</strong></span><span>${num(row.powerMW, 1)} МВт</span><span>${flowList(row.outputs)}</span></div><div class="used-alternate-actions"><button class="button small subtle" data-choose-item="${esc(primaryProduct(recipe))}">Сравнить замену</button><button class="button small ghost" data-ban-recipe="${esc(recipe.id)}">Не использовать</button></div></article>`;
            })
            .join('')
        : `<div class="empty-message">${result?.status === 'optimal' ? 'Альтернативы пока не используются. Нажмите на вершину производства → «Сравнить и выбрать рецепт», чтобы попробовать конкретную замену' : 'Решения пока нет. Проверьте запреты и выбранные вручную рецепты ниже'}</div>`
    }</div>${pins.length ? `<section class="recipe-decisions"><h3>Выбраны вручную</h3><p class="helper">Основной способ производства закреплён. Побочные продукты других процессов по-прежнему учитываются</p>${pins.map(([item, id]) => `<div class="recipe-decision-row">${dual(itemMap.get(item))}<span>${esc(names(recipeMap.get(id))[0])}</span><button class="button small ghost" data-clear-recipe-choice="${esc(item)}">Автовыбор</button></div>`).join('')}</section>` : ''}<section class="recipe-decisions"><h3>Исключены вручную / ${banned.length}</h3>${banned.length ? banned.map((r) => `<div class="recipe-decision-row">${dual(r)}<button class="button small ghost" data-restore-recipe="${esc(r.id)}">Снять запрет</button></div>`).join('') : '<p class="helper">Здесь появятся рецепты, для которых вы нажали «Не использовать»</p>'}</section>`;
}
function setRecipeChoice(itemId, recipeId) {
  try {
    state = chooseRecipe(data, state, itemId, recipeId);
    recipeChoiceGeneration++;
    $('settings-dialog').close();
    renderControls();
    renderUsedAlternates();
    scheduleSolve();
    toast(
      recipeId
        ? 'Способ производства выбран. Пересчитываем связанные цепочки'
        : 'Выбор рецепта снова доверен оптимизатору',
    );
  } catch (error) {
    toast(error.message);
  }
}
function openRecipeChoice(itemId) {
  if (!state.alternateModeChosen) {
    toast('Сначала выберите базовые рецепты или доступные альтернативы');
    return;
  }
  recipeChoiceItem = itemId;
  openSettings('recipe-choice');
}
async function renderRecipeChoice() {
  const itemId = recipeChoiceItem,
    item = itemMap.get(itemId);
  if (!item) return;
  $('settings-title').textContent = `Способ производства: ${names(item)[0]}`;
  const candidates = data.recipes
    .filter((r) => primaryProduct(r) === itemId)
    .sort(
      (a, b) =>
        Number(a.alternate) - Number(b.alternate) || names(a)[0].localeCompare(names(b)[0], 'ru'),
    );
  const generation = ++recipeChoiceGeneration,
    current = result?.status === 'optimal' ? result : null;
  const criterion = {
    resources: 'ресурсному индексу',
    energy: 'потреблению энергии',
    buildings: 'количеству зданий',
  }[state.objective];
  $('settings-body').innerHTML =
    `<p class="settings-intro">Сравниваем <strong>весь план</strong> по ${criterion} с учётом открытых рецептов, лимитов и ваших весов сырья. Выбранный способ закрепится для основного производства этого предмета; побочные продукты сохранятся</p><div class="recipe-choice-toolbar"><button class="button small ghost" data-clear-recipe-choice="${esc(itemId)}">Автовыбор оптимизатора</button><button class="text-button" data-open-resources>Изменить цену сырья</button></div><div id="recipe-candidate-list" class="recipe-candidate-list">${candidates
      .map((r) => {
        const permission = recipePermission(r, state),
          unavailable = !permission.unlocked || (r.seasonal && !state.seasonal);
        return `<article class="recipe-candidate" data-candidate="${esc(r.id)}"><div class="used-alternate-heading">${itemIcon(buildingMap.get(r.buildingId))}${dual(r)}${r.alternate ? '<span class="alternate-badge">ALT</span>' : r.conversion ? '<span class="status-tag conversion-tag">СЫРЬЁ → СЫРЬЁ</span>' : ''}</div><p class="helper">На одно здание: ${flowList(r.inputs)} → ${flowList(r.outputs)}</p><div class="candidate-result">${unavailable ? esc(permission.reason) : '<span class="spinner"></span> Считаем вариант…'}</div><button class="button small ${state.recipeOverrides[itemId] === r.id ? 'subtle' : 'ghost'}" data-pin-recipe="${esc(r.id)}" data-pin-item="${esc(itemId)}" disabled>${state.recipeOverrides[itemId] === r.id ? 'Выбран вручную' : permission.manuallyDisabled ? 'Разрешить и использовать' : 'Использовать этот рецепт'}</button></article>`;
      })
      .join(
        '',
      )}</div><p class="helper">Рекомендация относится к выбранной цели и текущим весам. Близость месторождений автоматически неизвестна: повышайте цену удалённых ресурсов в настройках добычи. Если план сейчас пересчитывается, откройте сравнение после завершения</p>`;
  if (isSolving) return;
  const objectiveValue = (r) =>
    state.objective === 'resources'
      ? r.totals.weightedResources
      : state.objective === 'energy'
        ? r.totals.powerMW
        : r.totals.machines;
  const outcomes = [];
  for (const recipe of candidates) {
    const permission = recipePermission(recipe, state);
    if (!permission.unlocked || (recipe.seasonal && !state.seasonal)) continue;
    if (
      generation !== recipeChoiceGeneration ||
      drawerMode !== 'recipe-choice' ||
      !$('settings-dialog').open
    )
      return;
    const card = [...$('recipe-candidate-list').querySelectorAll('[data-candidate]')].find(
      (el) => el.dataset.candidate === recipe.id,
    );
    try {
      const candidateState = chooseRecipe(data, state, itemId, recipe.id),
        next = await requestWorker('solve', optionsFor(state.objective, candidateState));
      if (
        generation !== recipeChoiceGeneration ||
        drawerMode !== 'recipe-choice' ||
        !card?.isConnected
      )
        return;
      if (next.status !== 'optimal') {
        card.querySelector('.candidate-result').innerHTML =
          `<span class="candidate-error">При текущих ограничениях нет решения</span>`;
        card.querySelector('[data-pin-recipe]').disabled = true;
        continue;
      }
      outcomes.push({ id: recipe.id, value: objectiveValue(next), card });
      card.querySelector('[data-pin-recipe]').disabled = false;
      const difference = current ? objectiveValue(next) - objectiveValue(current) : 0,
        delta = !current
          ? 'Выполнимый вариант'
          : Math.abs(difference) < 1e-5
            ? 'Без изменения цели'
            : `${difference > 0 ? '+' : '−'}${num(Math.abs(difference), 2)} к текущей цели`;
      const changes = next.resources
        .map((r) => ({
          id: r.item,
          delta: r.rate - (current?.resources.find((x) => x.item === r.item)?.rate || 0),
        }))
        .filter((x) => Math.abs(x.delta) > 0.005);
      for (const row of current?.resources || [])
        if (!next.resources.some((r) => r.item === row.item) && row.rate > 0.005)
          changes.push({ id: row.item, delta: -row.rate });
      changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      card.querySelector('.candidate-result').innerHTML =
        `<div class="candidate-metrics"><span>Ресурсы<strong>${num(next.totals.weightedResources, 1)}</strong></span><span>МВт<strong>${num(next.totals.powerMW, 1)}</strong></span><span>Здания<strong>${num(next.totals.machines, 2)}</strong></span></div><p class="candidate-delta ${difference < -1e-5 ? 'positive' : ''}">${delta}</p>${
          changes.length
            ? `<p class="helper">${changes
                .slice(0, 5)
                .map(
                  (c) =>
                    `${esc(itemName(c.id))}: ${c.delta > 0 ? '+' : '−'}${num(Math.abs(c.delta))} ${unit(c.id)}`,
                )
                .join(' / ')}${changes.length > 5 ? ' / …' : ''}</p>`
            : '<p class="helper">Состав сырья не меняется</p>'
        }`;
    } catch (error) {
      if (generation !== recipeChoiceGeneration) return;
      if (card?.isConnected)
        card.querySelector('.candidate-result').textContent =
          `Не удалось сравнить: ${error.message}`;
    }
  }
  if (outcomes.length && generation === recipeChoiceGeneration) {
    const best = Math.min(...outcomes.map((x) => x.value));
    for (const option of outcomes)
      if (option.value <= best + Math.max(1e-6, Math.abs(best) * 1e-8)) {
        option.card.classList.add('recommended');
        option.card
          .querySelector('.candidate-result')
          .insertAdjacentHTML(
            'afterbegin',
            '<span class="status-tag in-plan-tag">ЛУЧШИЙ ИЗ ЭТИХ ВАРИАНТОВ</span>',
          );
      }
  }
}
function flowList(flows) {
  return Object.entries(flows || {})
    .filter(([, v]) => v > 1e-6)
    .map(([id, v]) => `${esc(itemName(id))}: <span class="nowrap">${num(v)} ${unit(id)}</span>`)
    .join('<br>');
}
function renderBuild() {
  if (!result) return;
  const rows = [...result.recipes].sort(
    (a, b) =>
      names(buildingMap.get(a.buildingId))[0].localeCompare(
        names(buildingMap.get(b.buildingId))[0],
        'ru',
      ) ||
      itemName(Object.keys(a.outputs)[0]).localeCompare(itemName(Object.keys(b.outputs)[0]), 'ru'),
  );
  const byBuilding = new Map();
  for (const row of rows)
    byBuilding.set(row.buildingId, (byBuilding.get(row.buildingId) || 0) + row.machines);
  $('view-build').innerHTML =
    `<div class="table-top"><div><h3>Здания и производственные рецепты</h3><p>Дробные эквиваленты при 100%: <strong>4,3</strong> означает требуемую производительность 4,3 машины. Выберите количество и разгон в игре так, как вам удобно</p></div><button class="button small ghost" id="export-build">${icon('download')}CSV</button></div><div class="table-wrap"><table><thead><tr><th>Рецепт / Recipe</th><th>Здание / Building</th><th class="numeric">Зданий</th><th class="numeric">МВт</th><th>Выпуск в минуту</th></tr></thead><tbody>${rows
      .map((r) => {
        const rec = recipeMap.get(r.recipeId);
        const main = itemMap.get(Object.keys(r.outputs)[0]);
        return `<tr data-inspect-recipe="${esc(r.recipeId)}"><td><div class="table-name">${itemIcon(main, 'small')}<span>${dual(rec)}${rec?.alternate ? '<span class="alternate-badge">ALT</span>' : ''}</span></div></td><td>${dual(buildingMap.get(r.buildingId))}</td><td class="numeric">${num(r.machines, 3)}</td><td class="numeric">${num(r.powerMW, 1)}</td><td class="flow-list">${flowList(r.outputs)}</td></tr>`;
      })
      .join(
        '',
      )}</tbody></table></div><div class="table-top" style="margin-top:24px"><div><h3>Добыча и внешние поставки</h3><p>При заданной чистоте месторождений и шахтёре Mk.${state.minerTier}. Лимит ограничивает общий поток ресурса</p></div></div><div class="table-wrap"><table><thead><tr><th>Ресурс</th><th>Оборудование</th><th class="numeric">Поток / мин</th><th class="numeric">Зданий</th><th class="numeric">МВт</th></tr></thead><tbody>${result.resources.map((r) => `<tr><td><div class="table-name">${itemIcon(itemMap.get(r.item), 'small')}${dual(itemMap.get(r.item))}</div></td><td>${dual(machineName(r))}${r.type !== 'water' && r.type !== 'external' ? `<span class="cell-sub">Чистота: ${{ '.5': 'низкая', 0.5: 'низкая', 1: 'нормальная', 2: 'высокая' }[r.purity]}</span>` : ''}</td><td class="numeric">${num(r.rate)}<span class="cell-sub">${unit(r.item)}</span></td><td class="numeric">${num(r.machines, 3)}</td><td class="numeric">${num(r.powerMW, 1)}</td></tr>`).join('')}${result.imports
      .filter((r) => r.rate > 1e-6)
      .map(
        (r) =>
          `<tr><td><div class="table-name">${itemIcon(itemMap.get(r.item), 'small')}${dual(itemMap.get(r.item))}</div></td><td>Готовая поставка<span class="cell-sub">До ${num(r.available)} ${unit(r.item)}</span></td><td class="numeric">${num(r.rate)}</td><td class="numeric">-</td><td class="numeric">-</td></tr>`,
      )
      .join(
        '',
      )}</tbody></table></div><p class="balance-explainer">Энергия - средняя мощность в этой модели. Для ускорителей, конвертеров и квантовых кодировщиков возможен диапазон. Логистика, насосы и общие прессуризаторы скважин добавляются отдельно</p>`;
  $('export-build').onclick = exportBuild;
}
function renderBalance() {
  if (!result) return;
  $('view-balance').innerHTML =
    `<div class="table-top"><div><h3>Куда уходит каждый предмет</h3><p>Добыча + внешняя поставка + производство = расход в рецептах + целевой выпуск + излишек. Возвратные потоки включены в обе стороны баланса</p></div><button class="button small ghost" id="export-balance">${icon('download')}CSV</button></div><div class="table-controls"><div class="search-box">${icon('search')}<input id="balance-search" type="search" placeholder="Поиск по русскому или английскому названию" aria-label="Поиск в балансе"></div><label class="check-label"><input id="balance-surplus-only" type="checkbox">Только излишки</label></div><div class="table-wrap"><table><thead><tr><th>Предмет / Item</th><th class="numeric">Добыча / импорт</th><th class="numeric">Произведено</th><th class="numeric">Потреблено</th><th class="numeric">Цель</th><th class="numeric">Излишек</th></tr></thead><tbody id="balance-rows"></tbody></table></div><p class="balance-explainer">Для твёрдых предметов - шт/мин, для жидкостей и газов - м³/мин. Жидкости, газы и непринимаемые отходы нельзя напрямую отправить в AWESOME Sink. Любому излишку нужен выход, иначе линия остановится</p>`;
  fillBalanceRows();
  $('balance-search').oninput = fillBalanceRows;
  $('balance-surplus-only').onchange = fillBalanceRows;
  $('export-balance').onclick = exportBalance;
}
function fillBalanceRows() {
  const query = ($('balance-search')?.value || '').trim().toLowerCase();
  const surplusOnly = $('balance-surplus-only')?.checked;
  const rows = Object.entries(result.balance)
    .filter(
      ([id, b]) =>
        Object.values(b).some((v) => v > 1e-6) &&
        (!surplusOnly || b.surplus > 1e-5) &&
        `${itemMap.get(id)?.name} ${itemMap.get(id)?.nameRu}`.toLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        (b[1].surplus > 1e-5) - (a[1].surplus > 1e-5) ||
        itemName(a[0]).localeCompare(itemName(b[0]), 'ru'),
    );
  $('balance-rows').innerHTML = rows.length
    ? rows
        .map(([id, b]) => {
          const item = itemMap.get(id),
            hazard = b.surplus > 1e-5 && (item.form !== 'solid' || !item.sinkable);
          return `<tr><td><div class="table-name">${itemIcon(item, 'small')}<span>${dual(item)}<span class="cell-sub">${unit(id)}</span></span></div></td><td class="numeric">${num(b.extracted + b.imported)}</td><td class="numeric">${num(b.produced)}</td><td class="numeric">${num(b.consumed)}</td><td class="numeric ${b.target > 0 ? 'positive' : ''}">${num(b.target)}</td><td class="numeric ${b.surplus > 1e-5 ? 'balance-surplus' : ''}">${num(b.surplus)}${hazard ? '<span class="cell-sub">Нужен выход / переработка</span>' : ''}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="empty-message">Таких предметов в плане нет</td></tr>';
}
function switchTab(tab) {
  if (!state.alternateModeChosen && tab !== 'graph') return;
  if (!['graph', 'dependencies', 'alternates', 'build', 'balance', 'compare'].includes(tab)) return;
  activeTab = tab;
  document.querySelectorAll('[data-tab]').forEach((el) => {
    const active = el.dataset.tab === tab;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', String(active));
  });
  for (const id of ['graph', 'dependencies', 'alternates', 'build', 'balance', 'compare'])
    $(`view-${id}`).hidden = id !== tab;
  if (tab === 'compare' && result) renderComparison();
}
async function renderComparison(force = false) {
  if (!state.alternateModeChosen) return;
  if (isSolving) {
    $('view-compare').innerHTML =
      '<div class="empty-message"><span class="spinner"></span><p>Сначала рассчитываем обновлённый план…</p></div>';
    return;
  }
  if (!result) return;
  const modes = ['resources', 'energy', 'buildings'],
    titles = {
      resources: 'Минимум ресурсов',
      energy: 'Минимум энергии',
      buildings: 'Минимум зданий',
    },
    symbols = { resources: 'resource', energy: 'bolt', buildings: 'factory' };
  const description = {
    resources: 'Редкость на карте и ваши веса сырья заданы в настройках добычи',
    energy: 'Среднее потребление в МВт при частоте 100%',
    buildings: 'Дробные эквиваленты производства и добычи',
  };
  $('view-compare').innerHTML =
    `<div class="comparison-intro"><div><h3>Сравнение целей оптимизации</h3><p>Сравнивайте расход сырья, энергию и количество зданий при одинаковых продуктах, рецептах и ограничениях</p></div><button class="button small ghost" id="refresh-compare">${icon('refresh')}Пересчитать</button></div><div class="comparison-cards" id="comparison-cards"></div><div id="compare-detail" class="compare-detail"></div>`;
  $('refresh-compare').onclick = () => renderComparison(true);
  const generation = ++comparisonGeneration;
  if (force) comparisonCache = { [state.objective]: result };
  function cards() {
    if (activeTab !== 'compare' || generation !== comparisonGeneration || !$('comparison-cards'))
      return;
    $('comparison-cards').innerHTML = modes
      .map((mode) => {
        const r = comparisonCache[mode];
        return `<section class="comparison-card ${mode === state.objective ? 'selected' : ''}"><h3>${icon(symbols[mode])}${titles[mode]}</h3><p class="helper">${description[mode]}</p>${r?.status === 'optimal' ? `<div class="comparison-value"><span>Ресурсный индекс</span><strong>${num(r.totals.weightedResources, 1)}</strong></div><div class="comparison-value"><span>Энергия, МВт</span><strong>${num(r.totals.powerMW, 1)}</strong></div><div class="comparison-value"><span>Зданий</span><strong>${num(r.totals.machines, 2)}</strong></div><div class="comparison-value"><span>Рецептов / альтернатив</span><strong>${r.recipes.length} / ${r.recipes.filter((x) => recipeMap.get(x.recipeId)?.alternate).length}</strong></div><button class="button ${mode === state.objective ? 'subtle' : 'ghost'}" data-apply-mode="${mode}" ${mode === state.objective ? 'disabled' : ''}>${mode === state.objective ? 'Текущий план' : 'Применить этот план'}</button>` : r ? `<div class="failed-card">${esc(r.message)}</div>` : '<div class="empty-message"><span class="spinner"></span><p>Считаем цепочку…</p></div>'}</section>`;
      })
      .join('');
    if (modes.every((m) => comparisonCache[m]?.status === 'optimal'))
      renderCompareDetail(modes, titles);
  }
  cards();
  for (const mode of modes) {
    if (comparisonCache[mode]) continue;
    const opts = optionsFor(mode);
    try {
      const r = await requestWorker('solve', opts);
      if (generation !== comparisonGeneration) return;
      comparisonCache[mode] = r;
      cards();
    } catch (error) {
      if (generation !== comparisonGeneration) return;
      comparisonCache[mode] = { status: 'error', message: error.message };
      cards();
    }
  }
}
function renderCompareDetail(modes, titles) {
  const all = new Set();
  for (const mode of modes)
    comparisonCache[mode].resources.forEach((r) => {
      if (r.rate > 1e-6) all.add(r.item);
    });
  $('compare-detail').innerHTML =
    `<h3>Цена выбранной стратегии в сырье</h3><div class="table-wrap"><table><thead><tr><th>Ресурс / мин</th>${modes.map((m) => `<th class="numeric">${titles[m]}</th>`).join('')}</tr></thead><tbody>${[...all].map((id) => `<tr><td><div class="table-name">${itemIcon(itemMap.get(id), 'small')}${dual(itemMap.get(id))}</div></td>${modes.map((m) => `<td class="numeric">${num(comparisonCache[m].resources.find((r) => r.item === id)?.rate || 0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="balance-explainer">Каждая стратегия сначала минимизирует свой основной показатель. Среди решений с тем же результатом используется дополнительный критерий, чтобы убрать лишние циклы. Это оптимум в рамках выбранной модели и разрешённых рецептов</p>`;
}

function openPicker(mode = 'target', index = null) {
  if (mode === 'target' && index === null && state.targets.length >= 50) {
    toast('В одном плане поддерживается до 50 целевых продуктов');
    return;
  }
  pickerMode = mode;
  pickerIndex = index;
  $('picker-title').textContent =
    mode === 'import'
      ? 'Добавить входящую поставку'
      : index !== null
        ? 'Заменить продукт'
        : 'Добавить продукт';
  $('item-search').value = '';
  fillPicker();
  $('picker-dialog').showModal();
  setTimeout(() => $('item-search').focus(), 50);
}
function fillPicker() {
  const q = $('item-search').value.trim().toLowerCase();
  const possible = new Set(
    data.recipes
      .filter((r) => !r.seasonal || state.seasonal)
      .flatMap((r) => Object.keys(r.outputs)),
  );
  const items = data.items
    .filter(
      (i) =>
        (pickerMode === 'import' || possible.has(i.id)) &&
        `${i.name} ${i.nameRu} ${i.id}`.toLowerCase().includes(q),
    )
    .sort((a, b) => names(a)[0].localeCompare(names(b)[0], 'ru'));
  $('picker-list').innerHTML =
    items
      .slice(0, 180)
      .map(
        (i) =>
          `<button class="picker-item" data-pick="${esc(i.id)}">${itemIcon(i)}${dual(i)}<span class="picker-unit">${unit(i.id)}</span>${icon('plus')}</button>`,
      )
      .join('') ||
    '<div class="empty-message">Ничего не найдено. Попробуйте английское название</div>';
}
function applyPick(id) {
  if (pickerMode === 'import') {
    const existing = state.imports.find((t) => t.item === id);
    if (existing) {
      toast('Такая поставка уже добавлена');
    } else if (state.imports.length >= 100) {
      toast('В одном плане поддерживается до 100 внешних поставок');
      return;
    } else state.imports.push({ item: id, rate: 60 });
    $('picker-dialog').close();
    renderControls();
    save();
    if (drawerMode === 'imports') renderImportsSettings();
    else openSettings('imports');
    scheduleSolve();
    return;
  }
  if (pickerIndex !== null) state.targets[pickerIndex].item = id;
  else {
    const existing = state.targets.find((t) => t.item === id);
    if (existing) existing.rate += 10;
    else state.targets.push({ item: id, rate: 10 });
  }
  $('picker-dialog').close();
  renderControls();
  scheduleSolve();
}
function openSettings(mode) {
  drawerMode = mode;
  $('settings-footnote').textContent =
    mode === 'about'
      ? 'Расчёты выполняются в вашем браузере'
      : mode === 'recipe-choice'
        ? 'Выберите вариант после сравнения'
        : 'Изменения применяются автоматически';
  if (!$('settings-dialog').open) $('settings-dialog').showModal();
  if (mode === 'recipes') renderRecipeSettings();
  if (mode === 'resources') renderResourceSettings();
  if (mode === 'imports') renderImportsSettings();
  if (mode === 'transport') renderTransportSettings();
  if (mode === 'about') renderAbout();
  if (mode === 'recipe-choice') renderRecipeChoice();
  if (mode === 'save-import') renderSaveImport();
}
function renderTransportSettings() {
  $('settings-title').textContent = 'Конвейеры и трубы';
  $('settings-body').innerHTML =
    `<p class="settings-intro">Выберите максимальный открытый уровень. На каждом соединении показываем, сколько параллельных линий этого уровня нужно для рассчитанного потока</p><div class="transport-settings"><label class="transport-setting"><span class="eyebrow">ТВЁРДЫЕ ПРЕДМЕТЫ</span><strong>Конвейер, максимум</strong><select id="max-belt-tier" data-transport="beltTier" aria-label="Максимальный уровень конвейера">${BELT_TIERS.map((t) => `<option value="${t.tier}" ${t.tier === state.beltTier ? 'selected' : ''}>${t.label} / ${num(t.capacity)} шт/мин</option>`).join('')}</select><span>Одна линия = одна лента выбранного уровня</span></label><label class="transport-setting"><span class="eyebrow">ЖИДКОСТИ И ГАЗЫ</span><strong>Труба, максимум</strong><select id="max-pipe-tier" data-transport="pipeTier" aria-label="Максимальный уровень трубы">${PIPE_TIERS.map((t) => `<option value="${t.tier}" ${t.tier === state.pipeTier ? 'selected' : ''}>${t.label} / ${num(t.capacity)} м³/мин</option>`).join('')}</select><span>Азот тоже идёт по трубам</span></label></div><div id="transport-example" class="transport-example"></div><p class="helper">Загрузка линий - один из возможных вариантов распределения. Например, поток 1400 можно разделить и на 700 + 700. На схеме сначала заполняются полные линии, затем остаток</p><p class="helper">Количество считается отдельно для каждой связи между производствами. Ленты и трубы не меняют рецепты и количество зданий. Длина трасс, разветвители, напор и запуск труб здесь не рассчитываются</p>`;
  renderTransportExample();
}
function renderTransportExample() {
  const plan = planTransport('solid', 1400, state);
  $('transport-example').innerHTML =
    `<div class="transport-example-heading"><strong>Пример: 1400 винтов/мин</strong><span>${esc(transportSummary(plan))}</span></div><div class="transport-lane-preview">${plan.loads.map((load, index) => `<div class="transport-demo-lane"><span class="demo-conveyor" aria-hidden="true"><i style="width:${Math.max(1, (load / plan.capacity) * 100)}%"></i></span><span>${plan.loadsTruncated && index === plan.loads.length - 1 ? 'Последняя' : `Лента ${index + 1}`}: <strong>${num(load)}</strong> / ${num(plan.capacity)}</span></div>`).join('')}${plan.loadsTruncated ? `<p class="helper">Ещё ${num(plan.omittedCount)} полных линий свёрнуто</p>` : ''}</div><div class="transport-example-total"><span>Фактическая загрузка</span><strong>${esc(transportLoadsLabel(plan))}</strong><small>Свободная вместимость: ${num(plan.spareCapacity)} шт/мин</small></div>`;
}
function renderSaveImport() {
  $('settings-title').textContent = 'Открытые рецепты из сохранения';
  $('settings-footnote').textContent = 'Файл читается только в браузере';
  $('settings-body').innerHTML =
    `<p class="settings-intro">Выберите файл сохранения Satisfactory <strong>.sav</strong>. Прочитаем открытые альтернативные рецепты. Сам файл и постройки завода в план не импортируются</p><div class="save-import-box"><button class="button primary" id="pick-save-file" ${saveImportBusy ? 'disabled' : ''}>${icon('import')}Выбрать сохранение .sav</button><p class="helper">Импорт обновит только список открытых рецептов. Выбранный режим, отдельные разрешения и ваши запреты сохранятся</p><div id="save-import-progress" role="status">${saveImportBusy ? '<span class="spinner"></span> Читаем сохранение…' : ''}</div><div id="save-import-result"></div></div><p class="helper">Файл обычно находится в папке игры SaveGames. Поддержку версии проверяем по заголовку; при ошибке текущие настройки останутся прежними</p>`;
  $('pick-save-file').onclick = () => $('save-file').click();
  if (pendingSaveImport) renderSaveImportResult();
}
function renderSaveImportResult() {
  if (!pendingSaveImport || !$('save-import-result')) return;
  const info = pendingSaveImport;
  $('save-import-result').innerHTML =
    `<div class="save-import-success"><strong>Найдено ${info.recipeIds.length} открытых альтернатив</strong><p>${esc(info.saveName)} / ${esc(info.gameVersion || 'Версия прочитана из файла')}</p>${info.warnings?.length ? `<div class="return-note">${info.warnings.map(esc).join('<br>')}</div>` : ''}<details><summary>Посмотреть список рецептов</summary><ul>${info.recipeIds.map((id) => `<li>${esc(names(recipeMap.get(id))[0])}</li>`).join('') || '<li>Открытых альтернатив пока нет</li>'}</ul></details><button class="button primary" id="apply-save-recipes">Применить список</button></div>`;
  $('apply-save-recipes').onclick = () => {
    const imported = applyUnlockedRecipes(data, state, info.recipeIds, {
      saveName: info.saveName,
      gameVersion: info.gameVersion,
      importedAt: new Date().toISOString(),
    });
    state = imported.state;
    pendingSaveImport = null;
    $('settings-dialog').close();
    renderControls();
    renderUsedAlternates();
    scheduleSolve();
    switchTab('alternates');
    toast(
      `Загружено ${state.unlockedAlternates.length} открытых альтернатив. Режим использования и запреты сохранены.${imported.clearedPins.length ? ' Выбор закрытых рецептов сброшен' : ''}`,
    );
  };
}
async function importGameSave(file) {
  if (saveImportBusy) return;
  saveImportBusy = true;
  pendingSaveImport = null;
  openSettings('save-import');
  const update = (message) => {
    if ($('save-import-progress')) $('save-import-progress').textContent = message;
  };
  try {
    if (file.size > 64 * 1024 * 1024)
      throw new Error('Сохранение больше 64 МиБ. Выберите файл меньшего размера');
    update('Читаем файл…');
    const { parseUnlockedRecipes } = await import('./save-import.js');
    const parsed = await parseUnlockedRecipes(await file.arrayBuffer(), data, {
      onProgress: (event) => update(event.message || 'Читаем сохранение…'),
    });
    pendingSaveImport = { ...parsed, saveName: parsed.saveName || file.name };
    saveImportBusy = false;
    if (drawerMode === 'save-import' && $('settings-dialog').open) {
      renderSaveImport();
      update('Список прочитан. Настройки ещё не изменены');
    } else {
      toast('Сохранение прочитано. Откройте импорт, чтобы применить список');
    }
  } catch (error) {
    saveImportBusy = false;
    if (drawerMode === 'save-import' && $('settings-dialog').open) {
      renderSaveImport();
      update(`Не удалось прочитать сохранение: ${error.message}`);
    } else toast(`Импорт не выполнен: ${error.message}`);
  }
}
function renderRecipeSettings() {
  $('settings-title').textContent = 'Каталог рецептов';
  const buildings = [...new Set(data.recipes.map((r) => r.buildingId))]
    .map((id) => buildingMap.get(id))
    .sort((a, b) => names(a)[0].localeCompare(names(b)[0], 'ru'));
  $('settings-body').innerHTML =
    `<p class="settings-intro">Сравните обычные и альтернативные способы производства. Все потоки и мощность ниже - <strong>для одного здания при 100%</strong>. Галочка разрешает рецепт: решатель сам выбирает подходящее сочетание</p><div class="settings-controls"><div class="search-box">${icon('search')}<input type="search" id="recipe-search" placeholder="Продукт, рецепт или ингредиент / RU / EN" aria-label="Поиск рецептов"></div><button class="button small ghost" id="enable-all-recipes">Разрешить все</button></div><div class="catalog-filters"><label>Здание<select id="recipe-building-filter" aria-label="Фильтр рецептов по зданию"><option value="all">Все здания</option>${buildings.map((b) => `<option value="${esc(b.id)}">${esc(names(b)[0])}</option>`).join('')}</select></label><label>Состояние<select id="recipe-status-filter" aria-label="Фильтр состояния рецептов"><option value="all">Все рецепты</option><option value="used">Используются в плане</option><option value="allowed">Разрешены</option><option value="disabled">Не разрешены</option></select></label></div><div class="settings-controls"><label class="check-label"><input type="checkbox" id="recipe-alternates-only">Только альтернативные</label><label class="check-label"><input type="checkbox" id="enable-seasonal" ${state.seasonal ? 'checked' : ''}>Сезонные FICSMAS</label></div><p class="catalog-count" id="recipe-catalog-count"></p><div class="recipe-catalog" id="recipe-list"></div><p class="helper">Потоки на карточке описывают один рецепт; полная потребность в сырье зависит от всей цепочки. MAM-рецепты входят в обычные. Преобразования сырья разрешаются отдельно; отметка «открыт» сама не включает альтернативу. Доступ по этапам HUB и исследованиям здесь не определяется автоматически</p>`;
  $('recipe-search').oninput = fillRecipeList;
  $('recipe-alternates-only').onchange = fillRecipeList;
  $('recipe-building-filter').onchange = fillRecipeList;
  $('recipe-status-filter').onchange = fillRecipeList;
  $('enable-seasonal').onchange = (e) => {
    state.seasonal = e.target.checked;
    fillRecipeList();
    renderControls();
    scheduleSolve();
  };
  $('settings-body')
    .querySelector('.settings-intro')
    .insertAdjacentHTML(
      'afterend',
      `<div class="conversion-settings"><label class="check-label"><input type="checkbox" id="catalog-conversions" data-conversion-policy ${state.resourceConversions ? 'checked' : ''}>Разрешить все преобразования сырья</label><p>Боксит → уран и другие превращения сырья с SAM - отдельная технология. По умолчанию они выключены. Можно разрешить весь набор здесь или один рецепт галочкой в каталоге. Остальные производства в преобразователе остаются доступны</p></div>`,
    );
  $('enable-all-recipes').textContent = 'Включить доступные альтернативы';
  $('enable-all-recipes').onclick = () => {
    state = chooseAlternateMode(data, state, true);
    fillRecipeList();
    renderControls();
    scheduleSolve();
  };
  $('recipe-list').insertAdjacentHTML(
    'beforebegin',
    `<div class="catalog-unlocks"><span>${unlockedSummary()}</span><button class="text-button" data-import-save>Из сохранения .sav</button><button class="text-button" data-unlock-all>Все открыты</button><button class="text-button" data-unlock-none>Ничего не открыто</button></div>`,
  );
  fillRecipeList();
}
function fillRecipeList() {
  const q = $('recipe-search').value.trim().toLowerCase(),
    altOnly = $('recipe-alternates-only').checked,
    building = $('recipe-building-filter').value,
    status = $('recipe-status-filter').value;
  const active = new Set(result?.status === 'optimal' ? result.recipes.map((r) => r.recipeId) : []),
    openGroups = new Set(
      [...$('recipe-list').querySelectorAll('details[open]')].map((el) => el.dataset.recipeGroup),
    );
  const enabled = (r) => recipePermission(r, state).enabled;
  const recipes = data.recipes
    .filter((r) => {
      if ((altOnly && !r.alternate) || (building !== 'all' && r.buildingId !== building))
        return false;
      if (
        (status === 'used' && !active.has(r.id)) ||
        (status === 'allowed' && !enabled(r)) ||
        (status === 'disabled' && enabled(r))
      )
        return false;
      const materials = [...new Set([...Object.keys(r.inputs), ...Object.keys(r.outputs)])]
        .map((id) => {
          const i = itemMap.get(id);
          return `${i?.name} ${i?.nameRu}`;
        })
        .join(' ');
      return `${r.name} ${r.nameRu} ${materials}`.toLowerCase().includes(q);
    })
    .sort(
      (a, b) =>
        Number(a.alternate) - Number(b.alternate) || names(a)[0].localeCompare(names(b)[0], 'ru'),
    );
  const groups = new Map();
  for (const recipe of recipes) {
    const item = Object.keys(recipe.outputs)[0];
    if (!groups.has(item)) groups.set(item, []);
    groups.get(item).push(recipe);
  }
  $('recipe-catalog-count').textContent =
    `Найдено: ${recipes.length} рецептов / ${groups.size} продуктов`;
  const unlockCount = $('settings-body').querySelector('.catalog-unlocks > span');
  if (unlockCount) unlockCount.textContent = unlockedSummary();
  const materialRows = (flows) =>
    Object.entries(flows)
      .map(
        ([id, rate]) =>
          `<div class="catalog-material">${itemIcon(itemMap.get(id), 'small')}${dual(itemMap.get(id))}<span>${num(rate)}<small>${unit(id)}</small></span></div>`,
      )
      .join('');
  $('recipe-list').innerHTML =
    [...groups]
      .sort((a, b) => itemName(a[0]).localeCompare(itemName(b[0]), 'ru'))
      .map(
        ([id, variants]) =>
          `<details class="recipe-group" data-recipe-group="${esc(id)}" ${q || groups.size < 4 || openGroups.has(id) || state.targets.some((t) => t.item === id) ? 'open' : ''}><summary>${itemIcon(itemMap.get(id))}${dual(itemMap.get(id))}<span class="recipe-group-count">${variants.length} вариантов<br><small>${variants.filter(enabled).length} разрешено</small></span></summary><div class="recipe-variants">${variants
            .map((r) => {
              const machine = buildingMap.get(r.buildingId),
                variable = Math.abs(r.powerMaxMW - r.powerMinMW) > 0.01;
              return `<article class="catalog-recipe ${active.has(r.id) ? 'in-plan' : ''}"><div class="catalog-recipe-heading"><label><input type="checkbox" data-recipe-toggle="${esc(r.id)}" aria-label="Разрешить рецепт: ${esc(names(r)[0])}" ${enabled(r) ? 'checked' : ''}>${dual(r)}</label><span class="catalog-badges">${recipePermission(r, state).selected ? '<span class="status-tag in-plan-tag">ВЫБРАН</span>' : ''}${!recipePermission(r, state).unlocked ? '<span class="status-tag warning">НЕ ОТКРЫТ</span>' : ''}<span class="${r.alternate ? 'alternate-badge' : 'status-tag'}">${r.alternate ? 'ALT' : r.conversion ? 'СЫРЬЁ → СЫРЬЁ' : 'ОБЫЧНЫЙ'}</span>${r.seasonal ? '<span class="status-tag">FICSMAS</span>' : ''}${active.has(r.id) ? '<span class="status-tag in-plan-tag">В ПЛАНЕ</span>' : ''}</span></div><p class="recipe-permission">${esc(recipePermission(r, state).reason)}</p><div class="catalog-machine">${itemIcon(machine)}${dual(machine)}<span>${num(r.time)} с / цикл<strong>${num(r.powerMW)} МВт</strong>${variable ? `<small>${num(r.powerMinMW)}-${num(r.powerMaxMW)} МВт</small>` : ''}</span></div><div class="catalog-flows"><section><h4>Потребляет / мин</h4>${materialRows(r.inputs)}</section><section><h4>Производит / мин</h4>${materialRows(r.outputs)}</section></div></article>`;
            })
            .join('')}</div></details>`,
      )
      .join('') ||
    '<div class="empty-message">Рецепты не найдены. Попробуйте изменить поиск или фильтры</div>';
}
function renderResourceSettings() {
  $('settings-title').textContent = 'Добыча, чистота и лимиты';
  const resources = data.resources
    .filter((r) => r.type !== 'external')
    .sort((a, b) => itemName(a.itemId).localeCompare(itemName(b.itemId), 'ru'));
  $('settings-body').innerHTML =
    `<p class="settings-intro">Лимит задаёт доступный поток в минуту. Пустое поле - без ограничения, 0 - запретить добычу. Вес задаёт цену ресурса в стратегии «Минимум ресурсов»: увеличьте его для дефицитного сырья</p><div class="settings-row header-row"><span>Ресурс</span><span>Чистота</span><span>Лимит / мин</span><span>Вес</span></div>${resources
      .map((r) => {
        const s = state.resourceSettings[r.itemId] || {};
        return `<div class="settings-row"><div class="table-name">${itemIcon(itemMap.get(r.itemId), 'small')}${dual(itemMap.get(r.itemId))}</div><select data-resource="${r.itemId}" data-field="purity" aria-label="Чистота: ${esc(itemName(r.itemId))}" ${r.type === 'water' ? 'disabled' : ''}>${[
          [0.5, 'Низкая'],
          [1, 'Нормальная'],
          [2, 'Высокая'],
        ]
          .map(
            ([v, label]) =>
              `<option value="${v}" ${Number(r.type === 'water' ? 1 : (s.purity ?? state.defaultPurity)) === v ? 'selected' : ''}>${label}</option>`,
          )
          .join(
            '',
          )}</select><input type="number" min="0" step="any" placeholder="∞" value="${s.limit ?? ''}" data-resource="${r.itemId}" data-field="limit" aria-label="Лимит: ${esc(itemName(r.itemId))}"><input type="number" min="0" step="any" value="${s.weight ?? Number(getResourceWeightDetails(r.itemId, resourceWeightOptions()).weight.toFixed(6))}" data-resource="${r.itemId}" data-field="weight" aria-label="Вес: ${esc(itemName(r.itemId))}"></div>`;
      })
      .join(
        '',
      )}<div class="note-bar neutral">${icon('info')}<span>Чистота не меняет потребность фабрики в руде. Она меняет производительность добывающего здания. Все добывающие здания работают на 100%</span></div><p class="helper">Ограниченные и ручные предметы, отходы реакторов и готовую продукцию добавляйте через «Готовые входящие ресурсы»</p><button class="button small ghost" id="reset-resource-settings">Сбросить лимиты и веса</button>`;
  $('reset-resource-settings').onclick = () => {
    state.resourceSettings = {};
    renderResourceSettings();
    scheduleSolve();
  };
  $('settings-body').insertAdjacentHTML(
    'afterbegin',
    `<div class="resource-profile"><label><strong>Цена первичного сырья</strong><select id="resource-profile" aria-label="Профиль редкости ресурсов"><option value="scarce" ${state.resourceProfile === 'scarce' ? 'selected' : ''}>С учётом редкости на карте</option><option value="equal" ${state.resourceProfile === 'equal' ? 'selected' : ''}>Равные веса сырья</option></select></label><p>Редкость: максимальная добыча железа / максимальная добыча ресурса на обычной карте. Железо = 1, вода = 0. Это предпочтение оптимизатора, а не лимит добычи</p><p>Ручные веса ниже имеют приоритет. Увеличьте вес далёкого сырья или уменьшите вес доступного рядом. <a href="${esc(RESOURCE_WEIGHT_METADATA.sourceDocumentationUrl)}" target="_blank" rel="noreferrer">Источник данных карты</a> / ${esc(RESOURCE_WEIGHT_METADATA.gameVersion)}</p><button class="text-button" id="reset-resource-weights">Вернуть веса профиля</button></div>`,
  );
  $('resource-profile').onchange = (e) => {
    state.resourceProfile = e.target.value;
    renderResourceSettings();
    renderControls();
    scheduleSolve();
  };
  $('reset-resource-weights').onclick = () => {
    for (const setting of Object.values(state.resourceSettings)) delete setting.weight;
    renderResourceSettings();
    renderControls();
    scheduleSolve();
  };
  const pinned = pinnedResourceItems(data, state);
  if (pinned.length)
    $('settings-body').insertAdjacentHTML(
      'afterbegin',
      `<div class="note-bar neutral">${icon('info')}<span>Для ${pinned.map((item) => esc(itemName(item))).join(', ')} выбран конкретный рецепт преобразования. Прямая добыча временно выключена; сохранённые лимиты ниже снова действуют после снятия этого выбора во вкладке «Альтернативы»</span></div>`,
    );
}
function renderImportsSettings() {
  $('settings-title').textContent = 'Готовые входящие ресурсы';
  $('settings-body').innerHTML =
    `<p class="settings-intro">Укажите, что уже поступает с другого завода. Это верхняя граница доступной поставки: решатель возьмёт только нужное количество. Производство и энергия этой поставки остаются за пределами текущего плана</p>${state.imports.length ? state.imports.map((i, index) => `<div class="import-row"><div class="table-name">${itemIcon(itemMap.get(i.item))}${dual(itemMap.get(i.item))}</div><input type="number" min="0.001" step="any" value="${i.rate}" data-import-index="${index}" aria-label="Входящая поставка ${esc(itemName(i.item))}"><span class="tiny-label">${unit(i.item)}</span><button class="icon-button" data-remove-import="${index}" aria-label="Удалить поставку">${icon('close')}</button></div>`).join('') : '<div class="empty-message">Пока нет внешних поставок<br>Все необходимые ресурсы добываются или производятся в плане</div>'}<button class="button add-button" id="add-import" style="margin-top:18px">${icon('plus')}Добавить поставку</button><p class="helper">Так можно задать урановые отходы от уже работающей электростанции, энергослизней, подарки или другие ограниченные материалы. Автоматическая генерация энергии и отходов электростанций в эту версию не входит</p>`;
  $('add-import').onclick = () => openPicker('import');
}
function renderAbout() {
  $('settings-title').textContent = 'Данные и расчёт';
  const m = data.meta,
    c = m.counts || {};
  $('settings-body').innerHTML =
    `<div class="about-copy"><div class="about-meta"><div><span>Версия данных</span><strong>${esc(m.gameVersion)}</strong></div><div><span>Дата снимка</span><strong>${esc((m.fetchedAt || '').slice(0, 10))}</strong></div><div><span>Производственные рецепты</span><strong>${data.recipes.length}</strong></div><div><span>Альтернативы с жёстких дисков</span><strong>${c.alternates || data.recipes.filter((r) => r.alternate).length}</strong></div><div><span>Сезонные рецепты</span><strong>${c.seasonalRecipes || 0}</strong></div></div><h3>Что минимизируется</h3><p><strong>Ресурсы:</strong> сумма потоков добычи, умноженных на заданные веса. По умолчанию вес учитывает доступность на обычной карте: максимальная добыча железа делится на максимальную добычу выбранного ресурса. Железо имеет вес 1, вода - 0. Можно выбрать равные веса или задать свои. Это условный индекс, а не физическая сумма масс</p><p><strong>Энергия:</strong> средняя мощность производства и добычи при 100% <strong>Здания:</strong> сумма дробных эквивалентов производственных и добывающих машин. Количество не округляется и индивидуальный разгон не подбирается</p><h3>Как работает решатель</h3><p>HiGHS решает общую задачу линейного программирования в WebAssembly. Для каждого предмета проверяется баланс: производство и входы покрывают расход и требуемый выпуск. Совместные продукты, альтернативы и возвраты решаются вместе. Расчёт работает в отдельном Web Worker</p><p>Положительный остаток показан как излишек. Это обязательный внешний выход схемы: потребитель, переработка или утилизация. Жидкость нельзя напрямую отправить в AWESOME Sink. Замкнутому циклу в игре может потребоваться стартовый запас</p><h3>Границы расчёта</h3><ul><li>Фиксированная частота 100%, дробные эквиваленты зданий. Somersloops, собственная генерация, физическая прокладка конвейеров и высота труб не моделируются</li><li>Количество параллельных конвейеров и труб рассчитывается по выбранному максимальному уровню. Насосы, освещение и общие прессуризаторы скважин не входят в мощность. Для работающего прессуризатора нужно отдельно добавить 150 МВт</li><li>Для зданий с переменной мощностью показывается средняя и диапазон. Энергия внешних поставок находится за границей плана</li><li>Промышленная база содержит Tier 9 и сезонные рецепты. Сезонные выключены по умолчанию. Открытые альтернативы можно прочитать из сохранения .sav или отметить вручную. Ручные запреты хранятся отдельно и сохраняются при повторном импорте. Прогресс HUB/MAM не ограничивает обычные рецепты автоматически</li><li>Каждая полоса - конвейер или труба выбранного уровня; большие пучки сворачиваются до шести видимых линий, с точным числом в подписи. Номинальная ёмкость и фактическая загрузка указаны отдельно. Пересечения оформлены эстакадами и не означают соединение потоков</li></ul><h3>Источники и обновление</h3><p>Снимок <a href="${esc(m.sourceUrl)}" target="_blank" rel="noreferrer">SCIM Stable</a> и <a href="${esc(m.localizationSourceUrl)}" target="_blank" rel="noreferrer">русская локализация</a>. Источник обозначает ветку Stable, без точного номера патча. ${m.docsVerification ? `Рецепты дополнительно сверены с игровым Docs ${esc(m.docsVerification.gameVersion || m.docsVerification.version || '1.2.3.1')}` : ''}</p><p>В исходниках есть воспроизводимый скрипт обновления <code>scripts/refresh-data.py</code>, сохранён SHA-256 источника. Все расчёты и изображения поставляются с приложением, внешние сервисы для расчёта не нужны</p><h3>Локальные планы и переносимость</h3><p>План сохраняется в localStorage этого браузера. Экспортируйте JSON для резервной копии. Кнопка «Поделиться» помещает параметры в часть ссылки после #. Доступ к самой странице зависит от её хостинга</p><p>Приложение статическое и подготовлено для GitHub Pages: в исходниках есть workflow публикации <a href="./factory-lens-source.zip" download>Скачать исходники и инструкцию</a>. Игровые названия и изображения принадлежат Coffee Stain Studios. Factory Lens - независимый фанатский инструмент</p></div>`;
  if (m.recipeAudit)
    $('settings-body')
      .querySelector('.about-meta')
      .insertAdjacentHTML(
        'afterend',
        `<h3>Проверка актуальности / ${esc(m.recipeAudit.checkedAt.slice(0, 10))}</h3><p>Сверены все ${num(m.recipeAudit.recipeCount)} производственных рецепта и ${num(m.recipeAudit.altCount)} альтернатив: здания, ингредиенты, продукты, время и мощность. Совпадение со свежим SCIM Stable, игровым Docs 1.2.3.1 и набором Satisfactory Tools ${esc(m.recipeAudit.verifiedDatasetVersion)}</p><p>Последний проверенный выпуск игры - ${esc(m.recipeAudit.latestRelease)}. В его <a href="https://store.steampowered.com/news/app/526870/view/679641571029680377" target="_blank" rel="noreferrer">официальных изменениях</a> указаны исправления сети; изменений рецептов не заявлено. Отдельная игровая выгрузка именно этого патча не сверялась <a href="./data/recipe-audit.json" target="_blank" rel="noreferrer">Полный отчёт проверки и источники</a></p><h3>Выбор рецептов</h3><p>Новый план сначала спрашивает про альтернативы. В базовом режиме отдельный рецепт можно выбрать через вершину, сохранив остальные выключенными. Импорт .sav обновляет доступность, не переключая режим. Преобразования сырья с SAM, включая боксит → уран, выключены отдельно; обычные рецепты в Converter остаются доступны</p>`,
      );
}
function selectNode(node) {
  selected = node;
  renderInspector();
}
function updateGraphSummary() {
  const c = graph.getCounts();
  $('graph-summary').textContent = c.focus
    ? `Участок: ${c.visibleNodes} из ${c.nodes} узлов`
    : `${c.nodes} узлов / ${c.edges} потоков`;
  $('clear-focus').hidden = !c.focus;
}
function updateGraphView(view) {
  const percent = Math.round(view.zoom * 100);
  $('zoom-value').textContent = `${percent}%`;
  $('zoom-value').title =
    percent === 100
      ? 'Масштаб 100%. Нажмите, чтобы перейти к выпуску'
      : 'Вернуть 100% и перейти к выпуску';
  $('graph-overview-hint').hidden = percent >= 65;
}
function searchGraph() {
  const q = $('graph-search').value.trim().toLowerCase();
  if (!q || !result) {
    $('graph-search-results').hidden = true;
    return;
  }
  const options = [];
  for (const row of result.recipes) {
    const r = recipeMap.get(row.recipeId);
    const output = itemMap.get(Object.keys(row.outputs)[0]);
    if (`${r.name} ${r.nameRu} ${output?.name} ${output?.nameRu}`.toLowerCase().includes(q))
      options.push({
        id: `recipe:${row.recipeId}`,
        title: r,
        icon: output,
        subtitle: `${num(row.machines, 3)} здания`,
      });
  }
  for (const row of result.resources) {
    const item = itemMap.get(row.item);
    if (`${item.name} ${item.nameRu}`.toLowerCase().includes(q))
      options.push({
        id: `resource:${row.item}`,
        title: item,
        icon: item,
        subtitle: `${num(row.rate)} ${unit(row.item)}`,
      });
  }
  $('graph-search-results').innerHTML =
    options
      .slice(0, 8)
      .map(
        (o) =>
          `<button class="graph-search-option" data-search-focus="${esc(o.id)}">${itemIcon(o.icon, 'small')}${dual(o.title)}<span>${o.subtitle}</span></button>`,
      )
      .join('') ||
    '<p class="helper" style="padding:12px">В этом плане такой процесс не используется</p>';
  $('graph-search-results').hidden = false;
}
function renderInspector() {
  if (!selected) return;
  const node = selected,
    row = node.data || {},
    recipe = recipeMap.get(node.recipeId),
    item = itemMap.get(node.itemId),
    title = recipe || item || { name: node.name };
  const inputs =
      row.inputs ||
      (node.kind === 'target' || node.kind === 'surplus' ? { [node.itemId]: row.rate } : {}),
    outputs =
      row.outputs ||
      (node.kind === 'resource' || node.kind === 'import' ? { [node.itemId]: row.rate } : {});
  const selfReturns = Object.entries(inputs)
    .filter(([id, rate]) => rate > 1e-6 && outputs[id] > 1e-6)
    .map(([id, rate]) => [id, Math.min(rate, outputs[id])]);
  const rows = (flows) =>
    Object.entries(flows)
      .map(
        ([id, rate]) =>
          `<div class="flow-row">${itemIcon(itemMap.get(id), 'small')}${dual(itemMap.get(id))}<span class="flow-amount">${num(rate)}<small>${unit(id)}</small></span></div>`,
      )
      .join('');
  const type =
    {
      recipe: 'ПРОИЗВОДСТВО',
      resource: 'ДОБЫЧА',
      import: 'ВНЕШНЯЯ ПОСТАВКА',
      target: 'ЦЕЛЕВОЙ ВЫПУСК',
      surplus: 'ПОБОЧНЫЙ ПРОДУКТ',
    }[node.kind] || '';
  $('inspector').innerHTML =
    `<div class="inspector-header"><span>${itemIcon(item || itemMap.get(Object.keys(outputs)[0] || Object.keys(inputs)[0]))}</span><div><div class="eyebrow" style="margin-bottom:7px">${type}</div>${dual(title)}</div><button class="icon-button" id="close-inspector" aria-label="Закрыть детали">${icon('close')}</button></div>${recipe ? `<div class="inspector-building">${itemIcon(buildingMap.get(recipe.buildingId))}${dual(buildingMap.get(recipe.buildingId))}</div>` : ''}${row.machines !== undefined ? `<div class="inspector-stats"><div class="mini-metric"><small>Зданий / 100%</small><strong>${num(row.machines, 3)}</strong></div><div class="mini-metric"><small>Средняя мощность</small><strong>${num(row.powerMW, 1)} <span style="font-size:12px">МВт</span></strong></div></div>` : ''}${Object.keys(inputs).length ? `<h4>Входящие потоки / Inputs</h4>${rows(inputs)}` : ''}${Object.keys(outputs).length ? `<h4>Выпуск / Outputs</h4>${rows(outputs)}` : ''}${node.kind === 'surplus' ? `<p class="helper">${item?.form === 'solid' && item?.sinkable ? 'Можно направить потребителю или в AWESOME Sink. Энергия утилизации не включена' : 'Нужен потребитель, переработка или допустимый способ вывода. Прямой отправки в AWESOME Sink нет'}</p>` : ''}${selfReturns.length ? `<div class="return-note"><strong>Возврат в тот же процесс</strong><br>${selfReturns.map(([id, rate]) => `${esc(itemName(id))}: ${num(rate)} ${unit(id)}`).join('<br>')}<br>Полный вход указан выше; возвращённый поток не требует повторной добычи</div>` : ''}${recipe ? `<button class="button subtle wide" id="choose-selected-recipe">Сравнить и выбрать рецепт</button>` : ''}${node.kind === 'resource' ? `<button class="button subtle wide" data-open-resources>Цена и доступность сырья</button>` : ''}<h4>Рассмотреть участок</h4><div class="focus-actions"><button class="button subtle" data-focus="neighbors">Этот узел и ближайшие связи</button><button class="button subtle" data-focus="upstream">Что требуется на входе</button><button class="button subtle" data-focus="downstream">Куда идёт выпуск</button></div>${recipe ? `<button class="text-button" id="disable-selected-recipe" style="margin-top:15px">Исключить этот рецепт из расчёта</button>` : ''}<p class="helper">Полные количества показаны для всего плана. Фокус меняет только видимую часть схемы</p>`;
  $('inspector').hidden = false;
  $('close-inspector').onclick = () => {
    $('inspector').hidden = true;
    selected = null;
  };
  $('inspector')
    .querySelectorAll('[data-focus]')
    .forEach(
      (b) =>
        (b.onclick = () => {
          graph.setFocus(node.id, b.dataset.focus);
          $('clear-focus').hidden = false;
          $('inspector').hidden = true;
          const c = graph.getCounts();
          $('graph-summary').textContent = `Фокус: ${c.visibleNodes} из ${c.nodes} узлов`;
        }),
    );
  if (recipe) {
    $('choose-selected-recipe').onclick = () => openRecipeChoice(primaryProduct(recipe));
    $('disable-selected-recipe').onclick = () => {
      state = setRecipeEnabled(data, state, recipe.id, false);
      renderControls();
      scheduleSolve();
    };
  }
}
function exportBuild() {
  if (!result) return;
  const rows = [
    [
      'Recipe RU',
      'Recipe EN',
      'Building RU',
      'Building EN',
      'Machine equivalents at 100%',
      'Power MW',
      'Outputs per minute',
    ],
  ];
  result.recipes.forEach((r) => {
    const recipe = recipeMap.get(r.recipeId),
      building = buildingMap.get(r.buildingId);
    rows.push([
      recipe.nameRu,
      recipe.name,
      building.nameRu,
      building.name,
      r.machines,
      r.powerMW,
      Object.entries(r.outputs)
        .map(([id, v]) => `${itemMap.get(id).name}: ${v}`)
        .join('; '),
    ]);
  });
  result.resources.forEach((r) => {
    const i = itemMap.get(r.item),
      b = machineName(r);
    rows.push([
      `Добыча: ${i.nameRu}`,
      `Extraction: ${i.name}`,
      b.nameRu,
      b.name,
      r.machines,
      r.powerMW,
      `${i.name}: ${r.rate}`,
    ]);
  });
  result.imports
    .filter((r) => r.rate > 1e-6)
    .forEach((r) => {
      const i = itemMap.get(r.item);
      rows.push([
        `Внешняя поставка: ${i.nameRu}`,
        `External supply: ${i.name}`,
        'Внешняя поставка',
        'External supply',
        0,
        0,
        `${i.name}: ${r.rate}`,
      ]);
    });
  exportCSV(rows, 'factory-lens-buildings.csv');
}
function exportBalance() {
  if (!result) return;
  const rows = [
    [
      'Item RU',
      'Item EN',
      'Unit',
      'Extraction',
      'Import',
      'Produced',
      'Consumed',
      'Target',
      'Surplus',
    ],
  ];
  Object.entries(result.balance)
    .filter(([, b]) => Object.values(b).some((x) => x > 1e-6))
    .forEach(([id, b]) => {
      const i = itemMap.get(id);
      rows.push([
        i.nameRu,
        i.name,
        unit(id),
        b.extracted,
        b.imported,
        b.produced,
        b.consumed,
        b.target,
        b.surplus,
      ]);
    });
  exportCSV(rows, 'factory-lens-balance.csv');
}
function exportCSV(rows, filename) {
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  download(
    '\ufeff' + rows.map((row) => row.map(quote).join(';')).join('\r\n'),
    filename,
    'text/csv;charset=utf-8',
  );
}

function installEvents() {
  document.addEventListener('click', (event) => {
    const objective = event.target.closest('[data-objective]');
    if (objective && objective.dataset.objective !== state.objective) {
      state.objective = objective.dataset.objective;
      renderControls();
      scheduleSolve();
    }
    const alt = event.target.closest('[data-alternates],[data-start-recipes]');
    if (alt) {
      state = chooseAlternateMode(
        data,
        state,
        (alt.dataset.alternates ?? alt.dataset.startRecipes) === 'true',
      );
      renderControls();
      scheduleSolve();
    }
    const tab = event.target.closest('[data-tab]');
    if (tab) switchTab(tab.dataset.tab);
    const tabLink = event.target.closest('[data-tab-link]');
    if (tabLink) switchTab(tabLink.dataset.tabLink);
    const remove = event.target.closest('.target-remove');
    if (remove && state.targets.length > 1) {
      state.targets.splice(Number(remove.dataset.index), 1);
      renderControls();
      scheduleSolve();
    }
    const change = event.target.closest('.target-change');
    if (change) openPicker('target', Number(change.dataset.index));
    const pick = event.target.closest('[data-pick]');
    if (pick) applyPick(pick.dataset.pick);
    const closer = event.target.closest('[data-close-dialog]');
    if (closer) closer.closest('dialog').close();
    const removeImport = event.target.closest('[data-remove-import]');
    if (removeImport) {
      state.imports.splice(Number(removeImport.dataset.removeImport), 1);
      renderImportsSettings();
      renderControls();
      scheduleSolve();
    }
    const apply = event.target.closest('[data-apply-mode]');
    if (apply) {
      state.objective = apply.dataset.applyMode;
      renderControls();
      scheduleSolve();
      switchTab('graph');
    }
    const sf = event.target.closest('[data-search-focus]');
    if (sf) {
      graph.setFocus(sf.dataset.searchFocus, 'neighbors');
      $('graph-search-results').hidden = true;
      $('graph-search').value = '';
      $('inspector').hidden = true;
      selected = null;
      updateGraphSummary();
    }
    if (event.target.closest('[data-open-catalog]')) openSettings('recipes');
    if (event.target.closest('[data-open-resources]')) openSettings('resources');
    if (event.target.closest('[data-import-save]')) openSettings('save-import');
    const ban = event.target.closest('[data-ban-recipe]');
    if (ban) {
      state = setRecipeEnabled(data, state, ban.dataset.banRecipe, false);
      renderControls();
      renderUsedAlternates();
      scheduleSolve();
      toast('Рецепт исключён. Ищем замену среди разрешённых');
    }
    const restore = event.target.closest('[data-restore-recipe]');
    if (restore) {
      state.disabledRecipes = state.disabledRecipes.filter(
        (id) => id !== restore.dataset.restoreRecipe,
      );
      renderControls();
      renderUsedAlternates();
      scheduleSolve();
    }
    const choice = event.target.closest('[data-choose-item]');
    if (choice) openRecipeChoice(choice.dataset.chooseItem);
    const pin = event.target.closest('[data-pin-recipe]');
    if (pin) setRecipeChoice(pin.dataset.pinItem, pin.dataset.pinRecipe);
    const unpin = event.target.closest('[data-clear-recipe-choice]');
    if (unpin) setRecipeChoice(unpin.dataset.clearRecipeChoice, null);
    if (event.target.closest('[data-unlock-all]')) {
      state.unlockedAlternates = null;
      state.recipeImport = null;
      renderRecipeSettings();
      renderControls();
      scheduleSolve();
    }
    if (event.target.closest('[data-unlock-none]')) {
      state = applyUnlockedRecipes(data, state, [], { saveName: 'Список задан вручную' }).state;
      renderRecipeSettings();
      renderControls();
      scheduleSolve();
    }
  });
  document.addEventListener('change', (event) => {
    if (!event.target.matches('[data-conversion-policy]')) return;
    state.resourceConversions = event.target.checked;
    if (!state.resourceConversions) {
      state.enabledConversions = [];
      for (const [item, id] of Object.entries(state.recipeOverrides))
        if (recipeMap.get(id)?.conversion) delete state.recipeOverrides[item];
    }
    renderControls();
    if (drawerMode === 'recipes' && $('settings-dialog').open) fillRecipeList();
    scheduleSolve();
  });
  $('targets').addEventListener('input', (event) => {
    if (event.target.matches('.target-amount')) {
      const v = Number(event.target.value);
      event.target.setCustomValidity(
        v > 0 && v <= 1e8 ? '' : 'Введите положительную скорость не больше 100000000',
      );
      if (!event.target.checkValidity()) return;
      state.targets[Number(event.target.dataset.index)].rate = v;
      scheduleSolve();
    }
  });
  $('targets').addEventListener('change', (event) => {
    if (event.target.matches('.target-amount') && !event.target.checkValidity())
      event.target.reportValidity();
  });
  $('add-target').onclick = () => openPicker();
  $('item-search').oninput = fillPicker;
  $('manage-recipes').onclick = () => openSettings('recipes');
  $('manage-resources').onclick = () => openSettings('resources');
  $('manage-imports').onclick = () => openSettings('imports');
  $('manage-transport').onclick = $('graph-transport').onclick = () => openSettings('transport');
  $('open-about').onclick = $('data-info').onclick = () => openSettings('about');
  $('miner-tier').onchange = (event) => {
    state.minerTier = Number(event.target.value);
    scheduleSolve();
  };
  $('default-purity').onchange = (event) => {
    state.defaultPurity = Number(event.target.value);
    for (const setting of Object.values(state.resourceSettings)) delete setting.purity;
    scheduleSolve();
  };
  $('language').onchange = (event) => {
    state.language = event.target.value;
    persistChange();
    renderControls();
    graph.setLanguage(state.language);
    if (!state.alternateModeChosen) showRecipeStart();
    if (result) {
      renderBuild();
      renderBalance();
      renderDependencies();
      renderUsedAlternates();
      if (activeTab === 'compare') renderComparison();
    }
    if (selected) renderInspector();
  };
  $('preset').onchange = (event) => {
    const presets = {
      nuclear: [{ item: 'Desc_NuclearFuelRod_C', rate: 4 }],
      frames: [{ item: 'Desc_ModularFrameHeavy_C', rate: 10 }],
      oil: [
        { item: 'Desc_Plastic_C', rate: 120 },
        { item: 'Desc_Rubber_C', rate: 120 },
      ],
      tier9: [{ item: 'Desc_SpaceElevatorPart_11_C', rate: 1 }],
    };
    const targets = presets[event.target.value];
    if (!targets) return;
    if (targets.some((t) => !itemMap.has(t.item))) {
      toast('Этот предмет не найден в текущей базе. Выберите его через поиск');
      return;
    }
    state.targets = targets;
    renderControls();
    scheduleSolve();
    event.target.value = '';
  };
  $('new-project').onclick = () => {
    state = { ...defaultState(), language: state.language };
    renderControls();
    scheduleSolve();
    toast('Открыт новый план: тяжёлые модульные каркасы, 10/мин');
  };
  $('settings-body').addEventListener('input', (event) => {
    const el = event.target;
    if (el.matches('input[data-resource]')) {
      const id = el.dataset.resource,
        field = el.dataset.field;
      if (el.value !== '' && (!Number.isFinite(Number(el.value)) || Number(el.value) < 0)) return;
      if (!state.resourceSettings[id]) state.resourceSettings[id] = {};
      if (el.value === '') delete state.resourceSettings[id][field];
      else state.resourceSettings[id][field] = Number(el.value);
      scheduleSolve();
    }
    if (el.matches('[data-import-index]')) {
      const rate = Number(el.value);
      if (rate > 0 && Number.isFinite(rate)) {
        state.imports[Number(el.dataset.importIndex)].rate = rate;
        scheduleSolve();
      }
    }
  });
  $('settings-body').addEventListener('change', (event) => {
    const el = event.target;
    if (el.matches('[data-transport]')) {
      const field = el.dataset.transport,
        tier = Number(el.value),
        tiers = field === 'beltTier' ? BELT_TIERS : PIPE_TIERS;
      if (!tiers.some((t) => t.tier === tier)) return;
      state[field] = tier;
      renderControls();
      renderTransportExample();
      renderDependencies();
      if (selected) renderInspector();
      persistChange();
    }
    if (el.matches('[data-recipe-toggle]')) {
      state = setRecipeEnabled(data, state, el.dataset.recipeToggle, el.checked);
      if ($('enable-seasonal')) $('enable-seasonal').checked = state.seasonal;
      fillRecipeList();
      renderControls();
      scheduleSolve();
    }
    if (el.matches('select[data-resource]')) {
      const id = el.dataset.resource,
        field = el.dataset.field;
      if (!state.resourceSettings[id]) state.resourceSettings[id] = {};
      state.resourceSettings[id][field] = Number(el.value);
      scheduleSolve();
    }
    if (el.matches('[data-import-index]')) {
      const rate = Number(el.value);
      if (rate <= 0 || !Number.isFinite(rate)) {
        el.reportValidity();
        return;
      }
      state.imports[Number(el.dataset.importIndex)].rate = rate;
      scheduleSolve();
    }
  });
  $('fit-graph').onclick = () => graph.fit();
  $('zoom-in').onclick = () => graph.zoomIn();
  $('zoom-out').onclick = () => graph.zoomOut();
  $('zoom-value').onclick = $('readable-view').onclick = () => {
    graph.clearFocus();
    graph.resetView();
    $('inspector').hidden = true;
    selected = null;
    updateGraphSummary();
  };
  const navigateGraph = (destination) => {
    graph.clearFocus();
    $('inspector').hidden = true;
    selected = null;
    destination === 'start' ? graph.centerStart() : graph.centerTarget();
    updateGraphSummary();
  };
  $('graph-start').onclick = () => navigateGraph('start');
  $('graph-target').onclick = () => navigateGraph('target');
  $('graph-spacing').onchange = (event) => graph.setSpacing(event.target.value);
  $('clear-focus').onclick = () => {
    graph.clearFocus();
    $('inspector').hidden = true;
    selected = null;
    updateGraphSummary();
  };
  const expandCanvas = () => {
    const expanded = document.querySelector('.planner-panel').classList.toggle('expanded');
    $('expand-canvas').setAttribute('aria-label', expanded ? 'Свернуть схему' : 'Развернуть схему');
    $('expand-canvas').title = expanded ? 'Свернуть схему (Esc)' : 'Развернуть схему';
  };
  $('expand-canvas').onclick = expandCanvas;
  document.addEventListener('keydown', (e) => {
    if (
      e.key === 'Escape' &&
      !$('settings-dialog').open &&
      !$('picker-dialog').open &&
      document.querySelector('.planner-panel').classList.contains('expanded')
    )
      expandCanvas();
  });
  $('graph-search').oninput = searchGraph;
  $('graph-search').onkeydown = (e) => {
    if (e.key === 'Escape') {
      $('graph-search-results').hidden = true;
      $('graph-search').value = '';
    }
  };
  $('export-svg').onclick = async () => {
    if (result) download(await graph.exportSVGAsync(), 'factory-lens-flow.svg', 'image/svg+xml');
  };
  $('export-project').onclick = () =>
    download(JSON.stringify(persistentState(), null, 2), 'factory-lens-plan.json');
  $('share-project').onclick = async () => {
    const url = new URL(location.href);
    url.hash = `plan=${encodePlan(persistentState())}`;
    try {
      await navigator.clipboard.writeText(url.href);
      toast('Ссылка на план скопирована. Получателю нужен доступ к странице');
    } catch {
      download(url.href, 'factory-lens-link.txt', 'text/plain');
      toast('Ссылка сохранена в текстовый файл');
    }
  };
  $('import-project').onclick = () => $('project-file').click();
  $('save-file').onchange = async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (file) await importGameSave(file);
  };
  $('project-file').onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 2e6) throw new Error('Файл должен быть меньше 2 МБ');
      state = normalizeState(JSON.parse(await file.text()), { source: 'json' });
      history.replaceState(null, '', location.pathname + location.search);
      renderControls();
      scheduleSolve();
      toast('План загружен из JSON');
    } catch (error) {
      toast(`Не удалось открыть план: ${error.message}`);
    }
    event.target.value = '';
  };
  $('toggle-settings').onclick = () => $('sidebar').classList.toggle('visible');
  window.addEventListener('hashchange', () => {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (!hash.has('plan')) return;
    try {
      state = normalizeState(decodePlan(hash.get('plan')), { source: 'hash' });
      renderControls();
      scheduleSolve();
      toast('Открыт план из ссылки');
    } catch (error) {
      toast(`Не удалось открыть план: ${error.message}`);
    }
  });
}

async function main() {
  hydrate();
  try {
    const response = await fetch(new URL('./data/game-data.json', import.meta.url));
    if (!response.ok) throw new Error(`База рецептов недоступна: HTTP ${response.status}`);
    data = await response.json();
    itemMap = new Map(data.items.map((i) => [i.id, i]));
    recipeMap = new Map(data.recipes.map((r) => [r.id, r]));
    buildingMap = new Map(data.buildings.map((b) => [b.id, b]));
    loadState();
    graph = createGraph($('graph-canvas'), { onSelect: selectNode, onViewChange: updateGraphView });
    graph.setLanguage(state.language);
    dependencies = createDependencyView($('view-dependencies'), {
      onShowGraph: (nodeId) => {
        switchTab('graph');
        graph.clearFocus();
        graph.centerNode(nodeId);
        $('inspector').hidden = true;
        selected = null;
        updateGraphSummary();
      },
    });
    renderControls();
    installEvents();
    if (!state.alternateModeChosen) showRecipeStart();
    $('version-badge').title =
      `${data.meta.gameVersion}; снимок ${(data.meta.fetchedAt || '').slice(0, 10)}; ${data.recipes.length} рецептов`;
    await initWorker();
    await calculate();
    save();
  } catch (error) {
    setStatus('Ошибка загрузки', false, true);
    $('graph-empty').hidden = false;
    $('graph-empty').innerHTML =
      `${icon('warning')}<strong>Не удалось загрузить калькулятор</strong><p>${esc(error.message)}</p><p>Откройте приложение через HTTP(S). Для локального запуска используйте сервер из README</p><button class="button ghost" onclick="location.reload()">Повторить</button>`;
  }
}
main();
