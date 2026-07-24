# StockSoniPower Deployment Notes

This repository contains:

- `backend/`: FastAPI application
- `frontend/`: Create React App application built with CRACO

## Environment files

Use the example files as templates:

- `backend/.env.example`
- `frontend/.env.example`

Required backend variables:

- `MONGO_URL`
- `DB_NAME`
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `CORS_ORIGINS`
- `EMERGENT_LLM_KEY` (optional unless object storage integrations require it)

Required frontend variables:

- `REACT_APP_BACKEND_URL`
- `ENABLE_HEALTH_CHECK`

## Local verification

Backend:

```bash
cd backend
source .venv/bin/activate
uvicorn server:app --host 0.0.0.0 --port 8000
```

Frontend:

```bash
cd frontend
npm ci
npm run build
```

## Render deployment

This repo includes `render.yaml` for a two-service deployment:

1. Backend web service
2. Frontend static site

Backend settings:

- Root Directory: `backend`
- Python Version: `3.11.15`
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn server:app --host 0.0.0.0 --port $PORT`
- Health Check Path: `/health`

Frontend settings:

- Root Directory: `frontend`
- Build Command: `npm ci && npm run build`
- Publish Directory: `build`

## Notes

- Backend CORS origins must include the deployed frontend URL.
- The frontend expects the backend base URL in `REACT_APP_BACKEND_URL`.
- Render should use Python `3.11.15` for the backend service. The repo pins this with `.python-version`, and the blueprint also sets `PYTHON_VERSION`.
- No business logic, API workflows, or database schema changes are required for deployment.
