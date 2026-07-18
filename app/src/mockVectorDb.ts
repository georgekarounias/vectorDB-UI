import type {
  CollectionDefinition,
  MetadataFieldSchema,
  ProviderName,
  VectorRecord,
} from './types'

export const providerOptions: ProviderName[] = [
  'Weaviate',
  'Azure AI Search',
  'Pinecone',
]

const dayAsIso = (daysAgo: number) => {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - daysAgo)
  return date.toISOString()
}

const dateOnly = (daysAgo: number) => dayAsIso(daysAgo).slice(0, 10)

const summarizeContent = (content: string) => `${content.slice(0, 108).trimEnd()}...`

const engineeringFields: MetadataFieldSchema[] = [
  {
    key: 'documentType',
    label: 'Document type',
    kind: 'enum',
    options: ['Requirements', 'Runbook', 'Incident Review', 'Architecture Note'],
    description: 'High-level source category.',
    showByDefault: true,
  },
  {
    key: 'ownerTeam',
    label: 'Owner team',
    kind: 'enum',
    options: ['Platform', 'Search', 'Delivery', 'Security'],
    description: 'Primary team responsible for the source.',
    showByDefault: true,
  },
  {
    key: 'language',
    label: 'Language',
    kind: 'enum',
    options: ['en', 'de', 'fr'],
    description: 'Language captured for the stored record.',
  },
  {
    key: 'freshnessDays',
    label: 'Freshness days',
    kind: 'number',
    description: 'Days since the record was last embedded.',
    showByDefault: true,
  },
  {
    key: 'embeddedOn',
    label: 'Embedded on',
    kind: 'date',
    description: 'Last embedding date for the record.',
    showByDefault: true,
  },
]

const supportFields: MetadataFieldSchema[] = [
  {
    key: 'severity',
    label: 'Severity',
    kind: 'enum',
    options: ['S1', 'S2', 'S3'],
    description: 'Escalation severity used by support.',
    showByDefault: true,
  },
  {
    key: 'productArea',
    label: 'Product area',
    kind: 'enum',
    options: ['Search', 'Ingestion', 'Permissions', 'Analytics'],
    description: 'Primary product area mentioned in the case.',
    showByDefault: true,
  },
  {
    key: 'region',
    label: 'Region',
    kind: 'enum',
    options: ['US', 'EU', 'APAC'],
    description: 'Region where the customer issue originated.',
    showByDefault: true,
  },
  {
    key: 'freshnessDays',
    label: 'Freshness days',
    kind: 'number',
    description: 'Days since the case text was re-embedded.',
  },
  {
    key: 'embeddedOn',
    label: 'Embedded on',
    kind: 'date',
    description: 'Date when the vector was last refreshed.',
    showByDefault: true,
  },
]

const engineeringRecords = Array.from({ length: 58 }, (_, index) => {
  const item = index + 1
  const documentTypes = engineeringFields[0].options ?? []
  const ownerTeams = engineeringFields[1].options ?? []
  const languages = engineeringFields[2].options ?? []
  const documentType = documentTypes[index % documentTypes.length]
  const ownerTeam = ownerTeams[(index + 1) % ownerTeams.length]
  const language = languages[index % languages.length]
  const freshnessDays = (index * 3) % 28 + 1
  const embeddedOn = dateOnly(freshnessDays)
  const sourceName = `${documentType.toLowerCase().replace(/\s+/g, '-')}-${item}.md`
  const content = `This ${documentType.toLowerCase()} captures vector retrieval behavior for ${ownerTeam.toLowerCase()} workflows. It explains scope boundaries, observed failure modes, and the evidence operators should inspect before trusting a retrieval result in project-42.`

  return {
    id: `eng-${item.toString().padStart(3, '0')}`,
    scope: 'project-42',
    content,
    contentPreview: summarizeContent(content),
    source: {
      id: `doc-${item.toString().padStart(3, '0')}`,
      name: sourceName,
      version: `${(item % 4) + 1}`,
      location: `section ${((item - 1) % 7) + 1}`,
      chunkIndex: item % 6,
    },
    metadata: {
      documentType,
      ownerTeam,
      language,
      freshnessDays,
      embeddedOn,
    },
    updatedAt: dayAsIso(freshnessDays),
    createdAt: dayAsIso(freshnessDays + 40),
    qualityFlags:
      item % 11 === 0
        ? ['Stale embedding']
        : item % 17 === 0
          ? ['Missing checksum']
          : [],
    vector: {
      dimensions: 1536,
      metric: 'Cosine similarity',
      model: 'text-embedding-3-large',
    },
  } satisfies VectorRecord
})

const supportRecords = Array.from({ length: 52 }, (_, index) => {
  const item = index + 1
  const severities = supportFields[0].options ?? []
  const productAreas = supportFields[1].options ?? []
  const regions = supportFields[2].options ?? []
  const severity = severities[index % severities.length]
  const productArea = productAreas[(index + 2) % productAreas.length]
  const region = regions[(index + 1) % regions.length]
  const freshnessDays = (index * 4) % 32 + 2
  const embeddedOn = dateOnly(freshnessDays)
  const caseId = `case-${item.toString().padStart(4, '0')}`
  const content = `Support escalation ${caseId} summarizes a ${severity.toLowerCase()} issue in ${productArea.toLowerCase()}. The chunk preserves symptoms, customer language, and operator notes so engineers can verify whether retrieval returns the right escalation context for ${region}.`

  return {
    id: `sup-${item.toString().padStart(3, '0')}`,
    scope: 'support-ops',
    content,
    contentPreview: summarizeContent(content),
    source: {
      id: caseId,
      name: `${productArea.toLowerCase()}-${severity.toLowerCase()}-${item}.txt`,
      version: `${(item % 3) + 2}`,
      location: `reply ${((item - 1) % 5) + 1}`,
      chunkIndex: item % 4,
    },
    metadata: {
      severity,
      productArea,
      region,
      freshnessDays,
      embeddedOn,
    },
    updatedAt: dayAsIso(freshnessDays),
    createdAt: dayAsIso(freshnessDays + 18),
    qualityFlags:
      item % 9 === 0
        ? ['Duplicate identity']
        : item % 14 === 0
          ? ['Invalid metadata']
          : [],
    vector: {
      dimensions: 3072,
      metric: 'Dot product',
      model: 'text-embedding-3-large',
    },
  } satisfies VectorRecord
})

export const mockCollections: CollectionDefinition[] = [
  {
    id: 'engineering-knowledge',
    label: 'Engineering Knowledge',
    description: 'Reference chunks for product, delivery, and platform design material.',
    scope: 'project-42',
    status: 'Healthy',
    latencyMs: 64,
    dimensions: 1536,
    metric: 'Cosine similarity',
    model: 'text-embedding-3-large',
    fields: engineeringFields,
    records: engineeringRecords,
  },
  {
    id: 'support-escalations',
    label: 'Support Escalations',
    description: 'Customer-facing incident and escalation summaries prepared for retrieval.',
    scope: 'support-ops',
    status: 'Degraded',
    latencyMs: 112,
    dimensions: 3072,
    metric: 'Dot product',
    model: 'text-embedding-3-large',
    fields: supportFields,
    records: supportRecords,
  },
]