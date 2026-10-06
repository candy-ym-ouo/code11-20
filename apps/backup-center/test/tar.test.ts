import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTarGz, extractTarGz } from '../src/engine/tar';
import { sha256File } from '../src/util';

let roots: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'bctr-tar-'));
  roots.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(roots.map((d) => rm(d, { recursive: true, force: true })));
  roots = [];
});

describe('tar.gz 打包/解包', () => {
  it('保留目录结构、内容与空目录以外的文件', async () => {
    const root = await tmp();
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', '1.txt'), 'hello');
    await writeFile(join(root, 'a', 'b', '2.bin'), Buffer.from([0, 1, 2, 255]));
    const archive = join(root, 'out.tar.gz');
    const packed = await createTarGz(root, archive);
    expect(packed.entries).toBe(2);

    const dest = join(root, 'restored');
    const files = await extractTarGz(archive, dest);
    expect(files.map((f) => f.path).sort()).toEqual(['a/1.txt', 'a/b/2.bin']);
    const h1 = await sha256File(join(dest, 'a', '1.txt'));
    expect(h1).toBe(await sha256File(join(root, 'a', '1.txt')));
  });

  it('中文与深层路径往返一致', async () => {
    const root = await tmp();
    const name = join('家庭相册', '2026 国庆', '照片 01.jpg');
    await mkdir(join(root, join(name, '..')), { recursive: true });
    const body = Buffer.alloc(2000, 'x');
    await writeFile(join(root, name), body);
    const archive = join(root, 'o.tar.gz');
    await createTarGz(root, archive);
    const dest = join(root, 'r');
    await extractTarGz(archive, dest);
    expect(await sha256File(join(dest, name))).toBe(await sha256File(join(root, name)));
  });

  it('拒绝路径穿越条目', async () => {
    const root = await tmp();
    // 手工构造一个带 ../ 的 tar 头
    const { createGzip } = await import('node:zlib');
    const { writeFileSync } = await import('node:fs');
    const header = Buffer.alloc(512);
    header.write('../evil.txt', 0, 100, 'ascii');
    header.write('0000000', 100, 7, 'ascii');
    header.write('0000000', 108, 7, 'ascii');
    header.write('00000000001', 124, 11, 'ascii'); // size=1
    header.write('00000000000', 136, 11, 'ascii');
    header.write('        ', 148, 8, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    const data = Buffer.concat([header, Buffer.from('x'), Buffer.alloc(512), Buffer.alloc(1024)]);
    const gz = createGzip();
    const out: Buffer[] = [];
    const done = new Promise<void>((res) => gz.on('end', () => res()));
    gz.on('data', (c) => out.push(c as Buffer));
    gz.end(data);
    await done;
    const bad = join(root, 'bad.tar.gz');
    writeFileSync(bad, Buffer.concat(out));
    await expect(extractTarGz(bad, join(root, 'dest'))).rejects.toThrow(/穿越/);
  });
});
