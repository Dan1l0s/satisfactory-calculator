export const BELT_TIERS = Object.freeze(
  [
    { tier: 1, capacity: 60, label: 'Mk.1' },
    { tier: 2, capacity: 120, label: 'Mk.2' },
    { tier: 3, capacity: 270, label: 'Mk.3' },
    { tier: 4, capacity: 480, label: 'Mk.4' },
    { tier: 5, capacity: 780, label: 'Mk.5' },
    { tier: 6, capacity: 1200, label: 'Mk.6' },
  ].map(Object.freeze),
);

export const PIPE_TIERS = Object.freeze(
  [
    { tier: 1, capacity: 300, label: 'Mk.1' },
    { tier: 2, capacity: 600, label: 'Mk.2' },
  ].map(Object.freeze),
);

const DISPLAY_LANES = 6;

// loads holds up to six values, ending with the last lane; count includes every lane
export function planTransport(itemOrForm, rate, { beltTier = 5, pipeTier = 2 } = {}) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new TypeError('Transport rate must be a finite number');
  }
  if (rate < 0) throw new RangeError('Transport rate cannot be negative');
  const form = typeof itemOrForm === 'string' ? itemOrForm : (itemOrForm?.form ?? 'solid');
  if (!['solid', 'liquid', 'gas', 'fluid'].includes(form)) {
    throw new RangeError(`Unknown material form: ${String(form)}`);
  }
  const kind = form === 'solid' ? 'belt' : 'pipe';
  const tiers = kind === 'belt' ? BELT_TIERS : PIPE_TIERS;
  const tier = kind === 'belt' ? beltTier : pipeTier;
  const selected = tiers.find((candidate) => candidate.tier === tier);
  if (!selected) throw new RangeError(`Invalid ${kind} tier: ${String(tier)}`);
  const capacity = selected.capacity;

  const quotient = rate / capacity;
  const nearest = Math.round(quotient);
  // Snap numerical noise at exact capacities without hiding real overflow

  const tolerance = Math.min(1e-8, Number.EPSILON * 8 * Math.max(1, quotient));
  const exactMultiple = nearest > 0 && Math.abs(quotient - nearest) <= tolerance;
  const normalizedRate = exactMultiple ? nearest * capacity : rate;
  const count = rate === 0 ? 0 : Math.max(1, exactMultiple ? nearest : Math.ceil(quotient));
  if (!Number.isSafeInteger(count)) {
    throw new RangeError('Transport lane count exceeds the safe integer range');
  }
  const fullCount = exactMultiple ? count : Math.floor(quotient);
  const lastLoad = count === 0 ? 0 : exactMultiple ? capacity : rate - fullCount * capacity;
  const totalCapacity = count * capacity;
  const spareCapacity = Math.max(0, totalCapacity - normalizedRate);
  const utilization = count === 0 ? 0 : Math.min(1, normalizedRate / totalCapacity);
  const previewCount = Math.min(count, DISPLAY_LANES);
  const loads = Array.from({ length: previewCount }, (_, index) =>
    index === previewCount - 1 ? lastLoad : capacity,
  );
  return {
    kind,
    tier,
    capacity,
    rate,
    count,
    fullCount,
    lastLoad,
    totalCapacity,
    spareCapacity,
    utilization,
    loads,
    loadsTruncated: count > previewCount,
    omittedCount: count - previewCount,
  };
}

function numberFormatter(locale, maximumFractionDigits = 2) {
  const regular = new Intl.NumberFormat(locale, { maximumFractionDigits });
  const small = new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 });
  return (value) =>
    value > 0 && value < 10 ** -maximumFractionDigits ? small.format(value) : regular.format(value);
}

function russianCount(count, one, few, many) {
  if (count % 100 >= 11 && count % 100 <= 14) return many;
  if (count % 10 === 1) return one;
  return count % 10 >= 2 && count % 10 <= 4 ? few : many;
}

export function transportSummary(plan, { locale = 'ru-RU' } = {}) {
  const format = numberFormatter(locale);
  const ru = locale.toLowerCase().startsWith('ru');
  const unit = plan.kind === 'pipe' ? 'м³/мин' : 'шт/мин';
  const name =
    plan.kind === 'pipe'
      ? ru
        ? russianCount(plan.count, 'труба', 'трубы', 'труб')
        : plan.count === 1
          ? 'pipe'
          : 'pipes'
      : ru
        ? russianCount(plan.count, 'конвейер', 'конвейера', 'конвейеров')
        : plan.count === 1
          ? 'belt'
          : 'belts';
  const localizedUnit = ru ? unit : plan.kind === 'pipe' ? 'm³/min' : 'items/min';
  return `${format(plan.count)} ${name} Mk.${plan.tier} / ${format(plan.capacity)} ${localizedUnit} ${ru ? 'на линию' : 'per lane'}`;
}

export function transportLoadsLabel(plan, { locale = 'ru-RU', maximumFractionDigits = 2 } = {}) {
  const format = numberFormatter(locale, maximumFractionDigits);
  const ru = locale.toLowerCase().startsWith('ru');
  const unit = plan.kind === 'pipe' ? (ru ? 'м³/мин' : 'm³/min') : ru ? 'шт/мин' : 'items/min';
  let values;
  if (plan.count === 0) values = '0';
  else if (plan.count <= 3) values = plan.loads.map(format).join(' + ');
  else {
    values = `${format(plan.fullCount)} × ${format(plan.capacity)}`;
    if (plan.fullCount < plan.count) values += ` + ${format(plan.lastLoad)}`;
  }
  return `${values} ${unit}`;
}
