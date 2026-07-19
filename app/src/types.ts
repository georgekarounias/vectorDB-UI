export type ProviderName =
  | "Weaviate"
  | "Azure AI Search"
  | "Pinecone"
  | "Pgvector";

export type ProviderKind = "Pgvector" | "Qdrant" | "Weaviate";

export type ConnectionStatus =
  | "Healthy"
  | "Degraded"
  | "Unavailable"
  | "Unknown";

export type FieldKind = "enum" | "number" | "date";

export type SortDirection = "asc" | "desc";

export interface MetadataFieldSchema {
  key: string;
  label: string;
  kind: FieldKind;
  description: string;
  options?: string[];
  showByDefault?: boolean;
}

export interface VectorRecord {
  id: string;
  scope: string;
  content: string;
  contentPreview: string;
  source: {
    id: string;
    name: string;
    version: string;
    location: string;
    chunkIndex: number;
  };
  metadata: Record<string, string | number>;
  updatedAt: string;
  createdAt: string;
  qualityFlags: string[];
  vector: {
    dimensions: number;
    metric: string;
    model: string;
  };
}

export interface ExplorerRecord extends VectorRecord {
  collectionId: string;
  collectionLabel: string;
}

export interface ExplorerResponse {
  provider: ProviderKind;
  databaseUrl: string;
  fields: MetadataFieldSchema[];
  records: ExplorerRecord[];
  warnings: string[];
  sampleLimitPerCollection: number;
  collectionCount: number;
}

export interface CollectionDefinition {
  id: string;
  label: string;
  description: string;
  scope: string;
  status: ConnectionStatus;
  latencyMs: number;
  dimensions: number;
  metric: string;
  model: string;
  fields: MetadataFieldSchema[];
  records: VectorRecord[];
}

export interface ConnectionFormState {
  alias: string;
  provider: ProviderName;
  endpoint: string;
  scope: string;
}

export type EnumFilterState = Record<string, string[]>;

export type RangeFilterState = Record<string, { min: string; max: string }>;
