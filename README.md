# PeterParker

Monorepo with a FastAPI backend and a vanilla HTML/CSS/JavaScript frontend.

```
.
├── backend/            FastAPI app
│   ├── app/
│   │   ├── main.py     App factory, CORS, router mount
│   │   ├── config.py   Settings (env / .env)
│   │   └── api/routes/ Route modules (health, items)
│   └── tests/
├── frontend/           Static site, no build step
│   ├── index.html
│   ├── css/styles.css
│   └── js/             config.js (API URL), api.js (fetch client), app.js
└── Makefile
```

## Getting started

Requires Python 3.10+.

```sh
make install   # create backend/.venv and install deps
make dev       # backend on :8000, frontend on :5173
```

Open http://localhost:5173. API docs are at http://localhost:8000/docs.

Run each side on its own with `make backend` or `make frontend`.

## Testing

```sh
make test
```

## Configuration

Backend settings come from environment variables or `backend/.env`
(see `backend/.env.example`). Add a frontend origin to `CORS_ORIGINS`
if you serve it from somewhere other than port 5173.

The frontend's API base URL is set in `frontend/js/config.js`.

## Authentication

Opening the app shows a sign-in / sign-up screen. Sign-up asks for a username and
email; sign-in accepts either one in a single "Username or email" field.

Sign-up rules (enforced by the API, mirrored in the UI):

- **Password:** at least 8 characters, one capital letter, one special character.
  The sign-up form shows a checklist that ticks off each rule as you type.
- **Username:** 3-32 characters (letters, numbers, `.`, `_`, `-`). Accounts, sessions and items
are stored in SQLite (`backend/app.db`, created on first run). Passwords are hashed
with PBKDF2, and the API issues an opaque bearer token; only its hash is stored.

**Remember Me** controls how long the session lasts:

| | Token stored in | Server-side lifetime |
|---|---|---|
| Unchecked | `sessionStorage` (cleared when the browser closes) | `SESSION_HOURS` (default 12) |
| Checked | `localStorage` (survives restarts) | `REMEMBER_ME_DAYS` (default 30) |

Endpoints: `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`,
`GET /api/auth/me`. The `/api/items` routes require a token and are scoped per user.
