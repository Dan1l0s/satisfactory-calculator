import { Inflate, readPropertyTag, hasCompletePropertyTags } from './vendor/save-reader-tools.js';
import { SCHEMATIC_RECIPES } from './data/unlock-schematics.js';

// Save formats 46-60; container layout follows satisfactory-file-parser 4.1.2 and SCIM
// Only RecipeManager and SchematicManager payloads are retained

const MAX_FILE = 64 * 1024 * 1024,
  MAX_BODY = 256 * 1024 * 1024,
  MAX_CHUNK = 2 * 1024 * 1024;
const MAX_STRING = 64 * 1024,
  MAX_REFS = 20000,
  MAX_OBJECTS = 2000000;
const TARGETS = new Map([
  ['/Script/FactoryGame.FGRecipeManager', 'recipes'],
  ['/Script/FactoryGame.FGSchematicManager', 'schematics'],
  [
    '/Game/FactoryGame/Schematics/Progression/BP_SchematicManager.BP_SchematicManager_C',
    'schematics',
  ],
]);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf16 = new TextDecoder('utf-16le', { fatal: true });

function fail(message, code = 'INVALID_SAVE') {
  const e = new Error(message);
  e.name = 'SaveImportError';
  e.code = code;
  throw e;
}
function check(condition, message, code) {
  if (!condition) fail(message, code);
}

class Reader {
  constructor(bytes, context = {}) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.pos = 0;
    this.context = context;
  }
  need(n) {
    check(
      Number.isSafeInteger(n) && n >= 0 && this.pos + n <= this.bytes.length,
      'Сохранение обрезано или содержит некорректную длину данных',
    );
  }
  skip(n) {
    this.need(n);
    this.pos += n;
  }
  readInt8() {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }
  readUint8() {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  readByte() {
    return this.readUint8();
  }
  readUint16() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  readInt32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  readUint32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  uint64() {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    check(
      v <= BigInt(Number.MAX_SAFE_INTEGER),
      'Слишком большая длина данных сохранения',
      'SIZE_LIMIT',
    );
    return Number(v);
  }
  readBytes(n) {
    this.need(n);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  readString() {
    const length = this.readInt32();
    if (length === 0) return '';
    const width = length < 0 ? 2 : 1,
      count = Math.abs(length),
      size = count * width;
    check(count <= MAX_STRING, 'Строка в сохранении превышает безопасный лимит', 'SIZE_LIMIT');
    const bytes = this.readBytes(size);
    check(
      bytes[size - 1] === 0 && (width === 1 || bytes[size - 2] === 0),
      'Некорректное завершение строки в сохранении',
    );
    try {
      return (width === 2 ? utf16 : utf8).decode(bytes.subarray(0, size - width));
    } catch {
      fail('Не удалось прочитать текстовые поля сохранения');
    }
  }
  count(limit, description) {
    const n = this.readInt32();
    check(
      n >= 0 && n <= limit,
      `Некорректное количество ${description} в сохранении`,
      'SIZE_LIMIT',
    );
    return n;
  }
  ref() {
    return { levelName: this.readString(), pathName: this.readString() };
  }
  block() {
    const n = this.uint64();
    check(n <= MAX_BODY, 'Раздел сохранения превышает лимит', 'SIZE_LIMIT');
    return this.readBytes(n);
  }
}

function headerFrom(reader) {
  const headerType = reader.readInt32(),
    saveVersion = reader.readInt32(),
    buildVersion = reader.readInt32();
  check(
    [13, 14].includes(headerType) && saveVersion >= 46 && saveVersion <= 60,
    `Этот формат сохранения пока не поддерживается (заголовок ${headerType}, версия ${saveVersion}). Поддерживаются сохранения Satisfactory 1.0-1.2, форматы 46-60`,
    'UNSUPPORTED_VERSION',
  );
  const saveName = headerType >= 14 ? reader.readString() : '';
  const mapName = reader.readString();
  reader.readString(); // Discard map options
  const sessionName = reader.readString();
  reader.skip(4 + 8 + 1 + 4);
  reader.readString(); // Mod metadata
  const modded = reader.readInt32() !== 0;
  reader.readString();
  reader.skip(4); // Save ID and partition flag
  const hasHash = reader.readInt32();
  check(hasHash === 0 || hasHash === 1, 'Некорректный заголовок контрольной суммы');
  if (hasHash) reader.skip(16);
  const creative = reader.readInt32() !== 0;
  check(
    mapName === 'Persistent_Level',
    'Сохранение использует неподдерживаемую карту',
    'UNSUPPORTED_MAP',
  );
  return {
    headerType,
    saveVersion,
    buildVersion,
    saveName,
    sessionName,
    mapName,
    modded,
    creative,
    end: reader.pos,
  };
}

async function inflateBody(bytes, headerEnd, progress, signal) {
  const reader = new Reader(bytes.subarray(headerEnd)),
    chunks = [];
  let total = 0;
  while (reader.pos < reader.bytes.length) {
    check(chunks.length < 65536, 'В сохранении слишком много сжатых частей', 'SIZE_LIMIT');
    check(reader.readUint32() === 0x9e2a83c1, 'Не найден заголовок сжатой части .sav');
    const version = reader.readUint32();
    check(
      version === 0x22222222 || version === 0,
      'Неизвестный формат сжатия сохранения',
      'UNSUPPORTED_VERSION',
    );
    const maximum = reader.uint64();
    check(
      maximum > 0 && maximum <= MAX_CHUNK,
      'Слишком большая сжатая часть сохранения',
      'SIZE_LIMIT',
    );
    if (version !== 0)
      check(
        reader.readByte() === 3,
        'Поддерживается только zlib-сжатие сохранений',
        'UNSUPPORTED_COMPRESSION',
      );
    const compressed = reader.uint64(),
      uncompressed = reader.uint64(),
      compressedCopy = reader.uint64(),
      uncompressedCopy = reader.uint64();
    check(
      compressed === compressedCopy &&
        uncompressed === uncompressedCopy &&
        compressed > 0 &&
        uncompressed > 0 &&
        uncompressed <= maximum,
      'Некорректная таблица сжатых частей сохранения',
    );
    total += uncompressed;
    check(
      total <= MAX_BODY,
      'Распакованное сохранение превышает лимит локального импорта: 256 МиБ',
      'SIZE_LIMIT',
    );
    chunks.push({ input: reader.readBytes(compressed), length: uncompressed });
  }
  check(chunks.length > 0, 'В сохранении отсутствуют данные');
  const output = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) fail('Импорт отменён', 'ABORTED');
    const chunk = chunks[i];
    let written = 0;
    const inflater = new Inflate({ chunkSize: 32768 });
    inflater.onData = (data) => {
      check(
        written + data.length <= chunk.length,
        'Распакованные данные превышают заявленный размер. Импорт остановлен',
        'SIZE_LIMIT',
      );
      output.set(data, offset + written);
      written += data.length;
    };
    try {
      inflater.push(chunk.input, true);
    } catch (error) {
      if (error.code) throw error;
      fail('Повреждён сжатый блок сохранения');
    }
    check(
      !inflater.err && inflater.ended && written === chunk.length && inflater.strm.avail_in === 0,
      'Не удалось полностью распаковать сохранение: повреждён zlib-блок',
    );
    offset += written;
    progress({
      phase: 'decompress',
      progress: 0.08 + (0.48 * offset) / total,
      message: 'Распаковываем сохранение локально…',
    });
    if (i % 16 === 15) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { output, chunkCount: chunks.length };
}

function versionData(reader) {
  reader.skip(4);
  reader.readInt32();
  const ue5 = reader.readInt32();
  reader.skip(4 + 6 + 4);
  reader.readString();
  reader.skip(reader.count(2048, 'пользовательских версий') * 20);
  return ue5;
}
function skipRefs(reader) {
  const n = reader.count(MAX_OBJECTS, 'ссылок');
  for (let i = 0; i < n; i++) reader.ref();
}
function skipDestroyed(reader) {
  const n = reader.count(200000, 'разделов карты');
  for (let i = 0; i < n; i++) {
    reader.readString();
    skipRefs(reader);
  }
}

function targetObjectHeaders(bytes, levelVersion) {
  const reader = new Reader(bytes),
    count = reader.count(MAX_OBJECTS, 'объектов');
  check(
    count <= Math.floor(bytes.length / 16),
    'Количество объектов не соответствует размеру раздела',
  );
  const targets = new Map();
  for (let i = 0; i < count; i++) {
    const type = reader.readInt32();
    check(type === 0 || type === 1, 'Неизвестный тип объекта в сохранении');
    const classPath = reader.readString();
    reader.readString();
    const instance = reader.readString();
    if (levelVersion >= 49) reader.skip(4);
    if (type === 1) reader.skip(48);
    else reader.readString();
    if (TARGETS.has(classPath)) {
      check(type === 1, 'Неожиданный тип менеджера рецептов');
      targets.set(i, { kind: TARGETS.get(classPath), instance });
    }
  }
  return { count, targets };
}

function readManager(bytes, context, kind) {
  check(bytes.length <= 4 * 1024 * 1024, 'Раздел открытых рецептов слишком велик', 'SIZE_LIMIT');
  const reader = new Reader(bytes, context);
  reader.ref();
  const componentCount = reader.count(MAX_REFS, 'компонентов менеджера');
  for (let i = 0; i < componentCount; i++) reader.ref();
  if (hasCompletePropertyTags(reader))
    check(
      reader.readByte() === 0,
      'Неподдерживаемый режим сериализации менеджера рецептов',
      'UNSUPPORTED_VERSION',
    );
  const expected = kind === 'recipes' ? 'mAvailableRecipes' : 'mPurchasedSchematics';
  let values = null,
    terminated = false;
  for (let i = 0; i < 10000; i++) {
    const tag = readPropertyTag(reader);
    if (tag.propertyName === 'None') {
      terminated = true;
      break;
    }
    reader.need(tag.binarySize);
    const payload = reader.readBytes(tag.binarySize);
    if (tag.propertyName !== expected) continue;
    check(values === null, 'В сохранении дублируется список открытых рецептов');
    check(
      tag.propertyTagType?.name === 'ArrayProperty' &&
        tag.propertyTagType.children?.[0]?.name === 'ObjectProperty',
      'Неизвестный формат списка открытых рецептов',
      'UNSUPPORTED_VERSION',
    );
    const field = new Reader(payload),
      count = field.count(MAX_REFS, 'открытых рецептов');
    check(
      count <= Math.floor(payload.length / 8),
      'Количество рецептов не соответствует длине списка',
    );
    values = [];
    for (let j = 0; j < count; j++) {
      const ref = field.ref();
      check(ref.pathName.length < 2048, 'Некорректный идентификатор рецепта');
      values.push(ref.pathName);
    }
    check(field.pos === payload.length, 'Список открытых рецептов прочитан не полностью');
  }
  check(terminated, 'В сохранении отсутствует конец раздела рецептов');
  return values;
}

function scanPersistentLevel(toc, data, header, ue5) {
  const { count, targets } = targetObjectHeaders(toc, header.saveVersion);
  const reader = new Reader(data);
  check(
    reader.count(MAX_OBJECTS, 'записей объектов') === count,
    'Таблицы объектов сохранения не совпадают',
  );
  const found = {};
  for (let i = 0; i < count; i++) {
    const objectVersion = reader.readInt32();
    reader.skip(4);
    check(
      objectVersion >= 0 && objectVersion <= 60,
      'Объект использует неподдерживаемую версию сохранения',
      'UNSUPPORTED_VERSION',
    );
    const size = reader.count(MAX_BODY, 'байтов объекта'),
      body = reader.readBytes(size);
    let objectUE5 = ue5;
    if (objectVersion >= 53) {
      const hasVersion = reader.readInt32();
      check(hasVersion === 0 || hasVersion === 1, 'Некорректные версии объекта');
      if (hasVersion) objectUE5 = versionData(reader);
    }
    const target = targets.get(i);
    if (!target) continue;
    check(!(target.kind in found), 'В сохранении найдено несколько менеджеров открытых рецептов');
    found[target.kind] = readManager(
      body,
      {
        saveVersion: {
          header: header.saveVersion,
          level: header.saveVersion,
          object: objectVersion,
        },
        packageFileVersionUE5: { header: ue5, level: ue5, object: objectUE5 },
      },
      target.kind,
    );
  }
  check(
    reader.pos === data.length,
    'Раздел глобальных объектов сохранения имеет неизвестный формат',
  );
  return { ...found, objectCount: count };
}

function scanBody(bytes, header, progress) {
  const reader = new Reader(bytes);
  check(
    reader.uint64() === bytes.length - 8,
    'Общий размер распакованного сохранения не совпадает с заголовком',
  );
  let ue5 = 1000;
  if (header.saveVersion >= 53) ue5 = versionData(reader);
  const gridCount = reader.count(1024, 'сеток карты');
  for (let i = 0; i < gridCount; i++) {
    reader.readString();
    reader.skip(8);
    const n = reader.count(200000, 'ячеек карты');
    for (let j = 0; j < n; j++) {
      reader.readString();
      reader.skip(4);
    }
  }
  const levelCount = reader.count(200000, 'уровней карты');
  let result = null;
  for (let i = 0; i <= levelCount; i++) {
    const persistent = i === levelCount;
    if (!persistent) reader.readString();
    const toc = reader.block(),
      data = reader.block();
    if (persistent) {
      result = scanPersistentLevel(toc, data, header, ue5);
      skipDestroyed(reader);
    } else {
      if (header.saveVersion >= 51) reader.skip(4);
      skipRefs(reader);
      if (header.saveVersion >= 53) {
        const hasVersion = reader.readInt32();
        check(hasVersion === 0 || hasVersion === 1, 'Некорректная версия уровня карты');
        if (hasVersion) versionData(reader);
      }
    }
    if (i % 100 === 0 || persistent)
      progress({
        phase: 'read',
        progress: 0.56 + (0.34 * (i + 1)) / (levelCount + 1),
        message: 'Читаем открытые рецепты…',
      });
  }
  if (reader.pos < bytes.length) skipRefs(reader);
  check(
    reader.pos === bytes.length,
    'В конце сохранения обнаружен неизвестный раздел',
    'UNSUPPORTED_VERSION',
  );
  check(
    result && (Array.isArray(result.recipes) || Array.isArray(result.schematics)),
    'В сохранении не найден полный список открытых рецептов. Текущий набор рецептов сохранён',
    'NO_UNLOCK_DATA',
  );
  return { ...result, levelCount: levelCount + 1 };
}

const classId = (path) =>
  typeof path === 'string' ? path.split('.').pop().replace(/["']/g, '') : '';
function mapUnlocks(found, data, header, fileName, bytes, bodyBytes, chunkCount) {
  const known = new Map(data.recipes.map((r) => [r.id, r])),
    ids = new Set(),
    warnings = [];
  const unknown = new Set(),
    available = found.recipes || [],
    purchased = found.schematics || [];
  for (const path of available) {
    const id = classId(path);
    if (!path.startsWith('/Game/FactoryGame/')) {
      if (id.startsWith('Recipe_Alternate_')) unknown.add(id);
      continue;
    }
    if (known.get(id)?.alternate) ids.add(id);
    else if (!known.has(id) && id.startsWith('Recipe_Alternate_')) unknown.add(id);
  }
  let mappedSchematics = 0,
    addedFromSchematics = 0;
  for (const path of purchased) {
    const id = classId(path);
    if (!path.startsWith('/Game/FactoryGame/')) {
      if (id.startsWith('Schematic_Alternate_')) unknown.add(id);
      continue;
    }
    if (Object.hasOwn(SCHEMATIC_RECIPES, id)) {
      const recipes = SCHEMATIC_RECIPES[id];
      if (recipes.length) mappedSchematics++;
      for (const recipeId of recipes)
        if (known.get(recipeId)?.alternate) {
          if (!ids.has(recipeId)) addedFromSchematics++;
          ids.add(recipeId);
        }
    } else if (id.startsWith('Schematic_Alternate_')) unknown.add(id);
  }
  if (unknown.size)
    warnings.push(
      `Не найдены в базе калькулятора ${unknown.size} открытых альтернативных рецептов/исследований. Они не добавлены: ${[...unknown].slice(0, 4).join(', ')}${unknown.size > 4 ? '…' : ''}`,
    );
  check(
    ids.size > 0 || unknown.size === 0,
    'В сохранении есть открытые альтернативы, но ни одна не сопоставилась с базой. Импорт не применён',
    'UNMAPPED_UNLOCKS',
  );
  if (header.modded)
    warnings.push(
      'Сохранение содержит моды. Импортированы только рецепты, присутствующие в базе обычной игры',
    );
  if (!Array.isArray(found.recipes))
    warnings.push(
      'Список доступных рецептов отсутствует; использованы купленные исследования из сохранения',
    );
  else if (addedFromSchematics)
    warnings.push(
      `Дополнительно восстановлены ${addedFromSchematics} рецептов из купленных исследований`,
    );
  if (header.saveVersion > 58)
    warnings.push(
      `Формат сохранения ${header.saveVersion} новее публичного тестового примера (58). Списки открытых рецептов прошли структурную проверку; остальные объекты не импортируются`,
    );
  return {
    recipeIds: [...ids].sort(),
    saveName:
      header.saveName || fileName.replace(/\.sav$/i, '') || header.sessionName || 'Сохранение',
    gameVersion: `${header.saveVersion >= 58 ? '1.2' : header.saveVersion >= 51 ? '1.1' : '1.0'} / build ${header.buildVersion}`,
    source: 'Satisfactory .sav / RecipeManager / SchematicManager',
    warnings,
    stats: {
      saveVersion: header.saveVersion,
      headerVersion: header.headerType,
      buildVersion: header.buildVersion,
      availableRecipeCount: available.length,
      purchasedSchematicCount: purchased.length,
      mappedSchematicCount: mappedSchematics,
      alternateCount: ids.size,
      unknownAlternates: [...unknown].sort(),
      bytes,
      uncompressedBytes: bodyBytes,
      chunkCount,
      objectCount: found.objectCount,
      levelCount: found.levelCount,
      modded: header.modded,
      creative: header.creative,
    },
  };
}

export async function parseSaveRecipes(
  arrayBuffer,
  data,
  { onProgress = () => {}, signal, fileName = '' } = {},
) {
  const progress = (value) => {
    try {
      onProgress(value);
    } catch {
      /* Ignore progress callback failures */
    }
  };
  try {
    check(
      arrayBuffer instanceof ArrayBuffer && arrayBuffer.byteLength >= 64,
      'Выберите полноценный файл сохранения .sav',
    );
    check(arrayBuffer.byteLength <= MAX_FILE, 'Файл превышает лимит 64 МиБ', 'SIZE_LIMIT');
    check(Array.isArray(data?.recipes), 'База рецептов ещё не загружена', 'NO_RECIPE_DATA');
    if (signal?.aborted) fail('Импорт отменён', 'ABORTED');
    progress({ phase: 'header', progress: 0.02, message: 'Проверяем формат сохранения…' });
    const bytes = new Uint8Array(arrayBuffer),
      header = headerFrom(new Reader(bytes));
    const { output, chunkCount } = await inflateBody(bytes, header.end, progress, signal);
    const found = scanBody(output, header, progress);
    const result = mapUnlocks(
      found,
      data,
      header,
      fileName,
      bytes.length,
      output.length,
      chunkCount,
    );
    progress({
      phase: 'complete',
      progress: 1,
      message: `Прочитано альтернативных рецептов: ${result.recipeIds.length}`,
    });
    return result;
  } catch (error) {
    if (error.code) throw error;
    fail(
      'Не удалось прочитать сохранение: файл повреждён или использует неподдерживаемый формат. ' +
        (error.message || ''),
    );
  }
}
