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

## Existing authentication

The current scaffold requires sign-in to reach its Items screen. Sign-up collects a username and email; sign-in accepts either. Passwords need at least eight characters, one capital letter, and one special character. `Remember Me` stores the token in `localStorage` for the configured long session; otherwise it uses `sessionStorage`. The API exposes `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me`.
