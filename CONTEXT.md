# Vector Database UI

This context defines the language for a provider-neutral UI that helps users inspect vector database contents without coupling the product to a single domain or provider.

## Language

**Connection Configuration**:
The provider type and endpoint reference a user supplies to target a vector database connection.
_Avoid_: Connection string, credential, secret

**Connection**:
A configured vector service that can be health-checked and browsed through the UI.
_Avoid_: Cluster, instance, endpoint

**Collection**:
A named logical container of vector records exposed by a provider.
_Avoid_: Index, class, table

**Scope**:
An optional partition inside a collection that every query must respect.
_Avoid_: Tenant, namespace, partition

**Vector Record**:
The stored unit shown in the explorer, combining searchable content, metadata, provenance, and vector configuration.
_Avoid_: Chunk row, document row, object

**Record Preview**:
A lightweight subset of a vector record used in paginated grids and summaries.
_Avoid_: Full record, detail payload

**Filter Schema**:
The declared set of filterable metadata fields for a collection.
_Avoid_: Hard-coded document filters