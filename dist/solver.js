import loadHighs from './vendor/highs/highs.mjs';

// Recipe variables are machine equivalents; resource variables are units per minute
// Material balances retain surplus as an explicit output
const EPS = 1e-7;
const POWER_EXPONENT = Math.log2(2.5);
const MINER_POWER = { 1: 5, 2: 15, 3: 45 };
let enginePromise;

export async function initSolver() {
  if (!enginePromise) {
    enginePromise = loadHighs({
      locateFile: (name) => new URL(`./vendor/highs/${name}`, import.meta.url).href,
      print: () => {},
      printErr: () => {},
    }).catch((error) => {
      enginePromise = undefined;
      throw error;
    });
  }
  return enginePromise;
}

const finite = (x) => Number.isFinite(Number(x));
const tidy = (x) => (Math.abs(x) < EPS ? 0 : x);
const countBuildings = (x) => Math.max(0, Math.ceil(x - 1e-6));
const sum = (values) => values.reduce((a, b) => a + b, 0);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const numeric = (x) => Number(x.toPrecision(14)).toString();

function namedItem(data, id) {
  const item = data.items.find((i) => i.id === id);
  return item?.nameRu || item?.name || id;
}

function readClock(value, fallback, label) {
  const number = value == null ? fallback : Number(value);
  if (!finite(number) || number < 1 || number > 250) {
    throw new Error(`${label}: допустимо от 1 до 250%`);
  }
  return number;
}

function purityFactor(value) {
  if (value == null || value === 'normal') return 1;
  if (value === 'impure') return 0.5;
  if (value === 'pure') return 2;
  const n = Number(value);
  if (![0.5, 1, 2].includes(n)) throw new Error('Чистота залежи должна быть 0.5, 1 или 2');
  return n;
}

function resourceParameters(resource, opts) {
  const setting = opts.resourceSettings?.[resource.itemId] || {};
  const tier = Number(opts.minerTier ?? 3);
  if (![1, 2, 3].includes(tier)) throw new Error('Выберите бур Mk.1, Mk.2 или Mk.3');
  const clock = readClock(opts.minerClock, 100, 'Частота добычи');
  const purity =
    resource.type === 'water' || resource.type === 'external' ? 1 : purityFactor(setting.purity);
  const multiplier = resource.type === 'miner' ? 2 ** (tier - 1) : 1;
  const capacity =
    resource.type === 'external'
      ? 0
      : (Number(resource.baseRate) * multiplier * purity * clock) / 100;
  const basePower = resource.type === 'miner' ? MINER_POWER[tier] : Number(resource.powerMW || 0);
  const powerPerMachine = basePower * (clock / 100) ** POWER_EXPONENT;
  const weight = Number(setting.weight ?? resource.weight ?? 1);
  const configuredLimit =
    setting.limit == null || setting.limit === '' ? resource.defaultLimit : setting.limit;
  const limit = configuredLimit == null ? null : Number(configuredLimit);
  if (!finite(weight) || weight < 0)
    throw new Error('Вес сырья должен быть неотрицательным числом');
  if (limit !== null && (!finite(limit) || limit < 0))
    throw new Error('Лимит добычи должен быть неотрицательным числом');
  if (resource.type !== 'external' && (!finite(capacity) || capacity <= 0)) {
    throw new Error(`В данных нет корректной производительности добычи: ${resource.itemId}`);
  }
  return {
    item: resource.itemId,
    itemId: resource.itemId,
    type: resource.type,
    tier,
    clock,
    purity,
    capacity,
    weight,
    limit,
    powerPerMachine,
  };
}

function expression(coefficients, variables) {
  const terms = [];
  for (let j = 0; j < coefficients.length; j++) {
    const coefficient = coefficients[j];
    if (Math.abs(coefficient) <= 1e-13) continue;
    terms.push(
      `${coefficient < 0 ? '-' : '+'} ${numeric(Math.abs(coefficient))} ${variables[j].name}`,
    );
  }
  return terms.length ? terms.join(' ') : `0 ${variables[0].name}`;
}

function lpText(model, costs, primaryBound = null) {
  const lines = ['Minimize', ` obj: ${expression(costs, model.variables)}`, 'Subject To'];
  for (let i = 0; i < model.rows.length; i++) {
    lines.push(
      ` b${i}: ${expression(model.rows[i].coefficients, model.variables)} >= ${numeric(model.rows[i].demand)}`,
    );
  }
  if (primaryBound) {
    lines.push(
      ` primary: ${expression(primaryBound.costs, model.variables)} <= ${numeric(primaryBound.value)}`,
    );
  }
  lines.push('Bounds');
  for (const variable of model.variables) {
    lines.push(
      variable.limit == null
        ? ` 0 <= ${variable.name}`
        : ` 0 <= ${variable.name} <= ${numeric(variable.limit)}`,
    );
  }
  lines.push('End');
  return lines.join('\n');
}

function buildModel(data, opts) {
  if (
    !Array.isArray(data.items) ||
    !Array.isArray(data.recipes) ||
    !Array.isArray(data.resources)
  ) {
    throw new Error('Некорректный формат базы предметов и рецептов');
  }
  const clock = readClock(opts.clock, 100, 'Частота производства');
  const clockRatio = clock / 100;
  const clockPower = clockRatio ** POWER_EXPONENT;
  const mode = opts.objective || 'resources';
  if (!['resources', 'energy', 'buildings'].includes(mode))
    throw new Error('Неизвестная цель оптимизации');
  const itemIds = new Set(data.items.map((i) => i.id));
  const targetsMap = new Map();
  for (const target of opts.targets || []) {
    if (!itemIds.has(target.item)) throw new Error(`Неизвестный предмет: ${target.item}`);
    const rate = Number(target.rate);
    if (!finite(rate) || rate < 0)
      throw new Error('Объём производства должен быть неотрицательным числом');
    if (rate > 0) targetsMap.set(target.item, (targetsMap.get(target.item) || 0) + rate);
  }
  if (!targetsMap.size) throw new Error('Добавьте хотя бы одну цель с объёмом больше нуля');
  const targets = Array.from(targetsMap, ([item, rate]) => ({ item, rate }));
  const disabled = new Set(opts.disabledRecipes || []);
  const buildings = new Map((data.buildings || []).map((b) => [b.id, b]));
  const recipes = data.recipes.filter(
    (r) =>
      !(opts.alternates === false && r.alternate) &&
      !(r.seasonal && opts.seasonal !== true) &&
      !disabled.has(r.id),
  );
  const variables = [];
  const activeItems = new Set(targets.map((t) => t.item));
  for (const recipe of recipes) {
    const flow = {};
    for (const [item, rate] of Object.entries(recipe.inputs || {})) {
      if (!finite(rate) || Number(rate) < 0)
        throw new Error(`Некорректный расход в рецепте ${recipe.name}`);
      flow[item] = (flow[item] || 0) - Number(rate) * clockRatio;
      activeItems.add(item);
    }
    for (const [item, rate] of Object.entries(recipe.outputs || {})) {
      if (!finite(rate) || Number(rate) < 0)
        throw new Error(`Некорректный выход в рецепте ${recipe.name}`);
      flow[item] = (flow[item] || 0) + Number(rate) * clockRatio;
      activeItems.add(item);
    }
    const power =
      Number(recipe.powerMW ?? buildings.get(recipe.buildingId)?.powerMW ?? 0) * clockPower;
    if (!finite(power) || power < 0)
      throw new Error(`Некорректная мощность рецепта ${recipe.name}`);
    const generation = Number(recipe.generationMW ?? 0) * clockRatio;
    if (!finite(generation) || generation < 0 || (generation > 0 && recipe.generator !== true))
      throw new Error(`Некорректная генерация энергии в рецепте ${recipe.name}`);
    variables.push({
      name: `r${variables.length}`,
      kind: 'recipe',
      recipe,
      flow,
      power,
      generation,
      machines: 1,
      rawCost: 0,
      limit: null,
    });
  }
  for (const resource of data.resources) {
    const parameters = resourceParameters(resource, opts);
    const perUnitMachines = parameters.capacity > 0 ? 1 / parameters.capacity : 0;
    variables.push({
      name: `q${variables.length}`,
      kind: 'resource',
      parameters,
      flow: { [resource.itemId]: 1 },
      power: parameters.powerPerMachine * perUnitMachines,
      machines: perUnitMachines,
      rawCost: parameters.weight,
      limit: parameters.limit,
    });
    activeItems.add(resource.itemId);
  }
  const importsMap = new Map();
  for (const imported of opts.imports || []) {
    if (!itemIds.has(imported.item))
      throw new Error(`Неизвестный импортируемый предмет: ${imported.item}`);
    const rate = Number(imported.rate);
    if (!finite(rate) || rate < 0) throw new Error('Внешняя поставка должна быть неотрицательной');
    if (rate > 0) importsMap.set(imported.item, (importsMap.get(imported.item) || 0) + rate);
  }
  for (const [item, available] of importsMap) {
    variables.push({
      name: `i${variables.length}`,
      kind: 'import',
      item,
      available,
      flow: { [item]: 1 },
      power: 0,
      machines: 0,
      rawCost: 0,
      limit: available,
    });
    activeItems.add(item);
  }
  if (!variables.length) throw new Error('В базе нет доступных рецептов или источников сырья');
  const rows = [...activeItems].map((item) => ({
    item,
    demand: targetsMap.get(item) || 0,
    coefficients: variables.map((v) => v.flow[item] || 0),
  }));
  const resourceCost = variables.map((v) => v.rawCost);
  const energyCost = variables.map((v) => v.power);
  const machineCost = variables.map((v) => v.machines);
  const primary =
    mode === 'resources' ? resourceCost : mode === 'energy' ? energyCost : machineCost;
  // Fix the primary optimum before minimizing secondary costs

  const secondary = variables.map((v) =>
    mode === 'resources'
      ? v.power + v.machines * 1e-3 + (v.kind === 'import' ? 1e-5 : 0)
      : mode === 'energy'
        ? v.machines + v.rawCost * 1e-5 + (v.kind === 'import' ? 1e-6 : 0)
        : v.rawCost + v.power * 1e-5 + (v.kind === 'import' ? 1e-6 : 0),
  );
  return { variables, rows, primary, secondary, targets, mode, clock, clockRatio, clockPower };
}

const highOptions = {
  output_flag: false,
  presolve: 'on',
  time_limit: 20,
  primal_feasibility_tolerance: 1e-8,
  dual_feasibility_tolerance: 1e-8,
};

function getValues(solution, model) {
  return model.variables.map((variable) =>
    Math.max(0, Number(solution.Columns?.[variable.name]?.Primal || 0)),
  );
}

function infeasibleDetails(engine, model, data) {
  const relaxation = {
    ...model,
    variables: model.variables.slice(),
    rows: model.rows.map((row) => ({ ...row, coefficients: row.coefficients.slice() })),
  };
  for (const target of model.targets) {
    const name = `short${relaxation.variables.length}`;
    relaxation.variables.push({
      name,
      kind: 'shortage',
      item: target.item,
      flow: { [target.item]: 1 },
      limit: target.rate,
    });
    for (const row of relaxation.rows) row.coefficients.push(row.item === target.item ? 1 : 0);
  }
  const costs = relaxation.variables.map((v) =>
    v.kind === 'shortage' ? 1 / model.targets.find((t) => t.item === v.item).rate : 0,
  );
  try {
    const solution = engine.solve(lpText(relaxation, costs), highOptions);
    if (solution.Status !== 'Optimal') return [];
    const values = getValues(solution, relaxation);
    return relaxation.variables.flatMap((v, i) =>
      v.kind === 'shortage' && values[i] > EPS
        ? [
            {
              item: v.item,
              name: namedItem(data, v.item),
              requested: model.targets.find((t) => t.item === v.item).rate,
              shortage: values[i],
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

function materialize(data, model, values, primaryOptimum, secondaryUsed) {
  const itemMap = new Map(data.items.map((item) => [item.id, item]));
  const recipes = [];
  const resources = [];
  const imports = [];
  const balance = Object.fromEntries(
    model.rows.map((row) => [
      row.item,
      { produced: 0, consumed: 0, target: row.demand, imported: 0, extracted: 0, surplus: 0 },
    ]),
  );
  const warnings = [];
  let powerMinMW = 0;
  let powerMaxMW = 0;
  let maxViolation = 0;
  for (let j = 0; j < model.variables.length; j++) {
    const variable = model.variables[j];
    const value = values[j];
    if (variable.limit !== null) maxViolation = Math.max(maxViolation, value - variable.limit);
    if (value <= 1e-8) continue;
    if (variable.kind === 'recipe') {
      const recipe = variable.recipe;
      const inputs = Object.fromEntries(
        Object.entries(recipe.inputs || {}).map(([item, rate]) => [
          item,
          Number(rate) * model.clockRatio * value,
        ]),
      );
      const outputs = Object.fromEntries(
        Object.entries(recipe.outputs || {}).map(([item, rate]) => [
          item,
          Number(rate) * model.clockRatio * value,
        ]),
      );
      for (const [item, rate] of Object.entries(inputs)) balance[item].consumed += rate;
      for (const [item, rate] of Object.entries(outputs)) balance[item].produced += rate;
      const powerMW = variable.power * value;
      const min =
        Number(recipe.powerMinMW ?? recipe.powerMW ?? variable.power / model.clockPower) *
        model.clockPower *
        value;
      const max =
        Number(recipe.powerMaxMW ?? recipe.powerMW ?? variable.power / model.clockPower) *
        model.clockPower *
        value;
      powerMinMW += min;
      powerMaxMW += max;
      recipes.push({
        recipeId: recipe.id,
        id: recipe.id,
        name: recipe.name,
        buildingId: recipe.buildingId,
        machines: value,
        buildings: countBuildings(value),
        clock: model.clock,
        baseEquivalent: value * model.clockRatio,
        basePowerMW: variable.power / model.clockPower,
        baseGenerationMW: variable.generation / model.clockRatio,
        generationMW: variable.generation * value,
        generator: recipe.generator === true,
        powerExponent: POWER_EXPONENT,
        inputs,
        outputs,
        powerMW,
        powerMinMW: min,
        powerMaxMW: max,
      });
    } else if (variable.kind === 'resource') {
      const parameters = variable.parameters;
      const machines = variable.machines * value;
      const powerMW = variable.power * value;
      resources.push({
        ...parameters,
        rate: value,
        machines,
        buildings: countBuildings(machines),
        powerMW,
      });
      balance[parameters.itemId].extracted += value;
      powerMinMW += powerMW;
      powerMaxMW += powerMW;
    } else {
      imports.push({ item: variable.item, rate: value, available: variable.available });
      balance[variable.item].imported += value;
    }
  }
  const surplus = [];
  let maxBalanceError = 0;
  for (const [item, b] of Object.entries(balance)) {
    const net = b.produced + b.imported + b.extracted - b.consumed - b.target;
    maxViolation = Math.max(maxViolation, -net);
    b.surplus = Math.max(0, tidy(net));
    maxBalanceError = Math.max(
      maxBalanceError,
      Math.abs(b.produced + b.imported + b.extracted - b.consumed - b.target - b.surplus),
    );
    if (b.surplus > 1e-5)
      surplus.push({
        item,
        rate: b.surplus,
        form: itemMap.get(item)?.form || 'solid',
        sinkable: itemMap.get(item)?.sinkable === true,
      });
  }
  const resourceRate = sum(resources.map((r) => r.rate));
  const weightedResources = sum(resources.map((r) => r.rate * r.weight));
  const productionPowerMW = sum(recipes.map((r) => r.powerMW));
  const resourcePowerMW = sum(resources.map((r) => r.powerMW));
  const generationMW = sum(recipes.map((r) => r.generationMW));
  const machines = sum(recipes.map((r) => r.machines)) + sum(resources.map((r) => r.machines));
  const buildings = sum(recipes.map((r) => r.buildings)) + sum(resources.map((r) => r.buildings));
  // Balanced recycling loops can still need an initial stock in the game

  const producers = new Map();
  recipes.forEach((recipe, i) =>
    Object.keys(recipe.outputs).forEach((item) => {
      if (!producers.has(item)) producers.set(item, []);
      producers.get(item).push(i);
    }),
  );
  const upstream = recipes.map((recipe) => [
    ...new Set(Object.keys(recipe.inputs).flatMap((item) => producers.get(item) || [])),
  ]);
  const color = new Array(recipes.length).fill(0);
  function containsCycle(index) {
    if (color[index] === 1) return true;
    if (color[index] === 2) return false;
    color[index] = 1;
    for (const next of upstream[index]) if (containsCycle(next)) return true;
    color[index] = 2;
    return false;
  }
  const hasCycles = recipes.some((_, i) => containsCycle(i));
  if (hasCycles)
    warnings.push(
      'Замкнутые потоки рассчитаны в установившемся режиме. При запуске контуров может понадобиться стартовый запас и настройка приоритетов подачи',
    );
  if (surplus.length)
    warnings.push(
      'Излишки показаны отдельными потоками. Для непрерывной работы им нужны потребители, переработка или утилизация; накопление в хранилище временно',
    );
  if (surplus.some((s) => s.form !== 'solid'))
    warnings.push(
      'Жидкие и газовые излишки нельзя напрямую отправить в AWESOME Sink: предусмотрите переработку, упаковку или отдельного потребителя',
    );
  if (surplus.some((s) => s.form === 'solid' && !s.sinkable))
    warnings.push(
      'Среди излишков есть предметы без подтверждённой утилизации в AWESOME Sink. Проверьте способ вывода, особенно для радиоактивных отходов',
    );
  if (resources.some((r) => r.type === 'well'))
    warnings.push(
      'Добыча из скважин показана по спутникам. Общие прессуризаторы требуют ещё 150 МВт каждый при 100%; их число зависит от выбранных кластеров и здесь не оптимизируется',
    );
  if (resources.some((r) => r.type === 'external'))
    warnings.push(
      'Часть сырья поступает извне или собирается вручную. Для этих ресурсов не добавлены автоматические добывающие здания',
    );
  if (recipes.some((r) => Math.abs(r.powerMaxMW - r.powerMinMW) > EPS))
    warnings.push(
      'Для зданий с переменной мощностью оптимизация использует среднюю мощность. Электросети дополнительно нужен запас для пиков',
    );
  if (
    recipes.some((r) => Math.abs(r.machines - Math.round(r.machines)) > 1e-5) ||
    resources.some((r) => Math.abs(r.machines - Math.round(r.machines)) > 1e-5)
  )
    warnings.push(
      'Дробные машины означают эквивалентную загрузку при выбранной частоте. Оптимизируется эта загрузка; подбор целого числа зданий и индивидуальных частот не выполняется. Мощность: средняя при такой загрузке',
    );
  if (generationMW > EPS)
    warnings.push(
      'Ядерные реакторы обеспечивают отходы для переработки. Их генерация показана отдельно; цель «Энергия» минимизирует потребление производства и добычи, без вычитания генерации',
    );
  warnings.push(
    'Не учтены логистика, насосы, освещение, усилители Somersloop и генерация других электростанций',
  );
  const totalPower = productionPowerMW + resourcePowerMW;
  const value =
    model.mode === 'resources'
      ? weightedResources
      : model.mode === 'energy'
        ? totalPower
        : machines;
  const units =
    model.mode === 'resources'
      ? 'взвешенные единицы сырья/мин'
      : model.mode === 'energy'
        ? 'МВт'
        : 'эквивалентных зданий';
  return {
    status: maxViolation <= 1e-5 ? 'optimal' : 'error',
    message:
      maxViolation <= 1e-5
        ? 'Найден оптимальный материальный баланс'
        : 'Решение не прошло проверку материального баланса',
    objective: { mode: model.mode, value, units, primaryOptimum, tieBreakApplied: secondaryUsed },
    recipes,
    resources,
    imports,
    targets: model.targets,
    surplus,
    totals: {
      resourceRate,
      weightedResources,
      powerMW: totalPower,
      generationMW,
      netPowerMW: totalPower - generationMW,
      productionPowerMW,
      resourcePowerMW,
      powerMinMW,
      powerMaxMW,
      machines,
      buildings,
      recipeCount: recipes.length,
    },
    warnings,
    validation: { maxBalanceError, maxViolation, feasible: maxViolation <= 1e-5 },
    hasCycles,
    balance,
  };
}

export async function solve(data, options = {}) {
  try {
    const model = buildModel(data, options);
    const engine = await initSolver();
    const primaryResult = engine.solve(lpText(model, model.primary), highOptions);
    if (primaryResult.Status !== 'Optimal') {
      if (
        primaryResult.Status === 'Infeasible' ||
        primaryResult.Status === 'Primal infeasible or unbounded'
      ) {
        const shortages = infeasibleDetails(engine, model, data);
        const unavailable = shortages.map((t) => t.name).join(', ');
        return {
          status: 'infeasible',
          message: `При выбранных рецептах, поставках и лимитах цели недостижимы.${unavailable ? ` Не хватает: ${unavailable}.` : ''} Проверьте альтернативные рецепты, лимиты добычи и внешние поставки`,
          shortages,
          solverStatus: primaryResult.Status,
        };
      }
      return {
        status: 'error',
        message: `Оптимизатор не подтвердил решение: ${primaryResult.Status}. Попробуйте уменьшить число целей`,
        solverStatus: primaryResult.Status,
      };
    }
    let values = getValues(primaryResult, model);
    const optimum = dot(model.primary, values);
    let secondaryUsed = false;
    // Keep the primary optimum exact to avoid tiny extra production branches
    // If the secondary LP is infeasible, retain the primary solution

    const secondaryResult = engine.solve(
      lpText(model, model.secondary, { costs: model.primary, value: optimum }),
      highOptions,
    );
    if (secondaryResult.Status === 'Optimal') {
      const candidate = getValues(secondaryResult, model);
      if (dot(model.primary, candidate) <= optimum + 1e-6) {
        values = candidate;
        secondaryUsed = true;
      }
    }
    return materialize(data, model, values, optimum, secondaryUsed);
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

export const MODEL_INFO = Object.freeze({
  solver: 'HiGHS 1.16.0 WebAssembly',
  type: 'continuous LP',
  powerExponent: POWER_EXPONENT,
  fixedClock: true,
  integerOptimum: false,
});
