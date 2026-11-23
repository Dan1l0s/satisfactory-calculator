export const SAVE_IMPORT_LIMITS = Object.freeze({
  compressedBytes: 64 * 1024 * 1024,
  uncompressedBytes: 256 * 1024 * 1024,
  timeoutMs: 90_000,
});

export class SaveImportError extends Error {
  constructor(message, code = 'INVALID_SAVE') {
    super(message);
    this.name = 'SaveImportError';
    this.code = code;
  }
}

// Preserve the caller's ArrayBuffer; only recipe IDs and metadata return from the worker
export async function parseUnlockedRecipes(
  arrayBuffer,
  data,
  { onProgress = () => {}, signal, fileName = '' } = {},
) {
  if (!(arrayBuffer instanceof ArrayBuffer))
    throw new SaveImportError('Выберите файл сохранения Satisfactory (.sav)');
  if (arrayBuffer.byteLength < 64)
    throw new SaveImportError('Файл слишком короткий для сохранения Satisfactory');
  if (arrayBuffer.byteLength > SAVE_IMPORT_LIMITS.compressedBytes)
    throw new SaveImportError('Файл превышает лимит локального импорта: 64 МиБ', 'SIZE_LIMIT');
  if (!Array.isArray(data?.recipes))
    throw new SaveImportError('База рецептов ещё не загружена', 'NO_RECIPE_DATA');
  if (signal?.aborted) throw new SaveImportError('Импорт отменён', 'ABORTED');
  const recipeData = {
    recipes: data.recipes.map(({ id, alternate }) => ({ id, alternate: !!alternate })),
  };

  if (typeof Worker === 'undefined') {
    if (typeof document !== 'undefined')
      throw new SaveImportError('Браузер не поддерживает фоновый импорт сохранений', 'NO_WORKER');
    const { parseSaveRecipes } = await import('./save-import-core.js');
    return parseSaveRecipes(arrayBuffer, recipeData, { onProgress, signal, fileName });
  }
  return new Promise((resolve, reject) => {
    let worker,
      timer,
      finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker?.terminate();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new SaveImportError('Импорт отменён', 'ABORTED'));
    try {
      worker = new Worker(new URL('./save-import-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data: message }) => {
        if (message.type === 'progress') {
          try {
            onProgress(message.value);
          } catch {
            /* Ignore progress callback failures */
          }
        }
        if (message.type === 'result') finish(null, message.value);
        if (message.type === 'error') finish(new SaveImportError(message.message, message.code));
      };
      worker.onerror = () =>
        finish(
          new SaveImportError(
            'Не удалось запустить чтение сохранения. Перезагрузите страницу и попробуйте снова',
            'WORKER_ERROR',
          ),
        );
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(
        () =>
          finish(
            new SaveImportError(
              'Чтение сохранения заняло больше 90 секунд. Импорт остановлен; текущий план не изменён',
              'TIMEOUT',
            ),
          ),
        SAVE_IMPORT_LIMITS.timeoutMs,
      );
      worker.postMessage({ type: 'parse', arrayBuffer, data: recipeData, fileName });
    } catch (error) {
      finish(
        new SaveImportError(
          'Не удалось открыть сохранение в фоновом потоке: ' + error.message,
          'WORKER_ERROR',
        ),
      );
    }
  });
}
