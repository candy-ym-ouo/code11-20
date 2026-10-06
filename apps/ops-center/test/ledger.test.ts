import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ledger } from '../src/storage/ledger.js';

function freshLedger() {
  const dir = mkdirSync(path.join(tmpdir(), `ops-ledger-${Date.now()}-${Math.random()}`), {
    recursive: true,
  });
  return { dir, file: path.join(dir, 'ledger.ndjson') };
}

test('账本：追加事件并聚合成 Run', () => {
  const { file } = freshLedger();
  const l = new Ledger(file);
  const run = l.append('run-a', 'backup', 'run_started', { trigger: 'manual' });
  l.append('run-a', 'backup', 'check', { name: 'c1', ok: true, detail: 'ok' });
  l.append('run-a', 'backup', 'run_finished', { status: 'success' });

  const runs = l.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, 'success');
  assert.equal(runs[0]!.checks.length, 1);
  assert.equal(run.hash.length, 64);
});

test('账本：哈希链顺序写入，audit 干净', () => {
  const { file } = freshLedger();
  const l = new Ledger(file);
  for (let i = 0; i < 5; i += 1) {
    l.append('r', 'verify', 'log', { line: `n${i}` });
  }
  assert.deepEqual(l.integrity(), { ok: true, corrupted: [] });
});

test('账本：篡改任意一行都会被检出', () => {
  const { file } = freshLedger();
  const l = new Ledger(file);
  l.append('r', 'drill', 'log', { line: 'original' });
  l.append('r', 'drill', 'log', { line: 'second' });

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const obj = JSON.parse(lines[0]!) as Record<string, unknown>;
  obj.payload = { line: 'tampered' };
  lines[0] = JSON.stringify(obj);
  writeFileSync(file, `${lines.join('\n')}\n`);

  const result = new Ledger(file).integrity();
  assert.equal(result.ok, false);
  assert.ok(result.corrupted.some((c) => c.line === 1 && /哈希/.test(c.reason)));
});

test('账本：删除一行会导致哈希链断裂', () => {
  const { file } = freshLedger();
  const l = new Ledger(file);
  for (let i = 0; i < 4; i += 1) l.append('r', 'backup', 'log', { i });
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  lines.splice(1, 1);
  writeFileSync(file, `${lines.join('\n')}\n`);
  const result = new Ledger(file).integrity();
  assert.equal(result.ok, false);
  assert.ok(result.corrupted.some((c) => /链/.test(c.reason)));
  rmSync(path.dirname(file), { recursive: true, force: true });
});
