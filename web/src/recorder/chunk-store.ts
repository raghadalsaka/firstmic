// A take's chunks are written here as they are recorded, so a reload or crash before Send doesn't lose it.

export type LocalTakeMeta = {
  localId: string
  mimeType: string
  finalChunkCount: number | null
  durationMs: number | null
}

const DB_NAME = 'firstmic-recorder'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'localId' })
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { keyPath: ['trackLocalId', 'idx'] })
        store.createIndex('byTrack', 'trackLocalId')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode)
        const req = fn(t.objectStore(storeName))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export const chunkStore = {
  async putTrack(meta: LocalTakeMeta): Promise<void> {
    await tx('tracks', 'readwrite', (s) => s.put(meta))
  },

  async getTrack(localId: string): Promise<LocalTakeMeta | null> {
    const row = (await tx('tracks', 'readonly', (s) => s.get(localId))) as LocalTakeMeta | undefined
    return row ?? null
  },

  async deleteTrack(localId: string): Promise<void> {
    await tx('tracks', 'readwrite', (s) => s.delete(localId))
    const keys = (await tx('chunks', 'readonly', (s) => s.index('byTrack').getAllKeys(localId))) as IDBValidKey[]
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction('chunks', 'readwrite')
      const store = t.objectStore('chunks')
      for (const key of keys) {
        store.delete(key)
      }
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
    })
  },

  async putChunk(trackLocalId: string, idx: number, blob: Blob): Promise<void> {
    await tx('chunks', 'readwrite', (s) => s.put({ trackLocalId, idx, blob }))
  },

  /** All chunks of a take, in recording order. */
  async getChunks(trackLocalId: string): Promise<Blob[]> {
    const rows = (await tx('chunks', 'readonly', (s) => s.index('byTrack').getAll(trackLocalId))) as {
      idx: number
      blob: Blob
    }[]
    return rows.sort((a, b) => a.idx - b.idx).map((row) => row.blob)
  },
}
