# PeterParker

PeterParker helps people find parking near a searched UCI location. The demo has four screens: **login/sign-up, map/search, parking details, and profile**. The map uses OpenStreetMap. Selecting a color-coded place on the map opens its distance, permit/type information, rating, and community reports.

## 12-hour feature plan

| Screen | Must work in the demo | Backend support |
| --- | --- | --- |
| Login/sign-up | Create an account, sign in, sign out, and keep the session. | Repair and reuse the existing `/api/auth/*` routes. |
| Main map | Show an OpenStreetMap basemap with attribution. Search a supported UCI landmark, see nearby parking pins and a matching list, filter by parking type, and select a place. | Return a small verified parking catalog with coordinates, type, address, and permit notes. A short landmark list and straight-line distance calculation can live in the frontend; label the distance accordingly. |
| Parking details | Show name, distance from the search point, parking rules, rating, community reports, and a directions link. | Return place details and stored ratings/reports. Show “No ratings yet” when none exist. |
| Profile | Show username, email, selected permit type, and saved parking places. Let the user update the permit type and save/unsave a place. | Reuse `/api/auth/me`; add profile and saved-place routes scoped to the signed-in user. |

OpenStreetMap provides the basemap; PeterParker supplies its own checked parking records, permit labels, ratings, and reports. The frontend renders the map and pins, so the backend does not need to serve map tiles. The map colors represent **parking/permit types**, with a legend and the same labels in result cards. Search is limited to a small, known UCI area for this demo. Do not promise live spot availability or invent spot counts, ratings, or community reports.

### Backend work split

Agree on the place JSON shape and database fields first. Assign one owner to `backend/app/db.py` migrations and `backend/app/api/__init__.py` router registration so separate workstreams do not edit those files at the same time.

| Workstream | Files/routes to own | Deliverable |
| --- | --- | --- |
| **1. Auth + profile** | Existing `routes/auth.py`; new `routes/profile.py` | First fix the committed conflict markers and missing moderation import in `auth.py` so the API starts. Preserve login/sign-up/logout/`me`. Add `GET /api/profile`, `PATCH /api/profile` for a simple permit type, and `GET/POST/DELETE /api/profile/saved/{place_id}` for saved places. Keep email/password changes out of this sprint. |
| **2. Parking catalog + search data** | New `routes/parking.py`; checked seed data | Add `parking_places` with ID, name, latitude, longitude, address, parking type, permit note, and optional source URL. Expose `GET /api/parking` and `GET /api/parking/{id}`. The frontend can filter and calculate straight-line distance for a small catalog, so no geocoding service is required for the demo. OpenStreetMap tiles do not provide parking availability or user ratings. |
| **3. Community ratings/reports** | New `routes/reviews.py` | Add reviews linked to a real user and place, with a 1–5 rating, short report, and timestamp. Expose `GET /api/parking/{id}/reviews` and authenticated `POST /api/parking/{id}/reviews`; return the average rating and count from stored reviews. No review means no rating. |
| **4. Integration** | DB schema/router registration, API checks | Connect the routes, confirm anonymous reads versus signed-in writes, check error responses, and run one end-to-end flow across all four screens. |

Suggested tables: `parking_places`, `reviews(place_id, user_id, rating, report, created_at)`, and `saved_places(user_id, place_id)`. Add `permit_type` to the user profile. Keep the existing `items` API untouched until the new flow is working; the Items UI is a scaffold, not parking data.

### Build order and cut line

1. **Hours 0–2:** Repair auth startup, agree on the API contract, and verify a small parking dataset.
2. **Hours 2–6:** Ship the parking API and connect search, pins, list, filters, and details.
3. **Hours 6–9:** Add persisted reviews/ratings, profile permit type, and saved places.
4. **Hours 9–12:** Integrate the four screens and check mobile layout, empty states, authentication, and the main flow.

If time slips, keep the four screens but simplify profile to read-only account details and show ratings/reports as an empty state until real entries exist. Protect the core **search → select parking → inspect details** flow. Live availability, Google sign-in, messaging, and email changes are outside this sprint.

### Current repository status

- The frontend is plain HTML/CSS/JavaScript with no build step. It currently contains the login/sign-up screen and a generic signed-in Items screen; the parking map, details, and profile screens still need to be built.
- FastAPI and SQLite already support users, sessions, and generic user-scoped items. Supabase authentication has been added as an option, but the current `auth.py` has committed conflict markers and imports a missing `app.moderation` module. Repair that before testing the login flow.
- The backend has no parking, profile, saved-place, or review endpoints yet.

## Run the current scaffold

Requires Python 3.10+.

```sh
make install   # create backend/.venv and install dependencies
make dev       # the whole app at http://localhost:8000
```

Open <http://localhost:8000>; the backend serves the frontend too. The frontend also works from any other
local server (e.g. `make frontend` on :5173 or VS Code Live Server) as long as the backend is running, and
opening `index.html` from disk redirects to <http://localhost:8000>. API docs are at <http://localhost:8000/docs>. Run either side separately with `make backend` or `make frontend`; run backend tests with `make test`.

Backend settings come from environment variables or `backend/.env` (see `backend/.env.example`). The frontend API URL is in `frontend/js/config.js`. Add a frontend origin to `CORS_ORIGINS` if it runs on a different port.

## Deploy the backend to Vercel

Create a Vercel project from this repository with **Root Directory `backend`**
and the **FastAPI** framework preset. Leave the build and output directory
settings at their defaults. `app/main.py` exports the application, and
`backend/vercel.json` selects the framework. Python 3.12 is pinned for deployment.
This deploys the API; the frontend remains a separate deployment.
The current backend URL, <https://peterparker-mauve.vercel.app>, returns 404 at `/`
because FastAPI has no homepage route. Its `/api/health` and `/docs` routes are
working. This is a deployment split, not an API startup failure.
See [Vercel's FastAPI guide](https://vercel.com/docs/frameworks/backend/fastapi).

### Deploy the website

Create a **second Vercel project** from this same repository with Root Directory
`frontend`, Framework Preset **Other**, no build command, and output directory `.`.
Open that project's URL for the website. The static frontend uses
`https://peterparker-mauve.vercel.app/api` in production and `http://localhost:8000/api`
locally (configured in `frontend/js/config.js`). On the backend project, set
`CORS_ORIGINS` to a JSON array containing the exact frontend origin, then redeploy.
Set the Supabase Auth Site URL to the frontend URL as well. These are separate
Vercel projects and will have separate default URLs. If a single public domain is
required later, configure routing after both deployments work independently.


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
   To enable account deletion, also set `SUPABASE_SECRET_KEY` in the **backend**
   project's environment. Get a secret key from Supabase Settings → API Keys;
   never put it in the frontend or commit it. Supabase's
   [admin deletion API](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser)
   requires a server-side secret key.
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
Passwords are not migrated. Normal sign-in uses the publishable key. The
separate secret key for account deletion stays only in the backend environment
and is never sent to the browser.

### Local authentication

Opening the app shows a sign-in / sign-up screen. Sign-up asks for a username and
email; sign-in accepts either one in a single "Username or email" field.

Sign-up rules (enforced by the API, mirrored in the UI):

- **Password:** at least 8 characters, one capital letter, one special character.
  The sign-up form shows a checklist that ticks off each rule as you type.
- **Username:** 3-32 characters; special characters are fine, but no spaces or `@`. Accounts, sessions and items
are stored in SQLite (`backend/app.db`, created on first run). Passwords are hashed
with PBKDF2, and the API issues an opaque bearer token; only its hash is stored.

**Remember Me** controls how long the session lasts:

| | Token stored in | Server-side lifetime |
|---|---|---|
| Unchecked | `sessionStorage` (cleared when the browser closes) | `SESSION_HOURS` (default 12) |
| Checked | `localStorage` (survives restarts) | `REMEMBER_ME_DAYS` (default 30) |

Endpoints: `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`,
`GET /api/auth/me`. The `/api/items` routes require a token and are scoped per user.

## Parking map

After signing in, users land on `frontend/map.html`: an OpenStreetMap view of UC Irvine
(via Leaflet). Every parking lot is shaded by category, explained in a key you can minimize:

| Category | Look | How it's decided |
|---|---|---|
| Free | blue area + pin | `fee=no`, open to anyone |
| Permit required | dark-gray area | `access=permit`, a UCI Transportation lot, or an untagged lot on UCI's campus (marked as inferred) |
| Paid | dashed gray outline | `fee=yes` (UCI paid lots also accept permits) |
| Limited / may be towed | light-red area + dot | private, customers-only, time-limited, any University Town Center lot (2-hour limit and tow warning), or untagged off campus |

Every lot's popup lists the named places next to it ("For: Trader Joe's · Target ..."), so
you can see what a lot is for. Limited lots carry a tow/ticket warning.

The side list (Free / Permit / Paid tabs) slides in and out with the tab on its edge.

The search box at the top of the list filters as you type: it matches lot names and the places
each lot serves (case, accents and punctuation are ignored, and words can be in any order).
Matching lots are drawn bold, everything else fades, and the map moves to fit the matches when
you pause. Press Esc or × to clear, or "/" anywhere on the page to jump to the search box.

Under the search box, **filter chips** narrow the map and list: parking type (Free, Permit, Paid,
Limited; pick any combination) and minimum rating (Any, 3+, 4+, 4.5+ stars; unrated lots drop
out). Typing works too: "free parking", "paid lots", "permit", "tow", "4 stars" or
"paid 4+ stars" switch the matching chips on (shown dashed), and any other words still match names.
With a destination picked, the filters also decide which nearby lots are ranked.

**Your location**: the locate button (under the zoom buttons) shows a live blue dot that follows
you; if you've already allowed location for the site it starts on its own. Directions start from
your live position, and "Re-route from where I am" rebuilds the route as you move. Both the list and
the key remember whether they were open.

Use ☆ beside a place or lot to add it to **Saved places**; open that button below
search to revisit saved locations. Focusing the search box shows the last three
places or lots you selected, so you can reopen a recent result. Saved places and
recent selections are kept per account in this browser. They are removed from
this browser when the account is deleted and do not sync across devices.

Lots come from `GET /api/parking`, which serves a snapshot in
`backend/app/data/parking_lots.json`. Refresh it with:

```sh
cd backend && .venv/bin/python scripts/fetch_parking.py
```

## Navigation

Type a building or place into the map's search box (e.g. "Langson Library"): places appear above
matching lots. Pick one (or press Enter for the top match) to drop a destination marker and
highlight the closest usable lots (free, permit or paid), ranked by walking distance; a couple of
nearby tow-risk lots are listed separately. The places come from
`backend/app/data/places.json` (named OpenStreetMap features, written by `scripts/fetch_parking.py`)
and are served at `GET /api/places`.

**Directions** (on each nearby lot, and in every lot's popup) asks the browser for your location
(or, if that's refused, lets you click a starting point on the map), then draws the driving route
to the lot and the walking route from the lot to your destination, with turn-by-turn steps.
Routes come from `GET /api/route?mode=car|foot&from_lat=…&from_lon=…&to_lat=…&to_lon=…`, which
proxies an OSRM server (`ROUTING_URL`, default the free FOSSGIS server at
routing.openstreetmap.de, which is fair-use only; switch to a hosted or self-hosted OSRM before
real traffic). Drive times don't include traffic.

Directions open as a **trip planner** with editable **From** and **To** fields. Each can be your
live location, any searched place or lot, or a point picked on the map; clear either with ×,
swap them with ⇅, or drag the start/destination markers on the map. Every change plans the trip
again: drive From → a parking lot, then walk to To (or just drive, if To is itself a lot). "Park
at" pills offer the closest usable lots to To (respecting the filter chips); click one to route
via it.

## Reviews

Any parking lot or place can be rated 1-5 stars with an optional comment (up to 1,000
characters); each person has one review per lot/place, which they can edit or delete. Ratings
show in lot popups and list items ("★ 4.5 · 3 reviews"), and picking a destination shows a card
inviting you to see or write its reviews (clicking the destination marker opens them too).

Anyone can **reply** to a review (up to 500 characters); replies are threaded under it, oldest
first, and don't affect the rating. You can **delete** your own review or replies from their
card (a second click confirms); deleting a review removes its replies too. Nobody can delete
someone else's posts.

API: `GET /api/reviews?target_type=lot|place&target_id=…` (average, count, newest 50 with author
name and avatar), `PUT /api/reviews` (create or update yours), `DELETE /api/reviews/{id}` (yours
only), `POST /api/reviews/{id}/replies`, `DELETE /api/reviews/replies/{id}` (yours only),
`GET /api/reviews/summary` (average and count for everything reviewed). Lots and places are
identified by their OpenStreetMap id (`way/171169301`). PostgreSQL deployments need
`backend/migrations/003_reviews.sql` and `004_review_replies.sql`.

## Settings

After sign-up, users land on the map and see a guided tour with dashed outlines
around the real search box, parking tabs, color key, nearby lots, directions and
reviews, and Settings. The Student Center example shows nearby lots by walking
distance. Skip closes the tour and leaves the user on the map; the `?` button
replays it. With Supabase email confirmation, the tour appears after the first
successful sign-in in the same browser.

The gear button next to your name on the map opens `frontend/settings.html`, where you can
change your username (`PATCH /api/auth/me`), change your password
(`POST /api/auth/password`, which signs out your other devices), or sign out to switch
accounts. Both changes require your current password. The profile shows your email,
but the app does not offer email changes.

The Delete account section opens a confirmation dialog. “No, keep my account” is
selected by default; deletion requires selecting “Yes, delete my account,” entering
the current password, and pressing the final delete button. `DELETE /api/auth/me`
also requires the exact `YES` confirmation and checks the password. It removes the
profile, sessions, reviews, issue reports, and items. For Supabase accounts, it first deletes the
Supabase Auth user; if the server-side secret key is missing or Auth deletion fails,
the app account is kept and the user sees an error.

Every account has a profile picture: by default a silhouette in a random color on a random
background color of a clearly different hue, assigned the first time the account is shown.
In settings you can upload a photo (cropped to a square and shrunk to 256 px in the browser,
then stored with the account), shuffle the colors, or pick both colors yourself. After
uploading a photo, the color controls give way to a single "Revert to default icon" button
(`PUT`/`DELETE /api/auth/me/avatar`; `PUT` to choose or `POST` to shuffle
`/api/auth/me/avatar/colors`). PostgreSQL deployments need `backend/migrations/002_avatars.sql`
and `003_reviews.sql` applied; `init_db()` runs every migration in order.

## Issue reports and admin board

Signed-in users can open **Report issue** from the map or Settings. The form accepts an issue
type, title, description, and optional place or URL. Users can see the status of their own
reports. Reports are stored in the application database and are removed when their account is
deleted.

The same page shows an **Admin board** only to accounts with `users.is_admin = true`. Admins can
see up to 100 reports, with open reports first and newest first within each status, and mark
each one resolved or reopen it.
The API enforces admin access. New users are never admins by default. To appoint an admin, sign
up and confirm that account first, then run this as the database owner with the intended email:

```sql
UPDATE public.users SET is_admin = TRUE WHERE email = 'admin@example.com';
```

On local SQLite, set `is_admin = 1` in the `users` table instead. Production PostgreSQL must
have [`backend/migrations/005_issue_reports.sql`](backend/migrations/005_issue_reports.sql)
applied before deploying this feature. It creates the private report table and admin flag.
API routes: `POST /api/issues`, `GET /api/issues/mine`, admin-only `GET /api/issues/admin`, and
admin-only `PATCH /api/issues/{id}` with `{"status":"resolved"}` or `{"status":"open"}`.
.