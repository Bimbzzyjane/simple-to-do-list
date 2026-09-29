# Simple Todo Webapp

A small to-do list with an **Express REST API**, a **SQLite database**, and a
**plain HTML/CSS/JS frontend**. No build step, no framework on the frontend.

## What it can do

- **Add** a task (an empty task is rejected; max 200 characters)
- **Tick tasks off** — finished tasks get a line through them
- **Notes** — open the **Details** panel on any row to add a note (up to 1000
  characters). A "Note" badge appears under the title.
- **Due dates** — set one in the Details panel. It shows as a badge, and turns
  amber when it is due today and red when it is overdue.
- **Reorder** by dragging a row, or with the ↑ / ↓ buttons
- **Rename** in place: double-click the title (Enter saves, Esc cancels), or edit
  the title field in the Details panel
- **Delete** with a clearly labelled red **Delete** button, or remove every
  finished task with "Clear done"
- **Undo** — after any delete, a bar appears at the bottom of the screen for 8
  seconds with an Undo button that puts the task back where it was
- **Search** titles *and* notes as you type (press <kbd>/</kbd> to jump to the box)
- **Sort** by My order (manual), Due date, or A to Z
- **Filter** with All / Active / Done, plus a "x of y left" counter
- Everything is saved in SQLite, so your list is still there after a restart

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer (this project was tested on Node 24)

## Install and run

```bash
npm install      # only needed the first time
npm start
```

Then open <http://localhost:3000> in your browser.

To use a different port: `PORT=3001 npm start`
(PowerShell: `$env:PORT=3001; npm start`)

To stop the server: press `Ctrl+C` in the terminal.

## Running the tests

```bash
npm test
```

This runs two suites with no extra libraries:

- `test/api.test.js` starts the real server on a random port against a
  **temporary database file** (your `data/todos.db` is never touched) and checks
  every endpoint, including all the error cases.
- `test/frontend.test.js` runs `public/app.js` against a tiny fake browser
  ("DOM stub") to check the page logic: rendering, notes, due dates, search,
  sorting, filtering, reordering, delete + undo, and what happens when the
  server fails.

## Files

| File | What it is |
|---|---|
| `server.js` | Express app: the REST API routes + serves the frontend files |
| `db.js` | All SQLite code: table creation, migrations and the queries |
| `public/index.html` | The page structure |
| `public/style.css` | The styling |
| `public/app.js` | Frontend logic: calls the API and redraws the list |
| `test/api.test.js` | API tests (temporary database, real server) |
| `test/frontend.test.js` | Page-logic tests (fake browser) |
| `data/todos.db` | Your data (created automatically on first run) |

## The database

One table, created on first start:

```sql
CREATE TABLE todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,              -- the task itself, max 200 chars
  note       TEXT    NOT NULL DEFAULT '',   -- extra details, max 1000 chars
  due        TEXT,                         -- 'YYYY-MM-DD', or NULL for no date
  completed  INTEGER NOT NULL DEFAULT 0,   -- 0 = not done, 1 = done
  position   INTEGER NOT NULL,             -- 1, 2, 3 ... display order
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**About migrations:** `db.js` checks the table on start-up and adds any missing
column with `ALTER TABLE ... ADD COLUMN` (see `ensureColumn`). That is how the
`note` and `due` columns were added to an already-existing `todos.db` without
losing your tasks. The same trick is what you would use for future changes.

To start over with an empty list, stop the server and delete the `data` folder.

Tip: you can peek inside the file with
[DB Browser for SQLite](https://sqlitebrowser.org/) if you want to see the rows.

## REST API

All request and response bodies are JSON. Errors look like `{ "error": "..." }`.

| Method | URL | Body | Answers |
|---|---|---|---|
| GET | `/api/todos` | – | `200` list of todos in order |
| POST | `/api/todos` | `{ "title": "Buy milk", "note": "2%", "due": "2026-10-01" }` | `201` the new todo |
| PATCH | `/api/todos/:id` | any of `{ "title", "note", "due", "completed" }` | `200` the updated todo |
| DELETE | `/api/todos/:id` | – | `204` no content |
| PUT | `/api/todos/order` | `{ "ids": [3, 1, 2] }` | `200` the list in its new order |
| DELETE | `/api/todos/completed` | – | `200` `{ "deleted": 2, "todos": [...] }` |

A todo always looks like this:

```json
{ "id": 1, "title": "Buy milk", "note": "2%", "due": "2026-10-01", "completed": false }
```

Rules the server enforces: `title` is required and 1–200 characters, `note` is at
most 1000 characters, `due` must be `YYYY-MM-DD` (or `null`/`""` to remove it),
`completed` must be `true` or `false`, and `ids` in the reorder call must contain
every current todo exactly once. Anything else answers `400`.

### Try it from the terminal

```bash
curl http://localhost:3000/api/todos
curl -X POST http://localhost:3000/api/todos -H "Content-Type: application/json" -d "{\"title\":\"Buy milk\",\"note\":\"2%\"}"
curl -X PATCH http://localhost:3000/api/todos/1 -H "Content-Type: application/json" -d "{\"due\":\"2026-10-01\"}"
curl -X DELETE http://localhost:3000/api/todos/1
```

## How the request flows

1. You type a task and press Enter → `public/app.js` sends
   `POST /api/todos` with `fetch()`.
2. `server.js` checks the input, then asks `db.js` to save the row.
3. `db.js` runs a prepared `INSERT` statement and hands the new todo back.
4. The server answers with JSON, and `app.js` adds the new row to the page.

## Notes about the design choices

- **`position` column instead of a "sort order" in the browser**: dragging sends
  the complete new id order, and the server writes 1, 2, 3 ... in one
  transaction, so the order survives reloads.
- **Prepared statements** (`?` placeholders) are used everywhere, which prevents
  SQL injection.
- Row text is inserted with `textContent`, not `innerHTML`, so a task title can
  never inject HTML.
- Optimistic UI: the screen updates first, and rolls back with a red message if
  the request fails.
- **Reordering is only offered when the visible order really is the stored
  order** — that is, in the "All" filter with the "My order" sort and nothing in
  the search box. Dragging and ↑ / ↓ are disabled otherwise, so the app can
  never save a wrong order.
- **Undo recreates tasks rather than "undeleting" rows**, because the server has
  no soft-delete flag. The restored tasks come back with new ids (and a fresh
  created-at time) in their original positions, and everything you can see —
  title, note, due date, finished state and order — is preserved.
- **Dates are stored as plain `'YYYY-MM-DD'` strings** and compared as text, and
  the page formats them by splitting the string. That avoids the classic bug
  where a date shifts to the previous day because of the timezone.
- `server.js` exports the Express `app` and only starts listening when it is run
  directly, which is what lets the test suite boot it on a random port.

## Known limits

- No login: everyone who can reach the server shares one list. Do not publish it
  to the internet as-is.
- Drag-and-drop needs a mouse; on a touch screen use the ↑ / ↓ buttons.
- Undo is single-level: it restores the most recent delete only, and the bar
  disappears after 8 seconds.
- The search box does a plain "contains" check on the title and note (no fuzzy
  matching, no word-order ranking).
