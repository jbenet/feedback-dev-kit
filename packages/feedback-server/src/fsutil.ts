/**
 * Crash-safe file writes. Node's fs only: nothing here waits on a database, a lock server or a
 * network, so the request path that uses it answers in milliseconds even when everything else is busy.
 */
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** The folder's own entry, synced, so a rename or link inside it survives a power cut. Best effort. */
export async function syncDir(dir: string): Promise<void> {
  try {
    const d = await open(dir, 'r');
    try { await d.sync(); } finally { await d.close(); }
  } catch { /* Not every platform lets a folder be opened for fsync; the file itself is complete either way. */ }
}

/** A temporary beside `name`: dot-prefixed and `.tmp`, so no reader ever takes it for the real thing. */
export const tempName = (name: string) => `.${name}.${randomBytes(6).toString('hex')}.tmp`;

async function writeTemp(dir: string, name: string, data: string | Uint8Array): Promise<string> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, tempName(name));
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  return tmp;
}

/**
 * Write `name` in `dir` so that it is either absent, the old version, or complete — never half —
 * and on disk when this returns: temporary file, fsync, rename, fsync of the folder. Replaces.
 */
export async function writeAtomic(dir: string, name: string, data: string | Uint8Array): Promise<void> {
  const tmp = await writeTemp(dir, name, data);
  try {
    await rename(tmp, join(dir, name));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await syncDir(dir);
}

/**
 * Like writeAtomic, but the first writer wins: the temporary is hard-linked into place, which fails
 * with EEXIST when the name is taken, so two processes writing one name at once leave the first
 * one's bytes, whole. Returns false when the name already existed. Where hard links are not
 * supported (some network and FUSE filesystems) it falls back to an exclusive-create check and rename.
 */
export async function createAtomic(dir: string, name: string, data: string | Uint8Array): Promise<boolean> {
  const tmp = await writeTemp(dir, name, data);
  const target = join(dir, name);
  try {
    try {
      await link(tmp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS') throw err;
      if (await exists(target)) return false;
      await rename(tmp, target);
    }
    await syncDir(dir);
    return true;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    const fh = await open(path, 'r');
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

/** A JSON file, or null when it is absent or unreadable. */
export async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}
