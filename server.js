'use strict';

/**
 * server.js
 * ---------------------------------------------------------------------------
 * A small REST API for to-dos, plus the static frontend files in /public.
 *
 *   GET    /api/todos            -> list every todo (in order)
 *   POST   /api/todos            -> add one
 *                                 { "title": "Buy milk", "note": "2%", "due": "2026-10-01" }
 *   PATCH  /api/todos/:id        -> update one; any of
 *                                 { "title", "note", "due", "completed" }
 *   DELETE /api/todos/:id        -> delete one
 *   PUT    /api/todos/order      -> save a new order { "ids": [3, 1, 2] }
 *   DELETE /api/todos/completed  -> remove all checked-off todos
 *
 * Start it with:  npm start        (then open http://localhost:3000)
 */

const path = require('node:path');
const express = require('express');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_TITLE_LENGTH = 200;
const MAX_NOTE_LENGTH = 1000;

const app = express();

// Parse JSON request bodies (so req.body works for POST/PATCH/PUT).
app.use(express.json());

// Serve index.html, style.css, app.js ... from the "public" folder.
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// Small helpers for validating what the browser sent us
// ---------------------------------------------------------------------------

/** "12" -> 12. Anything that is not a positive whole number -> null. */
function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Clean up a title. Returns the trimmed title, or null when it is unusable
 * (not a string, empty, or too long).
 */
function parseTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) return null;
  return title;
}

/**
 * A note is optional free text. Returns { ok: true, value } or
 * { ok: false, message }. "value" is undefined when the note was not sent.
 */
function validateNote(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      message: `A "note" must be a string of at most ${MAX_NOTE_LENGTH} characters.`,
    };
  }
  return { ok: true, value: value.trim() };
}

/**
 * A due date is optional and stored as "YYYY-MM-DD" (the format the HTML
 * date input uses). null or "" means "no due date".
 */
function validateDue(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === '') return { ok: true, value: null };

  const looksRight = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const isRealDate = looksRight && !Number.isNaN(Date.parse(value));

  if (!isRealDate) {
    return {
      ok: false,
      message: 'A "due" date must look like "YYYY-MM-DD", or be null to remove it.',
    };
  }
  return { ok: true, value };
}

/** Send a 400 (bad request) with a readable message. */
function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

/** Send a 404 (not found) with a readable message. */
function notFound(res, message) {
  return res.status(404).json({ error: message });
}

/** Express calls this when a route handler throws, so we always answer JSON. */
function handleError(error, req, res, next) {
  if (error.type === 'entity.parse.failed') {
    return badRequest(res, 'The request body must be valid JSON.');
  }

  if (error instanceof SyntaxError) {
    return badRequest(res, 'The request body must be valid JSON.');
  }

  console.error('Unexpected error while handling', req.method, req.originalUrl);
  console.error(error);
  return res.status(500).json({ error: 'Something went wrong on the server.' });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// List every todo.
app.get('/api/todos', (req, res) => {
  res.json(db.listTodos());
});

// Add a todo. Only "title" is required; "note" and "due" are optional.
app.post('/api/todos', (req, res) => {
  const body = req.body ?? {};
  const title = parseTitle(body.title);

  if (title === null) {
    return badRequest(
      res,
      `A "title" is required and must be 1-${MAX_TITLE_LENGTH} characters.`
    );
  }

  const note = validateNote(body.note);
  if (!note.ok) return badRequest(res, note.message);

  const due = validateDue(body.due);
  if (!due.ok) return badRequest(res, due.message);

  res.status(201).json(
    db.createTodo({
      title,
      note: note.value ?? '',
      due: due.value ?? null,
    })
  );
});

// ---- Reorder ---------------------------------------------------------------
// NOTE: this route is declared BEFORE the "/api/todos/:id" routes, otherwise
// Express would treat the word "order" as an id.

// Save a new order. Body: { "ids": [3, 1, 2] }
app.put('/api/todos/order', (req, res) => {
  const body = req.body ?? {};
  const rawIds = body.ids;

  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return badRequest(res, 'An "ids" array with at least one todo id is required.');
  }

  const ids = rawIds.map(parseId);
  if (ids.includes(null)) {
    return badRequest(res, 'Every entry in "ids" must be a positive whole number.');
  }

  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    return badRequest(res, 'The "ids" array must not contain duplicate ids.');
  }

  try {
    res.json(db.reorderTodos(ids));
  } catch (error) {
    // db.reorderTodos throws when the list does not match what we have stored.
    return badRequest(res, error.message);
  }
});

// Remove all completed todos. Declared before the ":id" routes for the same
// reason as above.
app.delete('/api/todos/completed', (req, res) => {
  const deleted = db.clearCompleted();
  res.json({ deleted, todos: db.listTodos() });
});

// ---- Single todo -----------------------------------------------------------

// Update one todo. Any of "title", "note", "due" and "completed" may be sent.
app.patch('/api/todos/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badRequest(res, 'The todo id must be a positive whole number.');

  const body = req.body ?? {};
  const changes = {};

  if (body.title !== undefined) {
    const title = parseTitle(body.title);
    if (title === null) {
      return badRequest(
        res,
        `The "title" must be a string of 1-${MAX_TITLE_LENGTH} characters.`
      );
    }
    changes.title = title;
  }

  if (body.note !== undefined) {
    const note = validateNote(body.note);
    if (!note.ok) return badRequest(res, note.message);
    changes.note = note.value;
  }

  if (body.due !== undefined) {
    const due = validateDue(body.due);
    if (!due.ok) return badRequest(res, due.message);
    changes.due = due.value;
  }

  if (body.completed !== undefined) {
    if (typeof body.completed !== 'boolean') {
      return badRequest(res, 'The "completed" value must be true or false.');
    }
    changes.completed = body.completed;
  }

  if (Object.keys(changes).length === 0) {
    return badRequest(
      res,
      'Send at least one of "title", "note", "due" or "completed" to update.'
    );
  }

  const updated = db.updateTodo(id, changes);
  if (updated === null) return notFound(res, `No todo with id ${id}.`);

  return res.json(updated);
});

// Delete one todo.
app.delete('/api/todos/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return badRequest(res, 'The todo id must be a positive whole number.');

  if (!db.deleteTodo(id)) return notFound(res, `No todo with id ${id}.`);

  return res.status(204).end();
});

// Any other /api/... URL: answer with JSON instead of Express' HTML page.
app.use('/api', (req, res) => {
  notFound(res, `Unknown API route: ${req.method} ${req.originalUrl}`);
});

// Error handler (must be the last app.use with four arguments).
app.use(handleError);

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------
// The tests import this file to get "app" without starting a real server, so we
// only listen when server.js is the file you actually ran (node server.js).

module.exports = app;

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log('');
    console.log('  Todo app is running:  http://localhost:' + PORT);
    console.log('  Database file:        ' + db.DB_FILE);
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use.`);
      console.error('  Start it on another port instead, for example:');
      console.error(`    PORT=3001 npm start      (PowerShell: $env:PORT=3001; npm start)\n`);
      process.exit(1);
    }
    throw error;
  });

  // Close the database cleanly when you stop the server with Ctrl+C.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log('\n  Shutting down...');
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}
