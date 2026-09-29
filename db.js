'use strict';

/**
 * db.js
 * ---------------------------------------------------------------------------
 * All of the database work lives here. The rest of the app only calls the
 * functions at the bottom of this file.
 *
 * It runs in two modes, chosen automatically:
 *
 *  - On your own computer (no environment variables set): an ordinary SQLite
 *    file in data/todos.db.
 *  - On Vercel (TURSO_DATABASE_URL is set): a free hosted database called
 *    Turso, reached over HTTPS. This is needed because Vercel's filesystem is
 *    read-only and is thrown away between requests, so a local file cannot
 *    work there.
 *
 * The SQL is exactly the same in both modes, so nothing else in the app has to
 * know which one is in use.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');

const REMOTE_URL = process.env.TURSO_DATABASE_URL;
const LOCAL_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'todos.db');

// A clear message here is friendlier than a confusing crash later on.
if (!REMOTE_URL && process.env.VERCEL) {
  throw new Error(
    'Running on Vercel, but TURSO_DATABASE_URL is not set.\n' +
      'Add these two Environment Variables in your Vercel project settings:\n' +
      '  TURSO_DATABASE_URL  (starts with libsql://)\n' +
      '  TURSO_AUTH_TOKEN'
  );
}

let client;
if (REMOTE_URL) {
  client = createClient({ url: REMOTE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
} else {
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  client = createClient({ url: `file:${LOCAL_FILE}` });
}

// A short description of where the data lives, for the start-up message.
const DB_DESCRIPTION = REMOTE_URL ? `Turso (${REMOTE_URL})` : LOCAL_FILE;

// ---------------------------------------------------------------------------
// Tiny helpers around the client
// ---------------------------------------------------------------------------

/** Run a query that reads, and get all the rows back. */
async function all(sql, args = []) {
  return (await client.execute({ sql, args })).rows;
}

/** Run a query that reads, and get the first row (or null). */
async function one(sql, args = []) {
  const rows = await all(sql, args);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Run several statements as a single transaction: either all of them happen, or
 * none of them do. This is how deletions and re-saving the order stay
 * consistent.
 */
async function runAll(statements) {
  if (statements.length > 0) await client.batch(statements);
}

const SELECT_COLUMNS = 'id, title, note, due, completed';

// ---------------------------------------------------------------------------
// Creating / upgrading the table (runs once at start-up)
// ---------------------------------------------------------------------------

/**
 * Creates the table if it is missing, and adds any column that an older version
 * of this app did not have. That is how the "note" and "due" columns were added
 * to an existing database without losing any tasks.
 */
async function setup() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT    NOT NULL,
      note       TEXT    NOT NULL DEFAULT '',   -- extra details, optional
      due        TEXT,                         -- due date as 'YYYY-MM-DD', or NULL
      completed  INTEGER NOT NULL DEFAULT 0,   -- SQLite has no boolean: 0 = no, 1 = yes
      position   INTEGER NOT NULL,             -- 1, 2, 3 ... decides the display order
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const existing = (await all('PRAGMA table_info(todos)')).map((column) => column.name);

  for (const [name, definition] of [['note', "TEXT NOT NULL DEFAULT ''"], ['due', 'TEXT']]) {
    if (!existing.includes(name)) {
      await client.execute(`ALTER TABLE todos ADD COLUMN ${name} ${definition}`);
      console.log(`Database updated: added the "${name}" column.`);
    }
  }

  await client.execute('CREATE INDEX IF NOT EXISTS idx_todos_position ON todos (position)');
}

// Start setting the database up as soon as this file is loaded. Routes wait for
// this promise (see the "db.ready" middleware in server.js).
const ready = setup();

// ---------------------------------------------------------------------------
// Turning rows into the objects the API sends to the browser
// ---------------------------------------------------------------------------

function toTodo(row) {
  return {
    id: Number(row.id),
    title: row.title,
    note: row.note ?? '',
    due: row.due ?? null,
    completed: Number(row.completed) === 1,
  };
}

/** Every id, in the order they are currently displayed. */
async function allIds() {
  const rows = await all('SELECT id FROM todos ORDER BY position ASC, id ASC');
  return rows.map((row) => Number(row.id));
}

/** Statements that write position = 1, 2, 3 ... to match the given order. */
function positionStatements(ids) {
  return ids.map((id, index) => ({
    sql: 'UPDATE todos SET position = ? WHERE id = ?',
    args: [index + 1, id],
  }));
}

const touch = ', updated_at = datetime(\'now\')';

// ---------------------------------------------------------------------------
// The public functions used by server.js (all of them are async now)
// ---------------------------------------------------------------------------

/** All todos, already in display order. */
async function listTodos() {
  const rows = await all(`SELECT ${SELECT_COLUMNS} FROM todos ORDER BY position ASC, id ASC`);
  return rows.map(toTodo);
}

/** One todo, or null when the id does not exist. */
async function getTodo(id) {
  const row = await one(`SELECT ${SELECT_COLUMNS} FROM todos WHERE id = ?`, [id]);
  return row ? toTodo(row) : null;
}

/** Create a todo at the end of the list and return it. */
async function createTodo({ title, note = '', due = null }) {
  const { next } = await one('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM todos');

  const row = await one(
    `INSERT INTO todos (title, note, due, position) VALUES (?, ?, ?, ?)
     RETURNING ${SELECT_COLUMNS}`,
    [title, note, due, next]
  );

  return toTodo(row);
}

/**
 * Update any of the fields we were given: title, note, due, completed.
 * Returns the updated todo, or null when the id does not exist.
 */
async function updateTodo(id, { title, note, due, completed }) {
  if ((await one('SELECT id FROM todos WHERE id = ?', [id])) === null) return null;

  const statements = [];
  if (title !== undefined) {
    statements.push({ sql: `UPDATE todos SET title = ?${touch} WHERE id = ?`, args: [title, id] });
  }
  if (note !== undefined) {
    statements.push({ sql: `UPDATE todos SET note = ?${touch} WHERE id = ?`, args: [note, id] });
  }
  if (due !== undefined) {
    statements.push({ sql: `UPDATE todos SET due = ?${touch} WHERE id = ?`, args: [due, id] });
  }
  if (completed !== undefined) {
    statements.push({
      sql: `UPDATE todos SET completed = ?${touch} WHERE id = ?`,
      args: [completed ? 1 : 0, id],
    });
  }

  await runAll(statements);
  return getTodo(id);
}

/** Delete one todo and tidy up the order. True when something was deleted. */
async function deleteTodo(id) {
  const ids = await allIds();
  if (!ids.includes(id)) return false;

  await runAll([
    { sql: 'DELETE FROM todos WHERE id = ?', args: [id] },
    ...positionStatements(ids.filter((existing) => existing !== id)),
  ]);

  return true;
}

/** Remove every completed todo. Returns how many rows were deleted. */
async function clearCompleted() {
  const done = (await all('SELECT id FROM todos WHERE completed = 1')).map((row) => Number(row.id));
  if (done.length === 0) return 0;

  const remaining = (await allIds()).filter((id) => !done.includes(id));

  await runAll([
    { sql: 'DELETE FROM todos WHERE completed = 1' },
    ...positionStatements(remaining),
  ]);

  return done.length;
}

/**
 * Save a new order.
 * "ids" must contain exactly the ids we currently have (no more, no less).
 * Returns the freshly ordered list, or throws an Error with a friendly message.
 */
async function reorderTodos(ids) {
  const currentIds = await allIds();

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

  await runAll(positionStatements(ids));
  return listTodos();
}

/** Close the connection (used when the process shuts down). */
function close() {
  client.close();
}

module.exports = {
  DB_DESCRIPTION,
  ready,
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  deleteTodo,
  clearCompleted,
  reorderTodos,
  close,
};
