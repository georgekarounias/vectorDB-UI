# Vector Database UI Prototype

This app uses a small local backend to load live data from an actual vector database instead of reading mock data in the browser.

## Supported providers

- Qdrant
- Weaviate

The backend detects the provider from the URL you enter in the UI and normalizes the returned collections and record previews into one grid shape.

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` starts both services:

- Vite frontend on `http://localhost:5173`
- Local API server on `http://localhost:8787`

## Authentication

Keep provider credentials on the server, not in the browser.

Set one of these environment variables before starting the app when your provider requires authentication:

- `QDRANT_API_KEY`
- `WEAVIATE_API_KEY`

If you are connecting to a local or open instance, you may not need either variable.

## Current behavior

- The top URL box loads live collections and record previews.
- The grid filters run on the records loaded from the provider response.
- The backend currently samples up to `40` records per collection by default.

You can tune sampling with:

- `VECTOR_UI_MAX_COLLECTIONS`
- `VECTOR_UI_SAMPLE_PER_COLLECTION`
