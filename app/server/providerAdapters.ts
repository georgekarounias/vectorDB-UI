import { Client } from "pg";
import type {
  ExplorerRecord,
  ExplorerResponse,
  FieldKind,
  MetadataFieldSchema,
} from "../src/types.ts";

const MAX_COLLECTIONS = Number(process.env.VECTOR_UI_MAX_COLLECTIONS ?? "8");
const RECORDS_PER_COLLECTION = Number(
  process.env.VECTOR_UI_SAMPLE_PER_COLLECTION ?? "40",
);
const MAX_ENUM_OPTIONS = 18;
const PGVECTOR_TYPE_NAMES = ["vector", "halfvec", "sparsevec"];
const PGVECTOR_ID_KEYS = [
  "id",
  "uuid",
  "recordId",
  "chunkId",
  "documentId",
  "itemId",
  "sourceId",
];
const PGVECTOR_SCOPE_KEYS = [
  "scope",
  "tenant",
  "namespace",
  "projectId",
  "project_id",
  "customerId",
  "customer_id",
];

const WEAVIATE_PRIMITIVE_TYPES = new Set([
  "text",
  "text[]",
  "string",
  "string[]",
  "int",
  "int[]",
  "number",
  "number[]",
  "boolean",
  "boolean[]",
  "date",
  "date[]",
  "uuid",
  "uuid[]",
]);

type QdrantCollectionsResponse = {
  result?: {
    collections?: Array<{ name?: string }>;
  };
};

type QdrantCollectionInfoResponse = {
  result?: {
    config?: {
      params?: {
        vectors?:
          | {
              size?: number;
              distance?: string;
            }
          | Record<
              string,
              {
                size?: number;
                distance?: string;
              }
            >;
      };
    };
  };
};

type QdrantScrollResponse = {
  result?: {
    points?: Array<{
      id?: string | number;
      payload?: Record<string, unknown>;
      shard_key?: string | number;
    }>;
  };
};

type WeaviateSchemaResponse = {
  classes?: Array<{
    class?: string;
    multiTenancyConfig?: {
      enabled?: boolean;
    };
    vectorizer?: string;
    vectorIndexConfig?: {
      distance?: string;
    };
    properties?: Array<{
      name?: string;
      dataType?: string[];
    }>;
  }>;
};

type WeaviateGraphQlResponse = {
  data?: {
    Get?: Record<string, Array<Record<string, unknown>>>;
  };
  errors?: Array<{
    message?: string;
  }>;
};

type WeaviateTenantListResponse = Array<{
  activityStatus?: string;
  name?: string;
}>;

type PgvectorExtensionRow = {
  extversion: string;
};

type PgvectorColumnRow = {
  schema_name: string;
  table_name: string;
  vector_column: string;
  vector_type_name: string;
  vector_type: string;
};

type PgvectorSampleRow = {
  row_pointer: string;
  payload: Record<string, unknown> | null;
};

type PgvectorTableInfo = {
  schemaName: string;
  tableName: string;
  vectorColumns: string[];
  vectorTypeNames: string[];
  vectorTypes: string[];
  dimensions: Array<number | null>;
};

export async function inspectVectorDatabase(
  databaseUrl: string,
): Promise<ExplorerResponse> {
  const normalizedUrl = normalizeDatabaseUrl(databaseUrl);

  if (isPgvectorConnectionString(normalizedUrl)) {
    return inspectPgvector(normalizedUrl);
  }

  const failures: string[] = [];

  try {
    return await inspectQdrant(normalizedUrl);
  } catch (error) {
    failures.push(`Qdrant: ${getErrorMessage(error)}`);
  }

  try {
    return await inspectWeaviate(normalizedUrl);
  } catch (error) {
    failures.push(`Weaviate: ${getErrorMessage(error)}`);
  }

  throw new Error(
    `Unable to load records from the supplied URL. ${failures.join(" | ")}`,
  );
}

function normalizeDatabaseUrl(databaseUrl: string) {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error(
      "Enter a valid vector database URL or PostgreSQL connection string.",
    );
  }

  if (isPgvectorProtocol(parsedUrl.protocol)) {
    return parsedUrl.toString();
  }

  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
  return parsedUrl.toString().replace(/\/+$/, "");
}

function isPgvectorProtocol(protocol: string) {
  return protocol === "postgres:" || protocol === "postgresql:";
}

function isPgvectorConnectionString(databaseUrl: string) {
  return isPgvectorProtocol(new URL(databaseUrl).protocol);
}

async function inspectPgvector(databaseUrl: string): Promise<ExplorerResponse> {
  const client = new Client({
    connectionString: databaseUrl,
  });

  let isConnected = false;

  try {
    await client.connect();
    isConnected = true;

    const extensionVersion = await getPgvectorExtensionVersion(client);
    const pgvectorColumns = await listPgvectorColumns(client);

    if (!pgvectorColumns.length) {
      if (!extensionVersion) {
        throw new Error(
          "This PostgreSQL database does not have the pgvector extension installed.",
        );
      }

      throw new Error(
        "The PostgreSQL database has pgvector installed, but no vector-bearing tables were found.",
      );
    }

    const discoveredTables = groupPgvectorColumns(pgvectorColumns);
    const tableInfos = discoveredTables.slice(0, MAX_COLLECTIONS);
    const records: ExplorerRecord[] = [];
    const warnings = [
      `Loaded up to ${RECORDS_PER_COLLECTION} rows per table from the live pgvector database.`,
      "PostgreSQL authentication is handled through the connection string itself.",
      extensionVersion
        ? `Detected pgvector extension version ${extensionVersion}.`
        : "Detected vector-bearing tables through PostgreSQL system catalogs.",
    ];

    if (discoveredTables.length > tableInfos.length) {
      warnings.push(
        `Showing the first ${tableInfos.length} pgvector tables out of ${discoveredTables.length} discovered tables.`,
      );
    }

    for (const tableInfo of tableInfos) {
      const collectionLabel = getPgvectorCollectionLabel(
        tableInfo.schemaName,
        tableInfo.tableName,
      );
      const primaryVectorColumn = tableInfo.vectorColumns[0] ?? "embedding";
      const primaryVectorType = tableInfo.vectorTypes[0] ?? "vector";
      const primaryDimensions = tableInfo.dimensions[0] ?? 0;
      const sampleRows = await listPgvectorSampleRows(client, tableInfo);

      if (tableInfo.vectorColumns.length > 1) {
        warnings.push(
          `Table ${collectionLabel} has ${tableInfo.vectorColumns.length} vector columns; the explorer samples shared rows and summarizes the first vector column in the grid.`,
        );
      }

      if (!sampleRows.length) {
        warnings.push(
          `Table ${collectionLabel} contains vector columns but no sample rows were returned.`,
        );
        continue;
      }

      for (const [rowIndex, row] of sampleRows.entries()) {
        const payload = isPlainObject(row.payload) ? row.payload : {};
        const enrichedPayload = createPgvectorPayload(
          payload,
          row.row_pointer,
          tableInfo,
          primaryVectorColumn,
          primaryVectorType,
          primaryDimensions,
        );
        const recordId = getPgvectorRecordId(
          enrichedPayload,
          row.row_pointer,
          collectionLabel,
          rowIndex + 1,
        );

        records.push(
          createRecordFromPayload({
            collectionId: collectionLabel,
            collectionLabel,
            recordId,
            payload: enrichedPayload,
            scope: getPgvectorScope(enrichedPayload, tableInfo.schemaName),
            vector: {
              dimensions: primaryDimensions,
              metric: "Unknown",
              model: primaryVectorColumn,
            },
            createdAt:
              findTimestamp(enrichedPayload, [
                "createdAt",
                "created_at",
                "insertedAt",
                "inserted_at",
              ]) ?? "",
            updatedAt:
              findTimestamp(enrichedPayload, [
                "updatedAt",
                "updated_at",
                "modifiedAt",
                "modified_at",
                "lastUpdatedAt",
                "last_updated_at",
                "createdAt",
                "created_at",
              ]) ?? "",
          }),
        );
      }
    }

    return {
      provider: "Pgvector",
      databaseUrl,
      fields: buildFieldSchema(records),
      records,
      warnings,
      sampleLimitPerCollection: RECORDS_PER_COLLECTION,
      collectionCount: tableInfos.length,
    };
  } catch (error) {
    throw new Error(`Unable to inspect pgvector data: ${getErrorMessage(error)}`, {
      cause: error,
    });
  } finally {
    if (isConnected) {
      await client.end();
    }
  }
}

async function inspectQdrant(databaseUrl: string): Promise<ExplorerResponse> {
  const collectionsResponse = await fetchJson<QdrantCollectionsResponse>(
    `${databaseUrl}/collections`,
    {
      headers: getQdrantHeaders(),
    },
  );

  const collectionNames = (collectionsResponse.result?.collections ?? [])
    .map((collection) => collection.name)
    .filter((name): name is string => Boolean(name))
    .slice(0, MAX_COLLECTIONS);

  if (!collectionNames.length) {
    throw new Error("The Qdrant instance returned no collections.");
  }

  const records: ExplorerRecord[] = [];

  for (const collectionName of collectionNames) {
    const [collectionInfo, collectionPoints] = await Promise.all([
      fetchJson<QdrantCollectionInfoResponse>(
        `${databaseUrl}/collections/${encodeURIComponent(collectionName)}`,
        {
          headers: getQdrantHeaders(),
        },
      ),
      fetchJson<QdrantScrollResponse>(
        `${databaseUrl}/collections/${encodeURIComponent(collectionName)}/points/scroll`,
        {
          method: "POST",
          headers: {
            ...getQdrantHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            limit: RECORDS_PER_COLLECTION,
            with_payload: true,
            with_vector: false,
          }),
        },
      ),
    ]);

    const vectorShape = getQdrantVectorShape(collectionInfo);

    for (const point of collectionPoints.result?.points ?? []) {
      const payload = point.payload ?? {};

      records.push(
        createRecordFromPayload({
          collectionId: collectionName,
          collectionLabel: collectionName,
          recordId: String(
            point.id ?? `${collectionName}-${records.length + 1}`,
          ),
          payload,
          scope:
            toSingleString(payload.scope) ??
            toSingleString(payload.tenant) ??
            toSingleString(point.shard_key) ??
            "default",
          vector: {
            dimensions: vectorShape.dimensions,
            metric: vectorShape.metric,
            model:
              toSingleString(payload.embeddingModel) ??
              toSingleString(payload.model) ??
              "Unknown",
          },
          createdAt: findTimestamp(payload, ["createdAt", "created_at"]) ?? "",
          updatedAt:
            findTimestamp(payload, [
              "updatedAt",
              "updated_at",
              "lastUpdatedAt",
              "last_update_time",
              "embeddedOn",
            ]) ??
            findTimestamp(payload, ["createdAt", "created_at"]) ??
            "",
        }),
      );
    }
  }

  return {
    provider: "Qdrant",
    databaseUrl,
    fields: buildFieldSchema(records),
    records,
    warnings: [
      `Loaded up to ${RECORDS_PER_COLLECTION} points per collection from the live Qdrant instance.`,
      process.env.QDRANT_API_KEY
        ? "Qdrant API requests are authorized through the server environment."
        : "No Qdrant API key is configured on the server. This works only for open or local instances.",
    ],
    sampleLimitPerCollection: RECORDS_PER_COLLECTION,
    collectionCount: collectionNames.length,
  };
}

async function inspectWeaviate(databaseUrl: string): Promise<ExplorerResponse> {
  const weaviateBaseUrl = getWeaviateBaseUrl(databaseUrl);
  const schema = await fetchJson<WeaviateSchemaResponse>(
    `${weaviateBaseUrl}/schema`,
    {
      headers: getWeaviateHeaders(),
    },
  );

  const classes = (schema.classes ?? [])
    .filter((entry) => Boolean(entry.class))
    .slice(0, MAX_COLLECTIONS);

  if (!classes.length) {
    throw new Error(
      "The Weaviate instance returned no collections in /v1/schema.",
    );
  }

  const records: ExplorerRecord[] = [];
  const warnings = [
    `Loaded up to ${RECORDS_PER_COLLECTION} objects per collection from the live Weaviate instance.`,
    process.env.WEAVIATE_API_KEY
      ? "Weaviate API requests are authorized through the server environment."
      : "No Weaviate API key is configured on the server. This works only for open or local instances.",
  ];

  for (const classConfig of classes) {
    const className = classConfig.class ?? "Collection";
    const propertyNames = getWeaviatePrimitivePropertyNames(
      classConfig.properties ?? [],
    );
    const tenantPlans = classConfig.multiTenancyConfig?.enabled
      ? createWeaviateTenantPlans(
          await listWeaviateTenantNames(weaviateBaseUrl, className),
          RECORDS_PER_COLLECTION,
        )
      : [{ tenantName: null, limit: RECORDS_PER_COLLECTION }];

    if (classConfig.multiTenancyConfig?.enabled && !tenantPlans.length) {
      warnings.push(
        `Collection ${className} has multi-tenancy enabled, but no tenants were returned by Weaviate.`,
      );
      continue;
    }

    if (classConfig.multiTenancyConfig?.enabled) {
      warnings.push(
        `Collection ${className} loaded tenant-scoped records from ${tenantPlans.length} tenants.`,
      );
    }

    for (const tenantPlan of tenantPlans) {
      const query = buildWeaviateListQuery(
        className,
        propertyNames,
        tenantPlan.limit,
        tenantPlan.tenantName,
      );
      const graphQlResponse = await fetchJson<WeaviateGraphQlResponse>(
        `${weaviateBaseUrl}/graphql`,
        {
          method: "POST",
          headers: {
            ...getWeaviateHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        },
      );

      const graphQlError = getWeaviateGraphQlErrorMessage(graphQlResponse);
      if (graphQlError) {
        throw new Error(
          `Weaviate query failed for ${className}: ${graphQlError}`,
        );
      }

      const objects = graphQlResponse.data?.Get?.[className] ?? [];

      for (const object of objects) {
        const additional = isPlainObject(object._additional)
          ? object._additional
          : {};
        const payload = { ...object };
        delete payload._additional;

        records.push(
          createRecordFromPayload({
            collectionId: className,
            collectionLabel: className,
            recordId:
              toSingleString(additional.id) ??
              toSingleString(payload.id) ??
              `${className}-${records.length + 1}`,
            payload,
            scope:
              toSingleString(payload.scope) ??
              toSingleString(payload.tenant) ??
              tenantPlan.tenantName ??
              "default",
            vector: {
              dimensions: 0,
              metric:
                toSingleString(classConfig.vectorIndexConfig?.distance) ??
                "Unknown",
              model: classConfig.vectorizer ?? "Unknown",
            },
            createdAt: unixToIso(additional.creationTimeUnix) ?? "",
            updatedAt:
              unixToIso(additional.lastUpdateTimeUnix) ??
              unixToIso(additional.creationTimeUnix) ??
              "",
          }),
        );
      }
    }
  }

  return {
    provider: "Weaviate",
    databaseUrl,
    fields: buildFieldSchema(records),
    records,
    warnings,
    sampleLimitPerCollection: RECORDS_PER_COLLECTION,
    collectionCount: classes.length,
  };
}

async function getPgvectorExtensionVersion(client: Client) {
  const result = await client.query<PgvectorExtensionRow>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1",
  );

  return result.rows[0]?.extversion ?? null;
}

async function listPgvectorColumns(client: Client) {
  const result = await client.query<PgvectorColumnRow>(
    `SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        a.attname AS vector_column,
        t.typname AS vector_type_name,
        format_type(a.atttypid, a.atttypmod) AS vector_type
      FROM pg_attribute AS a
      JOIN pg_class AS c ON c.oid = a.attrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      JOIN pg_type AS t ON t.oid = a.atttypid
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND t.typname = ANY($1::text[])
      ORDER BY n.nspname, c.relname, a.attnum`,
    [PGVECTOR_TYPE_NAMES],
  );

  return result.rows;
}

function groupPgvectorColumns(rows: PgvectorColumnRow[]) {
  const tables = new Map<string, PgvectorTableInfo>();

  for (const row of rows) {
    const key = `${row.schema_name}.${row.table_name}`;
    const currentTable = tables.get(key) ?? {
      schemaName: row.schema_name,
      tableName: row.table_name,
      vectorColumns: [],
      vectorTypeNames: [],
      vectorTypes: [],
      dimensions: [],
    };

    currentTable.vectorColumns.push(row.vector_column);
    currentTable.vectorTypeNames.push(row.vector_type_name);
    currentTable.vectorTypes.push(row.vector_type);
    currentTable.dimensions.push(getPgvectorDimensions(row.vector_type));
    tables.set(key, currentTable);
  }

  return [...tables.values()];
}

function getPgvectorDimensions(vectorType: string) {
  const match = vectorType.match(/\((\d+)\)$/);
  return match ? Number(match[1]) : null;
}

function getPgvectorCollectionLabel(schemaName: string, tableName: string) {
  return schemaName === "public" ? tableName : `${schemaName}.${tableName}`;
}

async function listPgvectorSampleRows(client: Client, tableInfo: PgvectorTableInfo) {
  const sql = `SELECT
      ctid::text AS row_pointer,
      to_jsonb(sample_row) - $1::text[] AS payload
    FROM ${quoteIdentifier(tableInfo.schemaName)}.${quoteIdentifier(tableInfo.tableName)} AS sample_row
    LIMIT $2`;

  const result = await client.query<PgvectorSampleRow>(sql, [
    tableInfo.vectorColumns,
    RECORDS_PER_COLLECTION,
  ]);

  return result.rows;
}

function createPgvectorPayload(
  payload: Record<string, unknown>,
  rowPointer: string,
  tableInfo: PgvectorTableInfo,
  vectorColumn: string,
  vectorType: string,
  vectorDimensions: number,
) {
  return {
    ...payload,
    location: toSingleString(payload.location) ?? rowPointer,
    sourceName:
      toSingleString(payload.sourceName) ??
      getPgvectorCollectionLabel(tableInfo.schemaName, tableInfo.tableName),
    tableSchema: tableInfo.schemaName,
    tableName: tableInfo.tableName,
    vectorColumn,
    vectorType,
    vectorDimensions: vectorDimensions > 0 ? vectorDimensions : undefined,
    rowPointer,
  };
}

function getPgvectorScope(payload: Record<string, unknown>, schemaName: string) {
  for (const key of PGVECTOR_SCOPE_KEYS) {
    const scopeValue = toSingleString(payload[key]);
    if (scopeValue) {
      return scopeValue;
    }
  }

  return schemaName || "public";
}

function getPgvectorRecordId(
  payload: Record<string, unknown>,
  rowPointer: string,
  collectionLabel: string,
  rowNumber: number,
) {
  for (const key of PGVECTOR_ID_KEYS) {
    const recordId = toSingleString(payload[key]);
    if (recordId) {
      return recordId;
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    if (/id$/i.test(key)) {
      const recordId = toSingleString(value);
      if (recordId) {
        return recordId;
      }
    }
  }

  return rowPointer || `${collectionLabel}-${rowNumber}`;
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function getWeaviateBaseUrl(databaseUrl: string) {
  return databaseUrl.endsWith("/v1") ? databaseUrl : `${databaseUrl}/v1`;
}

function getQdrantHeaders() {
  return process.env.QDRANT_API_KEY
    ? { "api-key": process.env.QDRANT_API_KEY }
    : {};
}

function getWeaviateHeaders() {
  return process.env.WEAVIATE_API_KEY
    ? { Authorization: `Bearer ${process.env.WEAVIATE_API_KEY}` }
    : {};
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`Request failed for ${url}: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }

  const text = await response.text();
  const data = tryParseJson(text);

  if (!response.ok) {
    const message =
      extractRemoteErrorMessage(data) ?? text ?? response.statusText;
    throw new Error(`${response.status} ${response.statusText}: ${message}`);
  }

  return data as T;
}

function tryParseJson(value: string) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function extractRemoteErrorMessage(data: unknown) {
  if (typeof data === "string") {
    return data;
  }

  if (!isPlainObject(data)) {
    return null;
  }

  const directMessage = toSingleString(data.message);
  if (directMessage) {
    return directMessage;
  }

  if (Array.isArray(data.error) && data.error.length > 0) {
    const firstError = data.error[0];
    if (isPlainObject(firstError)) {
      return toSingleString(firstError.message);
    }
  }

  return null;
}

function getQdrantVectorShape(collectionInfo: QdrantCollectionInfoResponse) {
  const vectors = collectionInfo.result?.config?.params?.vectors;

  if (!vectors) {
    return { dimensions: 0, metric: "Unknown" };
  }

  if ("size" in vectors) {
    return {
      dimensions: Number(vectors.size ?? 0),
      metric: toSingleString(vectors.distance) ?? "Unknown",
    };
  }

  const firstVector = Object.values(vectors)[0];

  return {
    dimensions: Number(firstVector?.size ?? 0),
    metric: toSingleString(firstVector?.distance) ?? "Unknown",
  };
}

function getWeaviatePrimitivePropertyNames(
  properties: Array<{ name?: string; dataType?: string[] }>,
) {
  return properties
    .filter((property) => {
      const propertyName = property.name ?? "";
      const typeNames = (property.dataType ?? []).map((typeName) =>
        typeName.toLowerCase(),
      );

      return (
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(propertyName) &&
        typeNames.some((typeName) => WEAVIATE_PRIMITIVE_TYPES.has(typeName))
      );
    })
    .map((property) => property.name ?? "");
}

async function listWeaviateTenantNames(
  weaviateBaseUrl: string,
  className: string,
) {
  const tenants = await fetchJson<WeaviateTenantListResponse>(
    `${weaviateBaseUrl}/schema/${encodeURIComponent(className)}/tenants`,
    {
      headers: getWeaviateHeaders(),
    },
  );

  return tenants
    .map((tenant) => tenant.name)
    .filter((tenantName): tenantName is string => Boolean(tenantName));
}

function createWeaviateTenantPlans(tenantNames: string[], totalLimit: number) {
  const limitedTenantNames = tenantNames.slice(0, totalLimit);

  if (!limitedTenantNames.length) {
    return [];
  }

  const baseLimit = Math.floor(totalLimit / limitedTenantNames.length);
  let remainder = totalLimit % limitedTenantNames.length;

  return limitedTenantNames
    .map((tenantName) => {
      const limit = baseLimit + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);

      return {
        tenantName,
        limit,
      };
    })
    .filter((plan) => plan.limit > 0);
}

function buildWeaviateListQuery(
  className: string,
  propertyNames: string[],
  limit: number,
  tenantName: string | null,
) {
  const propertySelection = propertyNames
    .map((propertyName) => `        ${propertyName}`)
    .join("\n");
  const tenantClause = tenantName
    ? `, tenant: ${JSON.stringify(tenantName)}`
    : "";

  return `{
  Get {
    ${className}(limit: ${limit}${tenantClause}) {
${propertySelection ? `${propertySelection}\n` : ""}      _additional {
        id
        creationTimeUnix
        lastUpdateTimeUnix
      }
    }
  }
}`;
}

function getWeaviateGraphQlErrorMessage(response: WeaviateGraphQlResponse) {
  const messages = (response.errors ?? [])
    .map((error) => toSingleString(error.message))
    .filter((message): message is string => Boolean(message));

  return messages.length ? messages.join(" | ") : null;
}

function createRecordFromPayload(input: {
  collectionId: string;
  collectionLabel: string;
  recordId: string;
  payload: Record<string, unknown>;
  scope: string;
  vector: {
    dimensions: number;
    metric: string;
    model: string;
  };
  createdAt: string;
  updatedAt: string;
}): ExplorerRecord {
  const contentField = findPrimaryContentField(input.payload);
  const content = contentField.value;
  const metadata = createMetadata(input.payload, contentField.key, {
    collection: input.collectionLabel,
    scope: input.scope,
  });
  const sourceName =
    toSingleString(input.payload.sourceName) ??
    toSingleString(input.payload.documentName) ??
    toSingleString(input.payload.title) ??
    toSingleString(input.payload.name) ??
    input.collectionLabel;
  const sourceLocation =
    toSingleString(input.payload.location) ??
    toSingleString(input.payload.page) ??
    toSingleString(input.payload.section) ??
    "—";
  const chunkIndex = toFiniteNumber(input.payload.chunkIndex) ?? 0;

  return {
    id: input.recordId,
    scope: input.scope,
    content,
    contentPreview: buildPreview(content),
    source: {
      id:
        toSingleString(input.payload.sourceId) ??
        toSingleString(input.payload.documentId) ??
        input.recordId,
      name: sourceName,
      version:
        toSingleString(input.payload.version) ??
        toSingleString(input.payload.documentVersion) ??
        "—",
      location: sourceLocation,
      chunkIndex,
    },
    metadata,
    updatedAt: input.updatedAt,
    createdAt: input.createdAt,
    qualityFlags: [],
    vector: input.vector,
    collectionId: input.collectionId,
    collectionLabel: input.collectionLabel,
  };
}

function findPrimaryContentField(payload: Record<string, unknown>) {
  const preferredKeys = [
    "content",
    "text",
    "body",
    "chunk",
    "chunkText",
    "pageContent",
    "description",
    "summary",
  ];

  for (const key of preferredKeys) {
    const value = toSingleString(payload[key]);
    if (value && value.length > 20) {
      return { key, value };
    }
  }

  let bestKey = "content";
  let bestValue = "";

  for (const [key, rawValue] of Object.entries(payload)) {
    const value = toSingleString(rawValue);
    if (value && value.length > bestValue.length) {
      bestKey = key;
      bestValue = value;
    }
  }

  if (bestValue) {
    return { key: bestKey, value: bestValue };
  }

  return {
    key: "content",
    value: `Record ${toSingleString(payload.id) ?? "without textual content"}`,
  };
}

function createMetadata(
  payload: Record<string, unknown>,
  excludedKey: string,
  extraFields: Record<string, string | number>,
) {
  const metadata: Record<string, string | number> = { ...extraFields };

  for (const [key, rawValue] of Object.entries(payload)) {
    if (key === excludedKey) {
      continue;
    }

    const normalizedValue = normalizeMetadataValue(rawValue);
    if (normalizedValue === undefined) {
      continue;
    }

    metadata[key] = normalizedValue;
  }

  return metadata;
}

function normalizeMetadataValue(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 140) {
      return undefined;
    }

    return trimmed;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => toSingleString(item))
      .filter((item): item is string => Boolean(item));

    if (!parts.length) {
      return undefined;
    }

    return parts.slice(0, 6).join(", ");
  }

  return undefined;
}

function buildPreview(content: string) {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 120) {
    return collapsed;
  }

  return `${collapsed.slice(0, 117)}...`;
}

function buildFieldSchema(records: ExplorerRecord[]): MetadataFieldSchema[] {
  const valuesByKey = new Map<string, Array<string | number>>();

  for (const record of records) {
    for (const [key, value] of Object.entries(record.metadata)) {
      const currentValues = valuesByKey.get(key) ?? [];
      currentValues.push(value);
      valuesByKey.set(key, currentValues);
    }
  }

  return [...valuesByKey.entries()]
    .map(([key, values]) => {
      const uniqueValues = [...new Set(values)];
      const kind = inferFieldKind(uniqueValues);

      return {
        key,
        label: humanizeKey(key),
        kind,
        description: `${humanizeKey(key)} extracted from the live provider response.`,
        options:
          kind === "enum"
            ? uniqueValues
                .map((value) => String(value))
                .sort((left, right) => left.localeCompare(right))
                .slice(0, MAX_ENUM_OPTIONS)
            : undefined,
        showByDefault: false,
      } satisfies MetadataFieldSchema;
    })
    .sort(
      (left, right) => getFieldPriority(left.key) - getFieldPriority(right.key),
    )
    .map((field, index) => ({
      ...field,
      showByDefault:
        index < 4 || field.key === "collection" || field.key === "scope",
    }));
}

function inferFieldKind(values: Array<string | number>): FieldKind {
  if (values.length > 0 && values.every((value) => typeof value === "number")) {
    return "number";
  }

  const stringValues = values.map((value) => String(value));

  if (
    stringValues.length > 0 &&
    stringValues.every(
      (value) =>
        /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) &&
        !Number.isNaN(Date.parse(value)),
    )
  ) {
    return "date";
  }

  return "enum";
}

function getFieldPriority(key: string) {
  const priorityKeys = [
    "collection",
    "scope",
    "documentType",
    "ownerTeam",
    "region",
  ];
  const priorityIndex = priorityKeys.indexOf(key);

  return priorityIndex === -1
    ? priorityKeys.length + key.length
    : priorityIndex;
}

function humanizeKey(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function findTimestamp(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const timestamp = valueToIso(payload[key]);
    if (timestamp) {
      return timestamp;
    }
  }

  return null;
}

function unixToIso(value: unknown) {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return new Date(numericValue).toISOString();
    }
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value).toISOString();
}

function valueToIso(value: unknown) {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }

  return null;
}

function toSingleString(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return null;
}

function toFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}
