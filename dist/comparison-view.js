import { comparePlans, recipeForOutput } from './plan-comparison.js';

const changed = (before, after) =>
  Math.abs(after - before) > 1e-6 * Math.max(1, Math.abs(before), Math.abs(after));

function difference(before, after) {
  const delta = changed(before, after) ? after - before : 0;
  return { before, after, delta, percent: before ? delta / before * 100 : null };
}

function ingredientRows(before = {}, after = {}) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((item) => {
      const values = difference(before[item] || 0, after[item] || 0);
      const change = values.delta === 0 ? 'unchanged'
        : values.before === 0 ? 'added'
          : values.after === 0 ? 'removed'
            : values.delta > 0 ? 'increased' : 'decreased';
      return { item, ...values, change };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.item.localeCompare(b.item));
}

function signed(value, format) {
  return `${value < 0 ? '−' : value > 0 ? '+' : ''}${format.num(Math.abs(value), 2)}`;
}

function deltaView(row, unit, format, neutral = false, generation = false) {
  const direction = row.delta < 0 ? 'decrease' : row.delta > 0 ? 'increase' : 'same';
  const tone = generation && direction !== 'same'
    ? direction === 'increase' ? 'decrease' : 'increase'
    : direction;
  const label = row.delta < 0 ? 'Меньше' : row.delta > 0 ? 'Больше' : 'Без изменений';
  return `<div class="comparison-delta ${neutral ? 'is-neutral' : `is-${tone}`}">
    <strong>${signed(row.delta, format)}${unit ? ` <span>${format.esc(unit)}</span>` : ''}</strong>
    ${row.percent !== null ? `<span class="comparison-percent">${signed(row.percent, format)}%</span>` : ''}
    <small>${label}</small>
  </div>`;
}

function beforeAfter(before, after, unit, format, hasBefore = true, labels = {}) {
  const beforeLabel = labels.before || 'Сейчас';
  const afterLabel = labels.after || 'После';
  return `<div class="comparison-before-after">
    ${hasBefore ? `<span class="comparison-number"><small>${format.esc(beforeLabel)}</small><strong>${format.num(before)}</strong></span><span class="comparison-arrow" aria-hidden="true">→</span>` : ''}
    <span class="comparison-number"><small>${format.esc(hasBefore ? afterLabel : 'Этот вариант')}</small><strong>${format.num(after)}</strong></span>
    ${unit ? `<span class="comparison-rate-unit">${format.esc(unit)}</span>` : ''}
  </div>`;
}

function metricView(key, label, unit, values, objective, format, hasBefore = true, labels = {}) {
  return `<article class="comparison-metric${objective === key ? ' is-objective' : ''}">
    <div class="comparison-metric-label">${label}${objective === key ? '<span class="comparison-objective">Цель расчёта</span>' : ''}</div>
    ${beforeAfter(values.before, values.after, unit, format, hasBefore, labels)}
    ${hasBefore ? deltaView(values, unit, format, false, key === 'generation') : ''}
  </article>`;
}

function itemView(itemId, format) {
  const item = format.itemMap.get(itemId) || { id: itemId, name: itemId };
  return `<div class="comparison-item">${format.itemIcon(item, 'small')}${format.dual(item)}</div>`;
}

function changeBadge(change) {
  if (change === 'added') return '<span class="comparison-change-badge">Добавится</span>';
  if (change === 'removed') return '<span class="comparison-change-badge">Убирается</span>';
  return '';
}

function flowTable(rows, format, { neutral = false, hasBefore = true, labels = {} } = {}) {
  return `<table class="comparison-flow-table">
    <thead><tr><th>Ресурс</th><th>${hasBefore ? `${format.esc(labels.before || 'Сейчас')} → ${format.esc(labels.after || 'После')}` : 'Количество'}</th>${hasBefore ? '<th>Изменение</th>' : ''}</tr></thead>
    <tbody>${rows.map((row) => `<tr data-item="${format.esc(row.item)}">
      <td class="comparison-item-cell">${itemView(row.item, format)}${hasBefore ? changeBadge(row.change) : ''}</td>
      <td class="comparison-values-cell">${beforeAfter(row.before, row.after, format.unit(row.item), format, hasBefore, labels)}</td>
      ${hasBefore ? `<td class="comparison-delta-cell">${deltaView(row, format.unit(row.item), format, neutral)}</td>` : ''}
    </tr>`).join('')}</tbody>
  </table>`;
}

function changeGroups(rows, format, hasBefore = true) {
  if (!rows.length) return `<p class="comparison-no-change">${hasBefore ? 'Расход не меняется' : 'Добыча не требуется'}</p>`;
  if (!hasBefore) return flowTable(rows, format, { hasBefore: false });
  const groups = [
    { direction: 'decrease', title: 'Потребуется меньше', rows: rows.filter((row) => row.delta < 0) },
    { direction: 'increase', title: 'Потребуется больше', rows: rows.filter((row) => row.delta > 0) },
  ];
  return groups.filter((group) => group.rows.length).map((group) => `
    <section class="comparison-change-group is-${group.direction}">
      <h5>${group.title}</h5>${flowTable(group.rows, format)}
    </section>`).join('');
}

export function renderPlanDelta({ current, next, objective, format }) {
  if (!next?.totals) return '';
  const hasBefore = Boolean(current?.totals);
  const comparison = comparePlans(current, next);
  const metrics = [
    ['resources', 'Ресурсный индекс', ''],
    ['energy', 'Потребление', 'МВт'],
    ['buildings', 'Здания при 100%', 'зд'],
  ];
  if (comparison.metrics.generation)
    metrics.push(['generation', 'Выработка АЭС', 'МВт']);
  const netPower = next.totals.powerMW - (next.totals.generationMW || 0);
  return `<section class="comparison-view comparison-plan">
    <div class="comparison-heading">
      <h4>${hasBefore ? 'Изменится во всём плане' : 'Показатели всего плана'}</h4>
      <p>${hasBefore ? 'Текущая схема → схема с этим рецептом' : 'Текущей схемы для сравнения пока нет'}</p>
    </div>
    <div class="comparison-metric-grid">${metrics.map(([key, label, unit]) =>
      metricView(key, label, unit, comparison.metrics[key], objective, format, hasBefore)).join('')}</div>
    <p class="comparison-explanation">Ресурсный индекс учитывает объём добычи, редкость ресурсов и заданные вами веса</p>
    ${comparison.metrics.generation ? `<p class="comparison-explanation">${netPower > 0 ? 'После выработки АЭС потребуется извне' : 'После потребления завода останется'} <strong>${format.num(Math.abs(netPower))} МВт</strong><br>Цель «Минимум энергии» сравнивает потребление, выработка показана отдельно</p>` : ''}
    <section class="comparison-resource-section">
      <h4>${hasBefore ? 'Что изменится в добыче' : 'Необходимая добыча'}</h4>
      ${changeGroups(comparison.resourceChanges, format, hasBefore)}
    </section>
    ${comparison.importChanges.length ? `<section class="comparison-resource-section">
      <h4>Внешние поставки</h4>${changeGroups(comparison.importChanges, format, hasBefore)}
    </section>` : ''}
    ${comparison.surplusChanges.length ? `<details class="comparison-surplus">
      <summary>Излишки и побочные продукты <span>${comparison.surplusChanges.length}</span></summary>
      <p class="comparison-explanation">Дополнительному выпуску потребуется потребитель или утилизация</p>
      ${flowTable(comparison.surplusChanges, format, { neutral: true, hasBefore })}
    </details>` : ''}
  </section>`;
}

function baselineFlows(flows, title, format) {
  return `<section class="comparison-baseline-flows"><h5>${title}</h5>
    ${Object.entries(flows).map(([item, rate]) => `<div class="comparison-baseline-row">
      ${itemView(item, format)}
      <span class="comparison-baseline-rate"><strong>${format.num(rate)}</strong><small>${format.esc(format.unit(item))}</small></span>
    </div>`).join('')}
  </section>`;
}

export function renderRecipeRates({ recipe, itemId, outputRate, reference, referenceLabel, format }) {
  const normalized = recipeForOutput(recipe, itemId, outputRate);
  const hasBefore = Boolean(reference);
  const inputRows = ingredientRows(reference?.inputs, normalized.inputs);
  const byproducts = ingredientRows(reference?.outputs, normalized.outputs)
    .filter((row) => row.item !== itemId);
  const machines = difference(reference?.machines || 0, normalized.machines);
  const power = difference(reference?.powerMW || 0, normalized.powerMW);
  const generation = difference(reference?.generationMW || 0, normalized.generationMW || 0);
  const baselineLabel = referenceLabel || 'Сейчас';
  const labels = { before: baselineLabel, after: 'Этот рецепт' };
  return `<section class="comparison-view comparison-recipe">
    <div class="comparison-heading"><h4>Сравнение при одинаковом выпуске</h4></div>
    <div class="comparison-output">
      ${itemView(itemId, format)}
      <span class="comparison-output-rate"><strong>${format.num(outputRate)}</strong><small>${format.esc(format.unit(itemId))}</small></span>
    </div>
    <p class="comparison-explanation">Одинаковый выпуск используется только для сравнения этого участка${hasBefore ? `<br>Исходный вариант: <strong>${format.esc(baselineLabel)}</strong>` : ''}</p>
    <div class="comparison-local-metrics">
      ${metricView('buildings', 'Здания участка при 100%', 'зд', machines, null, format, hasBefore, labels)}
      ${metricView('energy', 'Потребление участка', 'МВт', power, null, format, hasBefore, labels)}
      ${generation.before > 0 || generation.after > 0 ? metricView('generation', 'Выработка участка', 'МВт', generation, null, format, hasBefore, labels) : ''}
    </div>
    <section class="comparison-resource-section"><h4>Ингредиенты участка</h4>
      ${flowTable(inputRows, format, { hasBefore, labels })}
    </section>
    <p class="comparison-explanation">Изменение ингредиентов относится к этому участку<br>Влияние всей цепочки и побочных продуктов учтено в сравнении всего плана</p>
    ${byproducts.length ? `<section class="comparison-resource-section comparison-local-byproducts">
      <h4>Побочные продукты участка</h4>${flowTable(byproducts, format, { neutral: true, hasBefore, labels })}
    </section>` : ''}
    <details class="comparison-baseline">
      <summary>Одно здание при 100% <span>Нормы из игры</span></summary>
      <div class="comparison-baseline-meta">
        <span>Цикл <strong>${format.num(recipe.time)} с</strong></span>
        <span>${recipe.generator ? 'Выработка' : 'Потребление'} <strong>${format.num(recipe.generator ? recipe.generationMW : recipe.powerMW)} МВт</strong></span>
      </div>
      <div class="comparison-baseline-grid">
        ${baselineFlows(recipe.inputs, 'Вход за минуту / Inputs', format)}
        ${baselineFlows(recipe.outputs, 'Выпуск за минуту / Outputs', format)}
      </div>
    </details>
  </section>`;
}
