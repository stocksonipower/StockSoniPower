# Environment Variables

Actual secret values were never read or recorded during this research pass — only variable names, formats, and purpose. Set real values in `backend/.env` / `frontend/.env` locally, and in Render's dashboard (`sync: false` in `render.yaml`) for deployment.

## Backend (`backend/.env`, mirrored in `render.yaml`)

| Variable | Purpose |
|---|---|
| `MONGO_URL` | MongoDB connection string (Atlas SRV format: `mongodb+srv://<user>:<pass>@<cluster>/<db>?retryWrites=true&w=majority`). Required — app fails to start without it. |
| `DB_NAME` | Target MongoDB database name. Default in `render.yaml`: `stock_management`. Required. |
| `JWT_SECRET` | HMAC signing secret for JWT access tokens (HS256). Required. |
| `ADMIN_EMAIL` | Seed email for the bootstrap admin account, created/re-synced on every startup. Default `admin@stockmgmt.com` if unset. |
| `ADMIN_PASSWORD` | Seed password for the bootstrap admin account. **Re-applied on every restart** if the stored hash drifts — see [AUTHENTICATION.md](AUTHENTICATION.md). Default `admin123` if unset. |
| `CORS_ORIGINS` | Comma-separated list of allowed origins for CORS. Must include the deployed frontend's URL. Defaults to `*` if unset (permissive — tighten for production). |
| `EMERGENT_LLM_KEY` | Key exchanged for a storage token with Emergent's object-storage service (image upload/serving). Required for image features to function; other init is best-effort at startup. |
| `PYTHON_VERSION` | Build-time only (Render), pins the Python runtime — `3.11.15` per `render.yaml`/`.python-version`. Not read by the app itself. |

## Frontend (`frontend/.env`)

| Variable | Purpose |
|---|---|
| `REACT_APP_BACKEND_URL` | Base URL of the backend API; the app appends `/api` to it (`lib/api.js`). Defaults to `http://localhost:8000` if unset. Must point at the deployed backend service in production. |
| `ENABLE_HEALTH_CHECK` | `"true"`/`"false"`. Toggles the custom CRACO/webpack dev-server health-check plugin (`frontend/plugins/health-check/`). Set to `"false"` in production static builds — it's a dev-server-only feature, unrelated to the backend's own `/health` endpoint. |

## Notes

- No `.env` files are committed with real values — only `.env.example` templates exist in the repo, and both `frontend/.env`/`backend/.env` are present locally but were not read for this documentation pass.
- CORS is entirely env-driven — there is no hardcoded origin allowlist in code; misconfiguring `CORS_ORIGINS` after a frontend URL change is a common deployment failure mode (see recent git history: multiple "deploy fix"/"Frontend fix" commits).
- There is no `.env` variable controlling JWT expiry, lockout thresholds, or object-storage bucket name — these are hardcoded constants in `deps.py`/`storage.py` (see [AUTHENTICATION.md](AUTHENTICATION.md) and [BACKEND.md](BACKEND.md)).

See [DEPLOYMENT.md](DEPLOYMENT.md) for how these variables map onto the two Render services.
