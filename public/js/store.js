// Characters are kept in this browser's IndexedDB. When the server has a shared
// library, these are this browser's copies (see app.js).

const DB_NAME = 'gurps-sheets';
const STORE = 'characters';

let dbPromise;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function listCharacters() {
  const all = await run('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getCharacter = (id) => run('readonly', (s) => s.get(id));
export const putCharacter = (character) => run('readwrite', (s) => s.put(character));
export const deleteCharacter = (id) => run('readwrite', (s) => s.delete(id));
