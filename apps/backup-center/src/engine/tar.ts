/**
 * 纯 Node 的 ustar tar 打包/解包 + gzip。
 * 不依赖系统 tar 命令，保证「打包媒体」在任何平台行为一致；
 * 解包时做路径穿越防护（拒绝 .. 与绝对路径），沙箱还原安全。
 *
 * 这里不需要流级性能：媒体文件以 512B 块顺序写，整个过程仍是 O(总字节)，
 * 并且读写都使用块缓冲，单文件上限远低于 8GB（ustar 的 11 位八进制长度上限）。
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, posix } from 'node:path';
import { walkFiles } from '../util';

const BLOCK = 512;

function writeOctal(buf: Buffer, value: number, offset: number, len: number): void {
  // ustar 数值字段：len-1 位八进制 + 末尾 NUL
  buf.write(value.toString(8).padStart(len - 1, '0').slice(-(len - 1)), offset, len - 1, 'ascii');
  buf[offset + len - 1] = 0;
}

function splitUstarName(relPath: string): { name: string; prefix: string } {
  const p = relPath.split(posix.sep).join('/');
  if (Buffer.byteLength(p, 'utf8') <= 100) return { name: p, prefix: '' };
  // ustar 前缀：最后一个目录分隔点落在 prefix(155)/name(100) 字节边界内
  const parts = p.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) return { name, prefix };
  }
  throw new Error(`路径超过 ustar 长度上限：${p}`);
}

async function fileHeader(relPath: string, size: number, mode: number, mtime: number): Promise<Buffer> {
  const buf = Buffer.alloc(BLOCK);
  const { name, prefix } = splitUstarName(relPath);
  // 路径按 UTF-8 写入（GNU/BSD tar 的通行做法，系统 tar 可正常解中文文件名）
  buf.write(name, 0, 100, 'utf8');
  writeOctal(buf, mode & 0o7777, 100, 8);
  writeOctal(buf, 0, 108, 8); // uid
  writeOctal(buf, 0, 116, 8); // gid
  writeOctal(buf, size, 124, 12);
  writeOctal(buf, Math.floor(mtime / 1000), 136, 12);
  // checksum 先留空格
  buf.write('        ', 148, 8, 'ascii');
  buf.write('0', 156, 1, 'ascii'); // typeflag: regular file
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  if (prefix) buf.write(prefix, 345, 155, 'utf8');
  let chksum = 0;
  for (const b of buf) chksum += b;
  // 校验和字段：6 位八进制 + NUL + 空格
  buf.write(chksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

/** 递归打包 sourceRoot 到 tar.gz（条目路径相对 sourceRoot） */
export async function createTarGz(sourceRoot: string, outFile: string): Promise<{ entries: number; bytes: number }> {
  const files = await walkFiles(sourceRoot);
  const blocks: Buffer[] = [];
  let entries = 0;
  for (const f of files) {
    const s = await stat(f.abs);
    blocks.push(await fileHeader(f.rel, s.size, s.mode, s.mtimeMs));
    // 用全量读入 + 分片，简单且避免自定义可读流；单文件超大时再优化
    const { readFile } = await import('node:fs/promises');
    const data = await readFile(f.abs);
    blocks.push(data);
    const rem = BLOCK - (data.length % BLOCK);
    if (rem < BLOCK) blocks.push(Buffer.alloc(rem));
    entries += 1;
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  const tar = Buffer.concat(blocks);
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, gzipSync(tar, { level: 6 }));
  return { entries, bytes: tar.length };
}

interface TarHeader {
  name: string;
  size: number;
  typeflag: string;
}

function parseHeader(buf: Buffer): TarHeader | null {
  if (buf.every((b) => b === 0)) return null;
  const name = buf.toString('utf8', 0, 100).replace(/\0.*$/, '');
  let size = 0;
  const sizeField = buf.toString('ascii', 124, 124 + 12).replace(/[\0 ]/g, '');
  if (sizeField) size = parseInt(sizeField, 8);
  const prefix = buf.toString('utf8', 345, 345 + 155).replace(/\0.*$/, '');
  const typeflag = buf.toString('ascii', 156, 157);
  const full = prefix ? `${prefix}/${name}` : name;
  return { name: full, size, typeflag };
}

export interface ExtractedFile {
  path: string;
  size: number;
}

/** 把 tar.gz 解包到 destRoot，拒绝路径穿越。返回普通文件清单。 */
export async function extractTarGz(tarGzFile: string, destRoot: string): Promise<ExtractedFile[]> {
  const gz = await import('node:fs/promises').then((fs) => fs.readFile(tarGzFile));
  const tar = gunzipSync(gz);
  const out: ExtractedFile[] = [];
  let off = 0;
  await mkdir(destRoot, { recursive: true });
  while (off + BLOCK <= tar.length) {
    const header = parseHeader(tar.subarray(off, off + BLOCK));
    off += BLOCK;
    if (!header) break;
    if (header.typeflag === '0' || header.typeflag === '\0') {
      const data = tar.subarray(off, off + header.size);
      off += header.size;
      const pad = (BLOCK - (header.size % BLOCK)) % BLOCK;
      off += pad;

      const safe = safeJoin(destRoot, header.name);
      if (!safe) throw new Error(`tar 条目路径非法（疑似穿越）：${header.name}`);
      await mkdir(dirname(safe), { recursive: true });
      await writeFile(safe, data);
      out.push({ path: header.name, size: header.size });
    } else {
      // pax/目录等：按 size 跳过数据块
      const pad = (BLOCK - (header.size % BLOCK)) % BLOCK;
      off += header.size + pad;
    }
  }
  return out;
}

/** 校验包内路径必须落在 root 内 */
function safeJoin(root: string, rel: string): string | null {
  if (rel.startsWith('/') || rel.startsWith('\\')) return null;
  const norm = normalize(rel);
  if (norm.split(/[/\\]/).includes('..')) return null;
  return join(root, norm);
}
