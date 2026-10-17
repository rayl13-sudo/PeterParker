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
.