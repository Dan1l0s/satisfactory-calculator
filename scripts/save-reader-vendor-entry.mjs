import { FPropertyTag } from '@etothepii/satisfactory-file-parser/build/parser/satisfactory/types/structs/binary/FPropertyTag.js';
import { FPropertyTagNode } from '@etothepii/satisfactory-file-parser/build/parser/satisfactory/types/structs/binary/FPropertyTagNode.js';
import { Inflate } from 'pako/lib/inflate.js';

// Bound the type tree before the upstream reader allocates from a file count
function boundedTagNode(reader, depth = 0, budget = { count: 0 }) {
  if (depth > 12 || ++budget.count > 128)
    throw new Error('Слишком сложное описание свойства в сохранении');
  const name = reader.readString();
  const count = reader.readInt32();
  if (count < 0 || count > 32) throw new Error('Некорректное число типов свойства в сохранении');
  const children = [];
  for (let i = 0; i < count; i++) children.push(boundedTagNode(reader, depth + 1, budget));
  return { name, children };
}
FPropertyTagNode.read = boundedTagNode;

export const readPropertyTag = (reader) => FPropertyTag.read(reader);
export const hasCompletePropertyTags = (reader) => FPropertyTag.IsCompletePropertyTagType(reader);
export { Inflate };
