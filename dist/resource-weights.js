export const RESOURCE_WEIGHT_METADATA = Object.freeze({
  source: 'SatisfactoryTools version API / worldData.nodes + worldData.limits',
  sourceUrl:
    'https://api.new.satisfactorytools.com/v1/versions/6edbf6cc-b460-4b5b-aab7-942f842e75a9',
  dataUrl: 'https://api.new.satisfactorytools.com/data/versions/stable-26281294.json',
  sourceDocumentationUrl: 'https://github.com/SatisfactoryTools/ToolsApi',
  gameVersion: '1.2.5.0',
  buildId: '26281294',
  worldAssetVersion: '++FactoryGame+rel-main-1.2.0-CL-491125',
  verifiedAt: '2026-11-23',
  sourceSha256: '9ec85b0a630e8c6e5315c3349e11998813c572a36002ffcccd36993621f2aa67',
  worldSettings: Object.freeze({ seed: 0, mode: 'none', purity: 'no-change' }),
  referenceItemId: 'Desc_OreIron_C',
  referenceMaxRate: 92100,
  formula: 'weight = referenceMaxRate / maxRate; water = 0',
  assumptions:
    'Default map; Miner Mk.3 at 250%, Mk.6 belts; fluid extraction at 250%. Oil includes nodes and resource wells. Values are extraction ceilings before conversion',
  scope:
    'Global availability on the default map. Distance to the current factory, randomized resources, logistics and local access are not modeled by these weights',
  waterNote:
    'The API lists 13,125 m³/min from resource wells. Surface-water extractors are not limited by those well counts, so water has no finite cap in this profile',
});

const counts = (impure, normal, pure) => Object.freeze({ impure, normal, pure });
const source = RESOURCE_WEIGHT_METADATA.sourceUrl;
const rows = [
  {
    itemId: 'Desc_OreIron_C',
    name: 'Iron Ore',
    nameRu: 'Железная руда',
    maxRate: 92100,
    nodes: counts(39, 42, 46),
  },
  {
    itemId: 'Desc_Stone_C',
    name: 'Limestone',
    nameRu: 'Известняк',
    maxRate: 69300,
    nodes: counts(15, 50, 29),
  },
  {
    itemId: 'Desc_Coal_C',
    name: 'Coal',
    nameRu: 'Уголь',
    maxRate: 42300,
    nodes: counts(15, 31, 16),
  },
  {
    itemId: 'Desc_OreCopper_C',
    name: 'Copper Ore',
    nameRu: 'Медная руда',
    maxRate: 36900,
    nodes: counts(13, 29, 13),
  },
  {
    itemId: 'Desc_OreGold_C',
    name: 'Caterium Ore',
    nameRu: 'Катериевая руда',
    maxRate: 15000,
    nodes: counts(0, 9, 8),
  },
  {
    itemId: 'Desc_RawQuartz_C',
    name: 'Raw Quartz',
    nameRu: 'Необработанный кварц',
    maxRate: 13500,
    nodes: counts(3, 7, 7),
  },
  {
    itemId: 'Desc_LiquidOil_C',
    name: 'Crude Oil',
    nameRu: 'Сырая нефть',
    maxRate: 12600,
    nodes: counts(10, 12, 8),
    wellSatellites: counts(8, 6, 4),
    nodeMaxRate: 9900,
    wellMaxRate: 2700,
    form: 'liquid',
  },
  {
    itemId: 'Desc_OreBauxite_C',
    name: 'Bauxite',
    nameRu: 'Боксит',
    maxRate: 12300,
    nodes: counts(5, 6, 6),
  },
  {
    itemId: 'Desc_NitrogenGas_C',
    name: 'Nitrogen Gas',
    nameRu: 'Азот',
    maxRate: 12000,
    wellSatellites: counts(2, 7, 36),
    wellMaxRate: 12000,
    form: 'gas',
  },
  {
    itemId: 'Desc_Sulfur_C',
    name: 'Sulfur',
    nameRu: 'Сера',
    maxRate: 10800,
    nodes: counts(6, 5, 5),
  },
  { itemId: 'Desc_SAM_C', name: 'SAM', nameRu: 'SAM', maxRate: 10200, nodes: counts(10, 6, 3) },
  {
    itemId: 'Desc_OreUranium_C',
    name: 'Uranium',
    nameRu: 'Уран',
    maxRate: 2100,
    nodes: counts(3, 2, 0),
  },
  {
    itemId: 'Desc_Water_C',
    name: 'Water',
    nameRu: 'Вода',
    maxRate: null,
    unbounded: true,
    wellSatellites: counts(7, 12, 36),
    wellMaxRate: 13125,
    form: 'liquid',
  },
];

// Water uses maxRate:null for unbounded surface extraction
export const RESOURCE_AVAILABILITY = Object.freeze(
  Object.fromEntries(
    rows.map((row) => [
      row.itemId,
      Object.freeze({
        form: 'solid',
        unbounded: false,
        ...row,
        unit: row.form && row.form !== 'solid' ? 'm³/min' : 'items/min',
        sourceUrl: source,
        scarceWeight: row.unbounded ? 0 : RESOURCE_WEIGHT_METADATA.referenceMaxRate / row.maxRate,
      }),
    ]),
  ),
);

export const RESOURCE_WEIGHT_PROFILES = Object.freeze([
  Object.freeze({
    id: 'scarce',
    label: 'С учётом редкости',
    nameEn: 'Global scarcity',
    description:
      'Железо = 1. Остальное сырьё взвешивается обратно его максимальной добыче на обычной карте. Вода = 0',
  }),
  Object.freeze({
    id: 'equal',
    label: 'Равные веса',
    nameEn: 'Equal weights',
    description: 'Каждая единица сырья имеет вес 1, вода: 0',
  }),
]);

function normalizedOptions({ profile = 'scarce', overrides = {} } = {}) {
  if (!RESOURCE_WEIGHT_PROFILES.some((value) => value.id === profile))
    throw new RangeError(`Unknown resource weight profile: ${String(profile)}`);
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides))
    throw new TypeError('Resource weight overrides must be an object keyed by item ID');
  return { profile, overrides };
}
function itemIdOf(resource) {
  const itemId =
    typeof resource === 'string' ? resource : resource?.itemId || resource?.item || resource?.id;
  if (typeof itemId !== 'string' || !itemId) throw new TypeError('A resource must have an item ID');
  return itemId;
}

// Manual overrides include zero; unknown resources use neutral weight 1
export function getResourceWeightDetails(resource, options = {}) {
  const itemId = itemIdOf(resource),
    { profile, overrides } = normalizedOptions(options);
  const availability = Object.hasOwn(RESOURCE_AVAILABILITY, itemId)
    ? RESOURCE_AVAILABILITY[itemId]
    : null;
  let weight, origin;
  if (Object.hasOwn(overrides, itemId) && overrides[itemId] != null && overrides[itemId] !== '') {
    const value = overrides[itemId];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new RangeError(
        `Invalid resource weight for ${itemId}: a finite non-negative number is required`,
      );
    weight = value;
    origin = 'manual';
  } else if (itemId === 'Desc_Water_C') {
    weight = 0;
    origin = 'unbounded';
  } else if (profile === 'equal') {
    weight = 1;
    origin = 'equal';
  } else if (availability) {
    weight = availability.scarceWeight;
    origin = 'scarcity';
  } else {
    weight = 1;
    origin = 'fallback';
  }
  return {
    itemId,
    weight,
    profile,
    origin,
    availability,
    maxRate: availability?.maxRate ?? null,
    knownAvailability: !!availability,
  };
}

export function getResourceWeights(resources = Object.keys(RESOURCE_AVAILABILITY), options = {}) {
  if (!Array.isArray(resources)) throw new TypeError('Resources must be an array');
  normalizedOptions(options);
  return Object.fromEntries(
    resources.map((resource) => {
      const { itemId, weight } = getResourceWeightDetails(resource, options);
      return [itemId, weight];
    }),
  );
}

export function getResourceWeight(resource, options = {}) {
  return getResourceWeightDetails(resource, options).weight;
}
