import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { inspectVectorDatabase } from './providerAdapters.ts'

const port = Number(process.env.PORT ?? '8787')

const server = createServer(async (request, response) => {
  setBaseHeaders(response)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  if (request.method === 'GET' && request.url === '/api/health') {
    writeJson(response, 200, { status: 'ok' })
    return
  }

  if (request.method === 'POST' && request.url === '/api/explore') {
    try {
      const body = await readJsonBody(request)
      const databaseUrl =
        typeof body.databaseUrl === 'string' ? body.databaseUrl.trim() : ''

      if (!databaseUrl) {
        writeJson(response, 400, {
          message: 'A vector database URL is required.',
        })
        return
      }

      const result = await inspectVectorDatabase(databaseUrl)
      writeJson(response, 200, result)
      return
    } catch (error) {
      writeJson(response, 502, {
        message: error instanceof Error ? error.message : 'Unable to load data.',
      })
      return
    }
  }

  writeJson(response, 404, { message: 'Not found.' })
})

server.listen(port, () => {
  console.log(`Vector explorer API listening on http://localhost:${port}`)
})

async function readJsonBody(request: IncomingMessage) {
  const chunks: Uint8Array[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  const text = Buffer.concat(chunks).toString('utf8')

  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('Request body must be valid JSON.')
  }
}

function setBaseHeaders(response: ServerResponse<IncomingMessage>) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

function writeJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}