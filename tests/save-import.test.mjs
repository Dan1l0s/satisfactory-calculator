import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { parseUnlockedRecipes, SAVE_IMPORT_LIMITS } from '../dist/save-import.js';
import { SCHEMATIC_RECIPES } from '../dist/data/unlock-schematics.js';

const data = JSON.parse(fs.readFileSync(new URL('../dist/data/game-data.json', import.meta.url)));
const recipe = 'Recipe_Alternate_Screw_C',
  other = 'Recipe_Alternate_Screw_2_C';
const gamePath = (id) =>
  '/Game/FactoryGame/Recipes/AlternateRecipes/Parts/' + id.replace(/_C$/, '') + '.' + id;
const schematicPath = (id) =>
  '/Game/FactoryGame/Schematics/Alternate/Parts/' + id.replace(/_C$/, '') + '.' + id;
const i32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const join = (...parts) => Buffer.concat(parts.flat());
const str = (s, wide = false) => {
  const b = Buffer.from(s + '\0', wide ? 'utf16le' : 'utf8');
  return join(i32(wide ? -b.length / 2 : b.length), b);
};
const ref = (path) => join(str(''), str(path));
const versionData = () =>
  join(u32(1), i32(522), i32(1012), i32(0), Buffer.alloc(10), str('fixture'), i32(0));

// Synthetic UE5 container generated without a real save

function fixture({
  version = 58,
  recipes = [gamePath(recipe)],
  schematics = [],
  unknownManager = false,
  modded = false,
  wrongType = false,
  falsePositive = false,
  terminate = true,
  chunkBytes = 131072,
  name = 'Тестовый завод',
} = {}) {
  const headerType = version >= 51 ? 14 : 13,
    modern = version >= 53;
  const header = join(
    i32(headerType),
    i32(version),
    i32(version >= 58 ? 481836 : 365306),
    headerType >= 14 ? str(name, true) : [],
    str('Persistent_Level'),
    str('private-account-options'),
    str('Test session'),
    i32(0),
    u64(0),
    Buffer.from([0]),
    i32(40),
    str('private-mod-metadata'),
    i32(modded ? 1 : 0),
    str('private-save-id'),
    i32(1),
    i32(0),
    i32(0),
  );
  const property = (propertyName, paths) => {
    const payload = join(i32(paths.length), paths.map(ref));
    const type = wrongType ? 'StrProperty' : 'ArrayProperty';
    const tag = modern
      ? join(
          str(propertyName),
          str(type),
          i32(1),
          str('ObjectProperty'),
          i32(0),
          i32(payload.length),
          Buffer.from([0]),
        )
      : join(
          str(propertyName),
          str(type),
          i32(payload.length),
          i32(0),
          str('ObjectProperty'),
          Buffer.from([0]),
        );
    return join(tag, payload);
  };
  const objects = [];
  if (recipes !== null)
    objects.push({
      classPath: unknownManager
        ? '/Game/SomeMod/OtherManager.OtherManager_C'
        : '/Script/FactoryGame.FGRecipeManager',
      properties: [property('mAvailableRecipes', recipes)],
    });
  if (schematics !== null)
    objects.push({
      classPath:
        '/Game/FactoryGame/Schematics/Progression/BP_SchematicManager.BP_SchematicManager_C',
      properties: [
        property('mPurchasedSchematics', schematics),
        property('mAvailableSchematics', [schematicPath('Schematic_Alternate_Screw2_C')]),
      ],
    });
  if (falsePositive)
    objects.push({
      classPath: '/Game/SomeMod/Unrelated.Unrelated_C',
      properties: [property('mAvailableRecipes', [gamePath(other)])],
    });
  const toc = join(
    i32(objects.length),
    objects.map((o, index) =>
      join(
        i32(1),
        str(o.classPath),
        str('Persistent_Level'),
        str('Persistent_Level:PersistentLevel.Manager' + index),
        version >= 49 ? i32(8) : [],
        Buffer.alloc(48),
      ),
    ),
  );
  const contents = join(
    i32(objects.length),
    objects.map((o) => {
      const body = join(
        ref(''),
        i32(0),
        modern ? Buffer.from([0]) : [],
        o.properties,
        terminate ? str('None') : [],
        i32(0),
      );
      return join(i32(version), i32(0), i32(body.length), body, modern ? i32(0) : []);
    }),
  );
  const bodyRest = join(
    modern ? versionData() : [],
    i32(0),
    i32(0),
    u64(toc.length),
    toc,
    u64(contents.length),
    contents,
    i32(0),
    i32(0),
  );
  const body = join(u64(bodyRest.length), bodyRest),
    chunks = [];
  for (let i = 0; i < body.length; i += chunkBytes) {
    const raw = body.subarray(i, i + chunkBytes),
      compressed = deflateSync(raw);
    chunks.push(
      join(
        u32(0x9e2a83c1),
        u32(0x22222222),
        u64(chunkBytes),
        Buffer.from([3]),
        u64(compressed.length),
        u64(raw.length),
        u64(compressed.length),
        u64(raw.length),
        compressed,
      ),
    );
  }
  const bytes = join(header, chunks);
  return { arrayBuffer: new Uint8Array(bytes).buffer, headerLength: header.length, bytes, body };
}

test('imports 1.2 unlocks, preserves UTF-16 name and does not read offered schematics or unrelated objects', async () => {
  const input = fixture({ falsePositive: true, chunkBytes: 256 });
  const before = Buffer.from(input.arrayBuffer),
    progress = [];
  const r = await parseUnlockedRecipes(input.arrayBuffer, data, {
    onProgress: (p) => progress.push(p.progress),
  });
  assert.deepEqual(r.recipeIds, [recipe]);
  assert.equal(r.saveName, 'Тестовый завод');
  assert.equal(r.stats.saveVersion, 58);
  assert.ok(r.stats.chunkCount > 1);
  assert.deepEqual(Buffer.from(input.arrayBuffer), before);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((p, i) => p >= 0 && p <= 1 && (!i || p >= progress[i - 1])));
  assert.doesNotMatch(JSON.stringify(r), /private-account|private-mod-metadata|private-save-id/);
});

for (const version of [46, 51, 53, 58, 60]) {
  test(`reads property-tag variant for save ${version}`, async () => {
    const r = await parseUnlockedRecipes(fixture({ version }).arrayBuffer, data);
    assert.deepEqual(r.recipeIds, [recipe]);
    assert.equal(
      r.warnings.some((x) => x.includes('новее')),
      version > 58,
    );
  });
}

test('uses purchased schematics when available recipes are absent', async () => {
  const r = await parseUnlockedRecipes(
    fixture({ recipes: null, schematics: [schematicPath('Schematic_Alternate_Screw_C')] })
      .arrayBuffer,
    data,
  );
  assert.deepEqual(r.recipeIds, [recipe]);
  assert.equal(r.stats.mappedSchematicCount, 1);
  assert.match(r.warnings.join(' '), /купленные исследования/);
});

test('empty valid unlock list is distinct from missing manager data', async () => {
  const r = await parseUnlockedRecipes(fixture({ recipes: [], schematics: [] }).arrayBuffer, data);
  assert.deepEqual(r.recipeIds, []);
  await assert.rejects(
    parseUnlockedRecipes(fixture({ unknownManager: true, schematics: null }).arrayBuffer, data),
    { code: 'NO_UNLOCK_DATA' },
  );
});

test('unknown alternate or colliding mod class cannot silently close or unlock known recipes', async () => {
  await assert.rejects(
    parseUnlockedRecipes(
      fixture({ recipes: [gamePath('Recipe_Alternate_FromTheFuture_C')] }).arrayBuffer,
      data,
    ),
    { code: 'UNMAPPED_UNLOCKS' },
  );
  await assert.rejects(
    parseUnlockedRecipes(
      fixture({ recipes: ['/Mods/Fake.' + recipe], modded: true }).arrayBuffer,
      data,
    ),
    { code: 'UNMAPPED_UNLOCKS' },
  );
  const r = await parseUnlockedRecipes(
    fixture({
      recipes: [gamePath(recipe), gamePath('Recipe_Alternate_FromTheFuture_C')],
      modded: true,
    }).arrayBuffer,
    data,
  );
  assert.deepEqual(r.recipeIds, [recipe]);
  assert.equal(r.warnings.length, 2);
});

test('rejects truncated or unsupported saves and incomplete property lists', async () => {
  const good = fixture();
  await assert.rejects(parseUnlockedRecipes(good.arrayBuffer.slice(0, -4), data));
  await assert.rejects(parseUnlockedRecipes(fixture({ version: 61 }).arrayBuffer, data), {
    code: 'UNSUPPORTED_VERSION',
  });
  await assert.rejects(parseUnlockedRecipes(fixture({ wrongType: true }).arrayBuffer, data), {
    code: 'UNSUPPORTED_VERSION',
  });
  await assert.rejects(parseUnlockedRecipes(fixture({ terminate: false }).arrayBuffer, data));
});

test('limits compressed input and inflated data before allocating unbounded buffers', async () => {
  await assert.rejects(
    parseUnlockedRecipes(new ArrayBuffer(SAVE_IMPORT_LIMITS.compressedBytes + 1), data),
    { code: 'SIZE_LIMIT' },
  );
  const f = fixture();
  const bomb = Buffer.from(f.bytes);
  bomb.writeBigUInt64LE(8n, f.headerLength + 25);
  bomb.writeBigUInt64LE(8n, f.headerLength + 41);
  await assert.rejects(parseUnlockedRecipes(new Uint8Array(bomb).buffer, data), {
    code: 'SIZE_LIMIT',
  });
  const chunks = [];
  for (let i = 0; i < 129; i++)
    chunks.push(
      join(
        u32(0x9e2a83c1),
        u32(0x22222222),
        u64(2 * 1024 * 1024),
        Buffer.from([3]),
        u64(1),
        u64(2 * 1024 * 1024),
        u64(1),
        u64(2 * 1024 * 1024),
        Buffer.from([0]),
      ),
    );
  const excessive = join(f.bytes.subarray(0, f.headerLength), chunks);
  await assert.rejects(parseUnlockedRecipes(new Uint8Array(excessive).buffer, data), {
    code: 'SIZE_LIMIT',
  });
});

test('corrupt zlib payload is rejected', async () => {
  const f = fixture();
  f.bytes[f.bytes.length - 1] ^= 0xff;
  await assert.rejects(parseUnlockedRecipes(new Uint8Array(f.bytes).buffer, data), /zlib/);
});

test('all current hard-drive alternates have a Docs schematic mapping', () => {
  const mapped = new Set(Object.values(SCHEMATIC_RECIPES).flat());
  assert.deepEqual(
    data.recipes.filter((r) => r.alternate && !mapped.has(r.id)).map((r) => r.id),
    [],
  );
  assert.deepEqual(SCHEMATIC_RECIPES.Schematic_Alternate_EnrichedCoal_C, []);
});

test('supports cancellation without changing input', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    parseUnlockedRecipes(fixture().arrayBuffer, data, { signal: controller.signal }),
    { code: 'ABORTED' },
  );
});

test('worker entry returns only the compact result and progress messages', async () => {
  const entry = new URL('../dist/save-import-worker.js', import.meta.url).href;
  const worker = new Worker(
    `const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:m=>parentPort.postMessage(m)};import(${JSON.stringify(entry)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`,
    { eval: true },
  );
  const output = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('worker timeout'));
    }, 5000);
    worker.on('error', reject);
    worker.on('message', (m) => {
      if (m.type === 'error') {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(m.message));
      }
      if (m.type === 'result') {
        clearTimeout(timer);
        worker.terminate();
        resolve(m.value);
      }
    });
    worker.postMessage({ type: 'parse', arrayBuffer: fixture().arrayBuffer, data });
  });
  assert.deepEqual(output.recipeIds, [recipe]);
  assert.ok(JSON.stringify(output).length < 2000);
});

// Optional real saves are supplied through FACTORY_LENS_SAVE_FIXTURES
const fixtureRoot = process.env.FACTORY_LENS_SAVE_FIXTURES;
for (const [name, count, version] of [
  ['Release-001.sav', 0, 46],
  ['Unlock-1.1.sav', 106, 51],
  ['Another-1-2.sav', 63, 58],
]) {
  const filePath = fixtureRoot ? resolve(fixtureRoot, name) : null;
  test(
    `optional save fixture: ${name}`,
    { skip: !filePath || !fs.existsSync(filePath) },
    async () => {
      const r = await parseUnlockedRecipes(new Uint8Array(fs.readFileSync(filePath)).buffer, data);
      assert.equal(r.recipeIds.length, count);
      assert.equal(r.stats.saveVersion, version);
      assert.equal(r.warnings.length, 0);
      assert.ok(r.stats.availableRecipeCount > 0 && r.stats.purchasedSchematicCount > 0);
    },
  );
}
