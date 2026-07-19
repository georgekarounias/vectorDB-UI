import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectVectorDatabase } from "./providerAdapters.ts";

const port = Number(process.env.PORT ?? "8787");
const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));
const indexFilePath = path.join(distDirectory, "index.html");
const shutdownTimeoutMs = 10_000;
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const server = createServer(async (request, response) => {
  setBaseHeaders(response);
  const requestUrl = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/explore") {
    try {
      const body = await readJsonBody(request);
      const databaseUrl =
        typeof body.databaseUrl === "string" ? body.databaseUrl.trim() : "";

      if (!databaseUrl) {
        writeJson(response, 400, {
          message: "A vector database URL is required.",
        });
        return;
      }

      const result = await inspectVectorDatabase(databaseUrl);
      writeJson(response, 200, result);
      return;
    } catch (error) {
      writeJson(response, 502, {
        message:
          error instanceof Error ? error.message : "Unable to load data.",
      });
      return;
    }
  }

  if (
    (request.method === "GET" || request.method === "HEAD") &&
    !requestUrl.pathname.startsWith("/api")
  ) {
    if (await serveFrontendAsset(requestUrl.pathname, request.method, response)) {
      return;
    }
  }

  writeJson(response, 404, { message: "Not found." });
});

server.listen(port, () => {
  console.log(`Vector explorer API listening on http://localhost:${port}`);
});

let isShuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(`Shutting down server after ${signal}.`);

    const forceShutdownTimer = setTimeout(() => {
      console.error("Server shutdown timed out.");
      process.exit(1);
    }, shutdownTimeoutMs);

    forceShutdownTimer.unref();

    server.close((error) => {
      clearTimeout(forceShutdownTimer);

      if (error) {
        console.error("Server shutdown failed.", error);
        process.exit(1);
      }

      process.exit(0);
    });
  });
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Uint8Array[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function setBaseHeaders(response: ServerResponse<IncomingMessage>) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
}

async function serveFrontendAsset(
  pathname: string,
  method: "GET" | "HEAD",
  response: ServerResponse<IncomingMessage>,
) {
  const assetPath = resolveAssetPath(pathname);

  if (assetPath && (await writeFileResponse(assetPath, method, response))) {
    return true;
  }

  if (path.extname(pathname)) {
    return false;
  }

  return writeFileResponse(indexFilePath, method, response);
}

function resolveAssetPath(pathname: string) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolvedPath = path.resolve(distDirectory, relativePath);

  if (!resolvedPath.startsWith(`${distDirectory}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

async function writeFileResponse(
  filePath: string,
  method: "GET" | "HEAD",
  response: ServerResponse<IncomingMessage>,
) {
  try {
    const fileStats = await stat(filePath);

    if (!fileStats.isFile()) {
      return false;
    }

    response.writeHead(200, {
      "Content-Type": getContentType(filePath),
    });

    if (method === "HEAD") {
      response.end();
      return true;
    }

    response.end(await readFile(filePath));
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

function getContentType(filePath: string) {
  return contentTypes[path.extname(filePath)] ?? "application/octet-stream";
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function writeJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}
