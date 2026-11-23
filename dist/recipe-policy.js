// Pins select primary production methods; co-products remain available
export const primaryProduct = (recipe) => Object.keys(recipe?.outputs || {})[0];

export function recipePermission(recipe, state) {
  const product = primaryProduct(recipe);
  const pinned = state.recipeOverrides?.[product];
  const selected = pinned === recipe.id;
  const unlocked =
    !recipe.alternate ||
    !Array.isArray(state.unlockedAlternates) ||
    state.unlockedAlternates.includes(recipe.id);
  const manuallyDisabled = (state.disabledRecipes || []).includes(recipe.id);
  const blockedByPin = Boolean(pinned && !selected);
  const seasonalAllowed = !recipe.seasonal || state.seasonal === true;
  const individuallyAllowed = (state.enabledAlternates || []).includes(recipe.id);
  const alternatesAllowed =
    !recipe.alternate || state.alternates === true || selected || individuallyAllowed;
  const individuallyConverted = (state.enabledConversions || []).includes(recipe.id);
  const conversionsAllowed =
    !recipe.conversion || state.resourceConversions === true || selected || individuallyConverted;
  const enabled =
    unlocked &&
    !manuallyDisabled &&
    !blockedByPin &&
    seasonalAllowed &&
    alternatesAllowed &&
    conversionsAllowed;
  const reason = !unlocked
    ? 'Не открыт в загруженном списке'
    : manuallyDisabled
      ? 'Выключен вручную'
      : blockedByPin
        ? 'Для этого продукта выбран другой рецепт'
        : !seasonalAllowed
          ? 'Сезонные рецепты выключены'
          : !alternatesAllowed
            ? 'Альтернативные рецепты выключены'
            : !conversionsAllowed
              ? 'Преобразования ресурсов выключены'
              : selected
                ? 'Выбран вручную'
                : (individuallyAllowed && state.alternates !== true) ||
                    (individuallyConverted && state.resourceConversions !== true)
                  ? 'Разрешён отдельно'
                  : 'Разрешён';
  return {
    product,
    selected,
    unlocked,
    manuallyDisabled,
    blockedByPin,
    alternatesAllowed,
    conversionsAllowed,
    enabled,
    reason,
  };
}

export function effectiveDisabledRecipes(data, state) {
  return data.recipes
    .filter((recipe) => !recipePermission(recipe, state).enabled)
    .map((recipe) => recipe.id);
}

export function chooseAlternateMode(data, state, useAlternates) {
  if (typeof useAlternates !== 'boolean')
    throw new TypeError('Recipe mode must be a boolean choice');
  const next = { ...state, alternates: useAlternates, alternateModeChosen: true };
  if (useAlternates) return next;
  const recipeMap = new Map(data.recipes.map((recipe) => [recipe.id, recipe]));
  next.recipeOverrides = { ...state.recipeOverrides };
  for (const [item, id] of Object.entries(next.recipeOverrides)) {
    const recipe = recipeMap.get(id);
    if (recipe?.alternate || recipe?.conversion) delete next.recipeOverrides[item];
  }
  next.resourceConversions = false;
  next.enabledAlternates = [];
  next.enabledConversions = [];
  return next;
}

// Apply pinned raw conversions through temporary extraction limits; saved limits stay intact
export function pinnedResourceItems(data, state) {
  const raw = new Set(
    (data.resources || [])
      .filter((resource) => resource.type !== 'external')
      .map((resource) => resource.itemId),
  );
  const recipeMap = new Map(data.recipes.map((recipe) => [recipe.id, recipe]));
  return [
    ...new Set(
      Object.entries(state.recipeOverrides || {})
        .filter(([item, id]) => {
          const recipe = recipeMap.get(id);
          return (
            raw.has(item) &&
            recipe?.conversion &&
            primaryProduct(recipe) === item &&
            recipePermission(recipe, state).enabled
          );
        })
        .map(([item]) => item),
    ),
  ];
}

export function chooseRecipe(data, state, itemId, recipeId) {
  const next = {
    ...state,
    recipeOverrides: { ...state.recipeOverrides },
    disabledRecipes: [...(state.disabledRecipes || [])],
  };
  if (!recipeId) {
    delete next.recipeOverrides[itemId];
    return next;
  }
  const recipe = data.recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe || primaryProduct(recipe) !== itemId)
    throw new Error('Рецепт не производит выбранный основной продукт');
  if (!recipePermission(recipe, state).unlocked)
    throw new Error('Сначала отметьте этот рецепт как открытый в каталоге');
  if (recipe.seasonal && !state.seasonal) throw new Error('Сначала разрешите сезонные рецепты');
  next.recipeOverrides[itemId] = recipeId;
  next.disabledRecipes = next.disabledRecipes.filter((id) => id !== recipeId);
  return next;
}

export function setRecipeEnabled(data, state, recipeId, enabled) {
  const recipe = data.recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe) throw new Error('Неизвестный рецепт');
  const disabled = new Set(state.disabledRecipes || []);
  const next = {
    ...state,
    recipeOverrides: { ...state.recipeOverrides },
    enabledAlternates: [...(state.enabledAlternates || [])],
    enabledConversions: [...(state.enabledConversions || [])],
  };
  const product = primaryProduct(recipe);
  if (enabled) {
    // Keep individual permissions separate from global mode and manual bans

    if (recipe.alternate && state.alternates !== true) {
      next.enabledAlternates = [...new Set([...next.enabledAlternates, recipeId])];
    }
    if (recipe.conversion && state.resourceConversions !== true) {
      next.enabledConversions = [...new Set([...next.enabledConversions, recipeId])];
    }
    if (recipe.alternate && Array.isArray(state.unlockedAlternates))
      next.unlockedAlternates = [...new Set([...state.unlockedAlternates, recipeId])];
    if (recipe.seasonal) next.seasonal = true;
    disabled.delete(recipeId);
    // Enabling a competing method releases the existing pin
    if (next.recipeOverrides[product] && next.recipeOverrides[product] !== recipeId)
      delete next.recipeOverrides[product];
  } else {
    disabled.add(recipeId);
    next.enabledAlternates = next.enabledAlternates.filter((id) => id !== recipeId);
    next.enabledConversions = next.enabledConversions.filter((id) => id !== recipeId);
    if (next.recipeOverrides[product] === recipeId) delete next.recipeOverrides[product];
  }
  next.disabledRecipes = [...disabled];
  return next;
}

export function applyUnlockedRecipes(data, state, recipeIds, metadata = {}) {
  const valid = new Set(
    data.recipes.filter((recipe) => recipe.alternate).map((recipe) => recipe.id),
  );
  const unlockedAlternates = [...new Set(recipeIds.filter((id) => valid.has(id)))];
  const unlocked = new Set(unlockedAlternates);
  const recipeMap = new Map(data.recipes.map((recipe) => [recipe.id, recipe]));
  const recipeOverrides = { ...state.recipeOverrides };
  const clearedPins = [];
  for (const [item, id] of Object.entries(recipeOverrides)) {
    if (recipeMap.get(id)?.alternate && !unlocked.has(id)) {
      delete recipeOverrides[item];
      clearedPins.push(id);
    }
  }
  return {
    state: {
      ...state,
      unlockedAlternates,
      recipeOverrides,
      recipeImport: { ...metadata, count: unlockedAlternates.length },
    },
    clearedPins,
  };
}
