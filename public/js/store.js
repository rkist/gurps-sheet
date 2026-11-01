// Characters are kept in this browser's IndexedDB. When the server has a shared
// library, these are this browser's copies (see app.js). The player's PDFs
// (books.js) have a database of their own: a book's settings in `books`, the
// file itself in `files`, so editing the settings doesn't rewrite the file.

function database(name, stores) {
  let dbPromise;
  const open = () =>
    (dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        for (const store of stores) req.result.createObjectStore(store, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));

  // Runs `action` on the stores named by `scope` (one or an array) and
  // resolves to the result of the request it returns.
  return async (scope, mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(scope, mode);
      const req = action(Array.isArray(scope) ? tx : tx.objectStore(scope));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
}

const characters = database('gurps-sheets', ['characters']);
const books = database('gurps-books', ['books', 'files']);

export async function listCharacters() {
  const all = await characters('characters', 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getCharacter = (id) => characters('characters', 'readonly', (s) => s.get(id));
export const putCharacter = (character) => characters('characters', 'readwrite', (s) => s.put(character));
export const deleteCharacter = (id) => characters('characters', 'readwrite', (s) => s.delete(id));

export const listBooks = () => books('books', 'readonly', (s) => s.getAll());
export const putBook = (book) => books('books', 'readwrite', (s) => s.put(book));
// Resolves to the PDF as a Blob.
export const getBookFile = async (id) => (await books('files', 'readonly', (s) => s.get(id)))?.file;

export const addBook = (book, file) =>
  books(['books', 'files'], 'readwrite', (tx) => {
    tx.objectStore('files').put({ id: book.id, file });
    return tx.objectStore('books').put(book);
  });

export const deleteBook = (id) =>
  books(['books', 'files'], 'readwrite', (tx) => {
    tx.objectStore('files').delete(id);
    return tx.objectStore('books').delete(id);
  });
