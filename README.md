# PeterParker

PeterParker is a UCI parking finder. Enter a campus location and see nearby parking options on a map and in a short list. Each result should explain where it is and what kind of parking is allowed there.

## 12-hour MVP

The main flow is **search → compare nearby parking → open a parking location**. Build this before polishing the other prototype screens.

1. Open the map and show parking locations as pins, with a matching result list.
2. Search for a UCI building, landmark, or address. Recenter the map and sort results by distance from the selected location. If full address search is unavailable, ship a small set of searchable UCI landmarks first.
3. Select a pin or result to see the parking name, address, distance, parking type (student, visitor, paid, etc.), and known permit restrictions. Add a directions link.
4. Filter results by parking type. Use the same colors for pins, filters, and result labels.
5. Let people use parking search as guests; keep account features optional. Make the layout usable on a phone and desktop, with clear empty, loading, and error states.

Start with a small, checked set of UCI parking locations and coordinates. Show only information backed by that data. **Do not display invented live spot counts, availability, ratings, or reviews.** If availability is added later, label its source and update time.

### What the repository has today

- `frontend/` is plain HTML, CSS, and JavaScript with no build step.
- The current UI has sign-in and sign-up forms, a signed-in header, and a generic add/delete **Items** list. It has no parking map, location search, parking dataset, filters, or parking detail view yet.
- `backend/` is a FastAPI app with SQLite-backed accounts, sessions, and user-scoped generic items. It has no parking or location API yet.
- The existing email/password account flow can be reused later. Google sign-in, guest access, profile editing, saved places, and permit management are not implemented.

### Scope from the prototypes

| Prototype idea | MVP decision |
| --- | --- |
| Map, search bar, colored parking pins, and result cards | Build now; these are the core product. |
| Parking type and permit information | Show for verified locations; filter by type. |
| Sign-in and sign-up | Keep the existing email/password flow, but let guests search for parking without an account. |
| Profile and saved places | Later; the current Items feature is only a generic scaffold. |
| Real-time availability and spot counts | Later, only with a reliable data source. |
| Ratings, reviews, cautions, messaging, Google sign-in, admin dashboard | Later. |

### Suggested 12-hour order

| Time | Work |
| --- | --- |
| Hours 0–2 | Verify a small parking dataset: name, coordinates, address, type, and permit notes. |
| Hours 2–6 | Replace the generic Items screen with the map, pins, and matching list. |
| Hours 6–9 | Add location search, distance ordering, filters, and parking details/directions. |
| Hours 9–12 | Check mobile layout, keyboard use, empty/error states, and the main flow end to end. |

The MVP is done when a guest can enter a supported location, see nearby parking on both the map and list, filter by type, open a result, and understand its parking restrictions. A selected result and its pin should stay in sync.

## Run the current scaffold

Requires Python 3.10+.

```sh
make install   # create backend/.venv and install dependencies
make dev       # backend on :8000, frontend on :5173
```

Open <http://localhost:5173>. API docs are at <http://localhost:8000/docs>. Run either side separately with `make backend` or `make frontend`; run backend tests with `make test`.

Backend settings come from environment variables or `backend/.env` (see `backend/.env.example`). The frontend API URL is in `frontend/js/config.js`. Add a frontend origin to `CORS_ORIGINS` if it runs on a different port.

## Deploy the backend to Vercel

Create a Vercel project from this repository with **Root Directory `backend`**
and the **FastAPI** framework preset. Leave the build and output directory
settings at their defaults. `app/main.py` exports the application, and
`backend/vercel.json` selects the framework. Python 3.12 is pinned for deployment.
This deploys the API; the frontend remains a separate deployment.
See [Vercel's FastAPI guide](https://vercel.com/docs/frameworks/backend/fastapi).

The deployed backend requires PostgreSQL for durable profiles, sessions, and
items. Local development still defaults to SQLite. The app refuses to use SQLite
when Vercel's `VERCEL` environment flag is set, because a local file cannot provide
shared persistent state across serverless instances.

1. In Supabase's **Connect** dialog, copy the **transaction pooler** PostgreSQL
   connection string, fill in the database password, and include `sslmode=require`.
   Store this as `DATABASE_URL` in Vercel's environment variables. This is a private
   backend credential, distinct from the publishable auth key. The driver disables
   prepared statements for compatibility with transaction pooling.
2. Before the first deployment, run
   [`backend/migrations/001_postgres.sql`](backend/migrations/001_postgres.sql) in
   Supabase's SQL editor as the database owner. It creates the app's `public.users`,
   `public.sessions`, and `public.items` tables. These are separate from Supabase's
   `auth.users`. RLS is enabled with no client policies, so the backend must connect
   as the database owner or another role with access that bypasses RLS.
   Use a separate database/project if these table names are already used by another app.
3. Also set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `CORS_ORIGINS` in Vercel.
   `CORS_ORIGINS` is a JSON array of exact frontend origins, for example
   `["https://your-frontend.vercel.app"]`. Add any explicitly trusted preview origins
   if needed. Local `.env` files are excluded from deployments.
4. Deploy, then check `https://YOUR-BACKEND.vercel.app/api/health` and `/docs`.
   Set `API_BASE_URL` in `frontend/js/config.js` to
   `https://YOUR-BACKEND.vercel.app/api`, and set Supabase's Auth Site URL to the
   deployed **frontend** URL for confirmation emails.

Schema changes run explicitly, never during cold starts. For a new local PostgreSQL
database, set `DATABASE_URL` in `backend/.env`, then initialize it from `backend/`
with `.venv/bin/python -c 'from app.db import init_db; init_db()'`.
Existing SQLite data is not automatically copied to PostgreSQL. Use separate
databases for preview and production deployments to isolate their users and data.
The health endpoint checks application availability; test signup, confirmation,
login, and item creation to verify database connectivity after deployment.

## Authentication configuration

### Supabase setup

Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `backend/.env`
(see `backend/.env.example`), then restart the backend. Both settings are required
to enable Supabase authentication. Without either setting, local authentication
remains available. The root `.env.local` is not loaded by this FastAPI app.

In Supabase Authentication settings, enable email/password login and set the
Site URL to `http://localhost:5173` for local development (use your actual frontend
URL in production). If email confirmation is enabled, signup displays a prompt
to check email. After confirming, use email for the first sign-in; subsequent
sign-ins also accept the username. Usernames must be unique among linked accounts;
if a username becomes unavailable before confirmation, email sign-in still works.

Supabase checks credentials; the configured database stores the profile, items and revocable
app sessions with the existing Remember Me lifetimes. Supabase sign-out or account
changes do not revoke these local sessions automatically. Existing local accounts
need a Supabase account with the same verified email to link their data on login.
Passwords are not migrated. Never use a service-role or secret key here.

### Local authentication

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
The current scaffold requires sign-in to reach its Items screen. Sign-up collects a username and email; sign-in accepts either. Passwords need at least eight characters, one capital letter, and one special character. `Remember Me` stores the token in `localStorage` for the configured long session; otherwise it uses `sessionStorage`. The API exposes `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me`.
