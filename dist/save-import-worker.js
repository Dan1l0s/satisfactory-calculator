import { parseSaveRecipes } from './save-import-core.js';

self.onmessage = async ({ data: message }) => {
  if (message?.type !== 'parse') return;
  try {
    const value = await parseSaveRecipes(message.arrayBuffer, message.data, {
      fileName: message.fileName,
      onProgress: (progress) => self.postMessage({ type: 'progress', value: progress }),
    });
    self.postMessage({ type: 'result', value });
  } catch (error) {
    self.postMessage({
      type: 'error',
      code: error.code || 'INVALID_SAVE',
      message: error.message || 'Не удалось прочитать сохранение',
    });
  }
};
