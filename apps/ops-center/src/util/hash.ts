/** 文件与字符串哈希（sha256），以及 tar 流的 sha256（边打包边算，避免二次读盘）。 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
