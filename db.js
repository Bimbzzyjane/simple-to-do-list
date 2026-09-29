'use strict';

/**
 * db.js
 * ---------------------------------------------------------------------------
 * Everything that talks to SQLite lives here. The rest of the app only calls
 * the plain JavaScript functions at the bottom of this file.
 *
 * The database is a single file: data/todos.db (created automatically the
 * first time you start the server).
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
// The DB_FILE environment variable lets the test script use a throwaway file.
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'todos.db');

// Make sure the "data" folder exists before SQLite tries to create the file.
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);

// "WAL" journal mode is the recommended setting for small web apps: faster
// writes and fewer "database is locked" surprises.
db.pragma('journal_mode = WAL');

// Create the table if it does not exist yet ("IF NOT EXISTS" makes this safe
// to run on every server start).
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',   -- extra details, optional
    due        TEXT,                         -- due date as 'YYYY-MM-DD', or NULL
    completed  INTEGER NOT NULL DEFAULT 0,   -- SQLite has no boolean: 0 = no, 1 = yes
    position   INTEGER NOT NULL,             -- 1, 2, 3 ... decides the display order
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_todos_position ON todos (position);
`);

/**
 * "Migrations": if the table was created by an older version of this app it
 * will not have the newer columns, so add any that are missing. This runs once
 * per start-up and does nothing once the columns exist.
 */
function ensureColumn(name, definition) {
  const columns = db.prepare(`PRAGMA table_info(todos)`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE todos ADD COLUMN ${name} ${definition}`);
    console.log(`Database updated: added the "${name}" column.`);
  }
}

ensureColumn('note', "TEXT NOT NULL DEFAULT ''");
ensureColumn('due', 'TEXT');

/**
 * Prepared statements. Preparing a statement once and reusing it is both
 * faster and safer: the "?" placeholders mean user input is never glued into
 * the SQL string, which protects us from SQL injection.
 */
const queries = {
  all: db.prepare(
    'SELECT id, title, note, due, completed FROM todos ORDER BY position ASC, id ASC'
  ),
  byId: db.prepare('SELECT id, title, note, due, completed FROM todos WHERE id = ?'),
  nextPosition: db.prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM todos'
  ),
  insert: db.prepare(
    'INSERT INTO todos (title, note, due, position) VALUES (?, ?, ?, ?)'
  ),
  updateTitle: db.prepare(
    "UPDATE todos SET title = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateNote: db.prepare(
    "UPDATE todos SET note = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateDue: db.prepare(
    "UPDATE todos SET due = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateCompleted: db.prepare(
    "UPDATE todos SET completed = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updatePosition: db.prepare('UPDATE todos SET position = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM todos WHERE id = ?'),
  removeCompleted: db.prepare('DELETE FROM todos WHERE completed = 1'),
};

/** Turn a database row into the shape our API sends to the browser. */
function toTodo(row) {
  return {
    id: row.id,
    title: row.title,
    note: row.note ?? '',
    due: row.due ?? null,
    completed: row.completed === 1,
  };
}

/** Write the given ids into the table in the given order (1, 2, 3 ...). */
const applyOrder = db.transaction((ids) => {
  ids.forEach((id, index) => queries.updatePosition.run(index + 1, id));
});

/** Rewrite positions as 1..n without changing the visible order. */
function compactPositions() {
  applyOrder(queries.all.all().map((row) => row.id));
}

const insertAndCompact = db.transaction((title, note, due) => {
  const position = queries.nextPosition.get().next;
  return queries.insert.run(title, note, due, position).lastInsertRowid;
});

const removeAndCompact = db.transaction((id) => {
  const result = queries.remove.run(id);
  if (result.changes > 0) compactPositions();
  return result.changes;
});

const clearCompletedAndCompact = db.transaction(() => {
  const result = queries.removeCompleted.run();
  if (result.changes > 0) compactPositions();
  return result.changes;
});

// ---------------------------------------------------------------------------
// The public functions used by server.js
// ---------------------------------------------------------------------------

/** All todos, already in display order. */
function listTodos() {
  return queries.all.all().map(toTodo);
}

/** One todo, or null when the id does not exist. */
function getTodo(id) {
  const row = queries.byId.get(id);
  return row ? toTodo(row) : null;
}

/** Create a todo at the end of the list and return it. */
function createTodo({ title, note = '', due = null }) {
  return getTodo(insertAndCompact(title, note, due));
}

/**
 * Update any of the fields we were given: title, note, due, completed.
 * Returns the updated todo, or null when the id does not exist.
 */
function updateTodo(id, { title, note, due, completed }) {
  if (!queries.byId.get(id)) return null;

  if (title !== undefined) queries.updateTitle.run(title, id);
  if (note !== undefined) queries.updateNote.run(note, id);
  if (due !== undefined) queries.updateDue.run(due, id);
  if (completed !== undefined) queries.updateCompleted.run(completed ? 1 : 0, id);

  return getTodo(id);
}

/** Delete one todo. Returns true when something was actually deleted. */
function deleteTodo(id) {
  return removeAndCompact(id) > 0;
}

/** Remove every completed todo. Returns how many rows were deleted. */
function clearCompleted() {
  return clearCompletedAndCompact();
}

/**
 * Save a new order.
 * "ids" must contain exactly the ids we currently have (no more, no less).
 * Returns the freshly ordered list.
 * Throws an Error with a friendly message when the ids do not match.
 */
function reorderTodos(ids) {
  const currentIds = queries.all.all().map((row) => row.id);

  if (ids.length !== currentIds.length) {
    throw new Error('The order list must contain every todo exactly once.');
  }

  const remaining = new Set(currentIds);
  for (const id of ids) {
    if (!remaining.has(id)) {
      throw new Error('The order list contains an unknown todo id.');
    }
    remaining.delete(id); // also catches duplicates, because delete removes from the Set
  }

  applyOrder(ids);
  return listTodos();
}

/** Close the database file (used when the process shuts down). */
function close() {
  db.close();
}

module.exports = {
  DB_FILE,
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  deleteTodo,
  clearCompleted,
  reorderTodos,
  close,
};
