/**
 * Unsent feedback, kept in this browser through reloads. A draft is named by the page it was
 * started on. Its words — text, kind, priority — go to localStorage, one key per draft,
 * `<prefix>.feedback.draft:<page>`. Its pictures — the screenshots, drawn on or not, and any image
 * dropped into the text — go to IndexedDB under the same page, because two or three of them are more
 * than localStorage holds. Nothing here leaves the browser until the report is filed.
 *
 * Client only. Every read and write is allowed to fail — a private window, storage turned off — and
 * a failure means the draft is not kept, never that the box breaks.
 */
import { firstLine } from './journal';

let prefix = 'feedbackkit';
/** The storage names' prefix. The FeedbackButton sets it from its provider. */
export const configureDrafts = (p: string) => { prefix = p; };
const draftKey = () => `${prefix}.feedback.draft:`;

export interface DraftWords {
  body: string;
  kind?: string;
  priority?: string;
  /** When it was last saved. */
  at?: string;
  /** How many pictures were kept with it, in IndexedDB. */
  pictures?: number;
}

export interface DraftSummary {
  page: string;
  /** Its first line of words: drafts have no title, the server writes one when it is filed. */
  title: string;
  at: string | null;
  pictures: number;
}

export interface DraftPictures<Shot, Image> {
  shots: Shot[];
  images: Image[];
}

export function readDraft(page: string): DraftWords | null {
  try {
    const raw = window.localStorage.getItem(draftKey() + page);
    if (!raw) return null;
    const d = JSON.parse(raw) as DraftWords;
    return typeof d === 'object' && d ? { body: d.body ?? '', kind: d.kind, priority: d.priority, at: d.at, pictures: d.pictures ?? 0 } : null;
  } catch { return null; }
}

export function writeDraft(page: string, words: DraftWords | null): void {
  try {
    if (words) window.localStorage.setItem(draftKey() + page, JSON.stringify(words));
    else window.localStorage.removeItem(draftKey() + page);
  } catch { /* not kept */ }
}

/** Every draft in this browser, the latest first. */
export function listDrafts(): DraftSummary[] {
  const out: DraftSummary[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(draftKey())) continue;
      const page = key.slice(draftKey().length);
      const d = readDraft(page);
      if (!d) continue;
      out.push({ page, title: firstLine(d.body) || 'No words yet', at: d.at ?? null, pictures: d.pictures ?? 0 });
    }
  } catch { /* nothing to list */ }
  return out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

const STORE = 'pictures';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(`${prefix}-feedback`, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = act(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// One connection/transaction at a time keeps a late autosave from overtaking a
// newer save or a discard, and makes reopening wait for the preceding write.
let pictureQueue: Promise<unknown> = Promise.resolve();
function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const result = pictureQueue.then(() => transact(mode, act));
  pictureQueue = result.catch(() => undefined);
  return result;
}

export async function readPictures<Shot, Image>(page: string): Promise<DraftPictures<Shot, Image> | null> {
  try {
    const got = await run<DraftPictures<Shot, Image> | undefined>('readonly', (s) => s.get(page));
    return got && Array.isArray(got.shots) && Array.isArray(got.images) ? got : null;
  } catch { return null; }
}

/** True when they were kept. */
export async function writePictures<Shot, Image>(page: string, pictures: DraftPictures<Shot, Image> | null): Promise<boolean> {
  try {
    if (pictures && (pictures.shots.length || pictures.images.length)) await run('readwrite', (s) => s.put(pictures, page));
    else await run('readwrite', (s) => s.delete(page));
    return true;
  } catch { return false; }
}

export async function discardDraft(page: string): Promise<void> {
  writeDraft(page, null);
  await writePictures(page, null);
}
