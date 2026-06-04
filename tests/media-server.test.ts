import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveServedFilePath } from '../electron/tapo/mediaServer';

const baseDir = path.join(os.tmpdir(), 'guard-base');

describe('resolveServedFilePath', () => {
  it('resolves a valid nested file inside the base dir', () => {
    expect(resolveServedFilePath(baseDir, 'cam/stream.m3u8')).toBe(path.join(baseDir, 'cam', 'stream.m3u8'));
  });

  it('resolves a valid file directly under the base dir', () => {
    expect(resolveServedFilePath(baseDir, 'stream.mp4')).toBe(path.join(baseDir, 'stream.mp4'));
  });

  it('rejects parent-traversal attempts', () => {
    expect(resolveServedFilePath(baseDir, '../secret')).toBeNull();
    expect(resolveServedFilePath(baseDir, 'cam/../../secret')).toBeNull();
  });

  it('rejects a sibling directory sharing a name prefix with the base dir', () => {
    // The old `startsWith(baseDir)` check would have allowed `<base>-evil`.
    expect(resolveServedFilePath(baseDir, '../guard-base-evil/x')).toBeNull();
  });

  it('rejects an absolute path that escapes the base dir', () => {
    expect(resolveServedFilePath(baseDir, path.join(os.tmpdir(), 'elsewhere', 'x'))).toBeNull();
  });

  it('rejects a request for the base directory itself', () => {
    expect(resolveServedFilePath(baseDir, '')).toBeNull();
  });
});
