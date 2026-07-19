# Vector Database UI Prototype

This app uses a small local backend to load live data from an actual vector database instead of reading mock data in the browser.

## Supported providers

- Pgvector
- Qdrant
- Weaviate

The backend detects the provider from the URL or connection string you enter in the UI and normalizes the returned collections and record previews into one grid shape.

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` starts both services:

- Vite frontend on `http://localhost:5173`
- Local API server on `http://localhost:8787`

## Run with Docker

Build the image from the workspace root:

```bash
docker build -t vector-db-ui .
```

Run the container and expose the app on port `8787`:

```bash
docker run --rm -p 8787:8787 vector-db-ui
```

The container serves both the React UI and the API from `http://localhost:8787`.

## Authentication

Keep provider credentials on the server, not in the browser.

Set one of these environment variables before starting the app when your provider requires authentication:

- `QDRANT_API_KEY`
- `WEAVIATE_API_KEY`

For pgvector, authentication is provided in the PostgreSQL connection string itself, for example:

- `postgresql://user:password@localhost:5432/my_database`

If you are connecting to a local or open Qdrant or Weaviate instance, you may not need either environment variable.

## Current behavior

- The top input accepts either a provider URL or a PostgreSQL connection string.
- The grid filters run on the records loaded from the provider response.
- The backend currently samples up to `40` records per collection by default.

You can tune sampling with:

- `VECTOR_UI_MAX_COLLECTIONS`
- `VECTOR_UI_SAMPLE_PER_COLLECTION`
