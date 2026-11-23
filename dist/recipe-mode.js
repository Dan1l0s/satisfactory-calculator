// Legacy local alternates=true was a default, so it requires a new choice
export function normalizeRecipeMode(raw, { source = 'localStorage' } = {}) {
  if (!['localStorage', 'local', 'json', 'hash'].includes(source)) {
    throw new RangeError(`Unknown recipe-mode source: ${String(source)}`);
  }
  const pending = () => ({ alternates: false, alternateModeChosen: false });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return pending();
  const hasMode = typeof raw.alternates === 'boolean';
  if (Object.hasOwn(raw, 'alternateModeChosen')) {
    return raw.alternateModeChosen === true && hasMode
      ? { alternates: raw.alternates, alternateModeChosen: true }
      : pending();
  }
  if (hasMode && (source === 'json' || source === 'hash' || raw.alternates === false)) {
    return { alternates: raw.alternates, alternateModeChosen: true };
  }
  return pending();
}
