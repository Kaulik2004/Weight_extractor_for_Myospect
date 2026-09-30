/**
 * File System Access API helpers (Chrome, Edge, Opera). Other browsers fall
 * back to the backend folder browser or a plain download.
 */

// Minimal typings: the API is not in TypeScript's DOM lib for all versions.
interface FsWritable {
  write(data: string | Blob): Promise<void>
  close(): Promise<void>
}
export interface FsFileHandle {
  createWritable(): Promise<FsWritable>
}
export interface FsDirHandle {
  kind: 'directory'
  name: string
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandle>
  queryPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>
}

type PickerWindow = Window & {
  showDirectoryPicker?: (o?: { id?: string; mode?: 'readwrite'; startIn?: string }) => Promise<FsDirHandle>
}

export const supportsDirectoryPicker = () =>
  typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function'

export async function pickDirectory(): Promise<FsDirHandle | null> {
  try {
    return await (window as PickerWindow).showDirectoryPicker!({ id: 'wx-csv', mode: 'readwrite', startIn: 'documents' })
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null
    throw e
  }
}

async function ensurePermission(dir: FsDirHandle): Promise<boolean> {
  if (!dir.queryPermission) return true
  if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return (await dir.requestPermission?.({ mode: 'readwrite' })) === 'granted'
}

export async function writeFileToDirectory(dir: FsDirHandle, filename: string, text: string): Promise<void> {
  if (!(await ensurePermission(dir))) throw new Error('Write permission to the folder was denied')
  const handle = await dir.getFileHandle(filename, { create: true })
  const w = await handle.createWritable()
  await w.write(new Blob([text], { type: 'text/csv' }))
  await w.close()
}

// Persist the chosen folder across reloads (handles are structured-cloneable into IndexedDB).
const DB = 'wx-fs'
const STORE = 'handles'

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function rememberDirectory(dir: FsDirHandle | null): Promise<void> {
  try {
    const db = await idb()
    const tx = db.transaction(STORE, 'readwrite')
    if (dir) tx.objectStore(STORE).put(dir, 'csvDir')
    else tx.objectStore(STORE).delete('csvDir')
  } catch {
    /* storage unavailable: folder is simply not remembered */
  }
}

export async function recallDirectory(): Promise<FsDirHandle | null> {
  try {
    const db = await idb()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get('csvDir')
      req.onsuccess = () => resolve((req.result as FsDirHandle) ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}
