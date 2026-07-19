import {
  startTransition,
  useDeferredValue,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import type {
  EnumFilterState,
  ExplorerRecord,
  ExplorerResponse,
  MetadataFieldSchema,
  RangeFilterState,
  SortDirection,
} from "./types";

const pageSizeOptions = [10, 20, 25, 50];
const defaultDatabaseUrl = "";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const highlightedFilterKeys = new Set(["collection", "scope"]);

type QueryState = {
  page: number;
  pageSize: number;
  search: string;
  sortKey: string;
  sortDirection: SortDirection;
  enumFilters: EnumFilterState;
  rangeFilters: RangeFilterState;
};

type RangeValue = { min: string; max: string };

type ActiveFilterToken = {
  id: string;
  fieldKey: string;
  label: string;
  value: string;
  kind: "enum" | "range";
  option?: string;
};

function readInitialQueryState(): QueryState {
  const params = new URLSearchParams(window.location.search);
  const page = Number(params.get("page") ?? "1");
  const pageSize = Number(params.get("pageSize") ?? "20");
  const search = params.get("search") ?? "";
  const sortKey = params.get("sortKey") ?? "updatedAt";
  const sortDirection = params.get("sortDirection") === "asc" ? "asc" : "desc";
  const enumFilters: EnumFilterState = {};
  const rangeFilters: RangeFilterState = {};

  for (const [key, value] of params.entries()) {
    if (key.startsWith("filter.")) {
      enumFilters[key.replace("filter.", "")] = value
        .split("|")
        .filter(Boolean);
    }

    if (key.startsWith("range.") && key.endsWith(".min")) {
      const rangeKey = key.replace("range.", "").replace(".min", "");
      rangeFilters[rangeKey] = {
        min: value,
        max: rangeFilters[rangeKey]?.max ?? "",
      };
    }

    if (key.startsWith("range.") && key.endsWith(".max")) {
      const rangeKey = key.replace("range.", "").replace(".max", "");
      rangeFilters[rangeKey] = {
        min: rangeFilters[rangeKey]?.min ?? "",
        max: value,
      };
    }
  }

  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: pageSizeOptions.includes(pageSize) ? pageSize : 20,
    search,
    sortKey,
    sortDirection,
    enumFilters,
    rangeFilters,
  };
}

function formatDate(value: string) {
  if (!value || Number.isNaN(Date.parse(value))) {
    return "—";
  }

  return dateTimeFormatter.format(new Date(value));
}

function getFieldByKey(fields: MetadataFieldSchema[], key: string) {
  return fields.find((field) => field.key === key);
}

function sanitizeEnumFilters(
  fields: MetadataFieldSchema[],
  filters: EnumFilterState,
) {
  const next: EnumFilterState = {};

  for (const [key, values] of Object.entries(filters)) {
    if (getFieldByKey(fields, key)?.kind === "enum") {
      next[key] = values;
    }
  }

  return next;
}

function sanitizeRangeFilters(
  fields: MetadataFieldSchema[],
  filters: RangeFilterState,
) {
  const next: RangeFilterState = {};

  for (const [key, value] of Object.entries(filters)) {
    const kind = getFieldByKey(fields, key)?.kind;

    if (kind === "number" || kind === "date") {
      next[key] = value;
    }
  }

  return next;
}

function getDefaultVisibleFields(fields: MetadataFieldSchema[]) {
  return fields.filter((field) => field.showByDefault);
}

function matchesSearch(record: ExplorerRecord, searchText: string) {
  const query = searchText.trim().toLowerCase();

  if (!query) {
    return true;
  }

  const haystack = [
    record.id,
    record.source.id,
    record.source.name,
    record.content,
    record.scope,
    record.collectionLabel,
    ...Object.values(record.metadata).map((value) => String(value)),
  ];

  return haystack.some((value) => value.toLowerCase().includes(query));
}

function matchesFilters(
  fields: MetadataFieldSchema[],
  record: ExplorerRecord,
  enumFilters: EnumFilterState,
  rangeFilters: RangeFilterState,
) {
  for (const [key, values] of Object.entries(enumFilters)) {
    if (!values.length) {
      continue;
    }

    if (!values.includes(String(record.metadata[key] ?? ""))) {
      return false;
    }
  }

  for (const [key, range] of Object.entries(rangeFilters)) {
    if (!range.min && !range.max) {
      continue;
    }

    const field = getFieldByKey(fields, key);
    const value = record.metadata[key];

    if (!field || value === undefined) {
      return false;
    }

    if (field.kind === "number") {
      const numericValue = Number(value);

      if (range.min && numericValue < Number(range.min)) {
        return false;
      }

      if (range.max && numericValue > Number(range.max)) {
        return false;
      }
    }

    if (field.kind === "date") {
      const stringValue = String(value);

      if (range.min && stringValue < range.min) {
        return false;
      }

      if (range.max && stringValue > range.max) {
        return false;
      }
    }
  }

  return true;
}

function getSortValue(
  fields: MetadataFieldSchema[],
  record: ExplorerRecord,
  key: string,
) {
  if (key === "sourceName") {
    return record.source.name;
  }

  if (key === "contentPreview") {
    return record.contentPreview;
  }

  if (key === "updatedAt") {
    return record.updatedAt ? new Date(record.updatedAt).getTime() : 0;
  }

  const field = getFieldByKey(fields, key);
  const value = record.metadata[key];

  if (!field) {
    return record.id;
  }

  if (field.kind === "number") {
    return Number(value ?? 0);
  }

  if (field.kind === "date") {
    return String(value ?? "");
  }

  return String(value ?? "");
}

function compareRecords(
  fields: MetadataFieldSchema[],
  left: ExplorerRecord,
  right: ExplorerRecord,
  sortKey: string,
  sortDirection: SortDirection,
) {
  const leftValue = getSortValue(fields, left, sortKey);
  const rightValue = getSortValue(fields, right, sortKey);

  const result =
    typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue));

  return sortDirection === "asc" ? result : result * -1;
}

function getApiErrorMessage(payload: ExplorerResponse | { message?: string }) {
  return "message" in payload && typeof payload.message === "string"
    ? payload.message
    : null;
}

function hasRangeValue(range: RangeValue | undefined) {
  return Boolean(range?.min || range?.max);
}

function formatEnumSelection(values: string[]) {
  if (!values.length) {
    return "Any value";
  }

  if (values.length === 1) {
    return values[0];
  }

  return `${values[0]} +${values.length - 1} more`;
}

function formatRangeSelection(
  field: MetadataFieldSchema,
  range: RangeValue | undefined,
) {
  if (!hasRangeValue(range)) {
    return field.kind === "date" ? "Any time" : "Any value";
  }

  const min = range?.min || "Any";
  const max = range?.max || "Any";

  if (field.kind === "date") {
    return `${formatDate(min)} to ${formatDate(max)}`;
  }

  return `${min} to ${max}`;
}

function getFilterSelectionState(
  field: MetadataFieldSchema,
  enumFilters: EnumFilterState,
  rangeFilters: RangeFilterState,
) {
  if (field.kind === "enum") {
    const values = enumFilters[field.key] ?? [];

    return {
      count: values.length,
      isActive: values.length > 0,
      label: formatEnumSelection(values),
    };
  }

  const range = rangeFilters[field.key];

  return {
    count: hasRangeValue(range) ? 1 : 0,
    isActive: hasRangeValue(range),
    label: formatRangeSelection(field, range),
  };
}

function getDefaultFilterHint(field: MetadataFieldSchema) {
  if (field.kind === "enum") {
    const optionCount = field.options?.length ?? 0;
    return optionCount === 1 ? "1 option" : `${optionCount} options`;
  }

  return field.kind === "date" ? "Choose a date window" : "Set a numeric range";
}

function isIdentifierField(field: MetadataFieldSchema) {
  const loweredKey = field.key.toLowerCase();
  return (
    loweredKey === "id" ||
    loweredKey.endsWith("id") ||
    loweredKey.endsWith("uuid")
  );
}

function getPrimaryFilterFields(
  fields: MetadataFieldSchema[],
  enumFilters: EnumFilterState,
  rangeFilters: RangeFilterState,
) {
  return fields.filter((field) => {
    const selection = getFilterSelectionState(field, enumFilters, rangeFilters);

    if (selection.isActive) {
      return true;
    }

    if (highlightedFilterKeys.has(field.key)) {
      return true;
    }

    if (field.kind !== "enum") {
      return true;
    }

    return Boolean(field.showByDefault) && !isIdentifierField(field);
  });
}

function getSecondaryFilterFields(
  fields: MetadataFieldSchema[],
  primaryFilterFields: MetadataFieldSchema[],
) {
  const primaryKeys = new Set(primaryFilterFields.map((field) => field.key));
  return fields.filter((field) => !primaryKeys.has(field.key));
}

function createActiveFilterTokens(
  fields: MetadataFieldSchema[],
  enumFilters: EnumFilterState,
  rangeFilters: RangeFilterState,
) {
  const tokens: ActiveFilterToken[] = [];

  for (const field of fields) {
    if (field.kind === "enum") {
      for (const option of enumFilters[field.key] ?? []) {
        tokens.push({
          id: `${field.key}:${option}`,
          fieldKey: field.key,
          label: field.label,
          value: option,
          kind: "enum",
          option,
        });
      }

      continue;
    }

    const range = rangeFilters[field.key];
    if (!hasRangeValue(range)) {
      continue;
    }

    tokens.push({
      id: `${field.key}:range`,
      fieldKey: field.key,
      label: field.label,
      value: formatRangeSelection(field, range),
      kind: "range",
    });
  }

  return tokens;
}

function createInitialExpandedFilters(fields: MetadataFieldSchema[]) {
  return Object.fromEntries(
    fields.map((field) => [field.key, highlightedFilterKeys.has(field.key)]),
  );
}

function App() {
  const initialQuery = readInitialQueryState();
  const [databaseUrl, setDatabaseUrl] = useState(defaultDatabaseUrl);
  const [connectedUrl, setConnectedUrl] = useState("");
  const [explorerData, setExplorerData] = useState<ExplorerResponse | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [page, setPage] = useState(initialQuery.page);
  const [pageSize, setPageSize] = useState(initialQuery.pageSize);
  const [search, setSearch] = useState(initialQuery.search);
  const deferredSearch = useDeferredValue(search);
  const [sortKey, setSortKey] = useState(initialQuery.sortKey);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    initialQuery.sortDirection,
  );
  const [enumFilters, setEnumFilters] = useState<EnumFilterState>(
    initialQuery.enumFilters,
  );
  const [rangeFilters, setRangeFilters] = useState<RangeFilterState>(
    initialQuery.rangeFilters,
  );
  const [expandedFilters, setExpandedFilters] = useState<
    Record<string, boolean>
  >({});
  const [showSecondaryFilters, setShowSecondaryFilters] = useState(false);

  const fields = explorerData?.fields ?? [];
  const visibleFields = getDefaultVisibleFields(fields);
  const filteredRecords = (explorerData?.records ?? [])
    .filter((record) => matchesSearch(record, deferredSearch))
    .filter((record) =>
      matchesFilters(fields, record, enumFilters, rangeFilters),
    )
    .sort((left, right) =>
      compareRecords(fields, left, right, sortKey, sortDirection),
    );

  const totalRecords = explorerData?.records.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, filteredRecords.length);
  const pagedRecords = filteredRecords.slice(startIndex, endIndex);
  const activeFilterCount =
    Object.values(enumFilters).reduce(
      (total, values) => total + values.length,
      0,
    ) +
    Object.values(rangeFilters).reduce(
      (total, range) => total + (range.min || range.max ? 1 : 0),
      0,
    );
  const visibleCollectionCount = new Set(
    filteredRecords.map((record) => record.collectionId),
  ).size;
  const primaryFilterFields = getPrimaryFilterFields(
    fields,
    enumFilters,
    rangeFilters,
  );
  const secondaryFilterFields = getSecondaryFilterFields(
    fields,
    primaryFilterFields,
  );
  const activeFilterTokens = createActiveFilterTokens(
    fields,
    enumFilters,
    rangeFilters,
  );

  useEffect(() => {
    if (page !== safePage) {
      startTransition(() => setPage(safePage));
    }
  }, [page, safePage]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("page", String(safePage));
    params.set("pageSize", String(pageSize));
    params.set("sortKey", sortKey);
    params.set("sortDirection", sortDirection);

    if (search.trim()) {
      params.set("search", search.trim());
    }

    for (const [key, values] of Object.entries(enumFilters)) {
      if (values.length) {
        params.set(`filter.${key}`, values.join("|"));
      }
    }

    for (const [key, range] of Object.entries(rangeFilters)) {
      if (range.min) {
        params.set(`range.${key}.min`, range.min);
      }

      if (range.max) {
        params.set(`range.${key}.max`, range.max);
      }
    }

    const query = params.toString();
    const nextUrl = query
      ? `${window.location.pathname}?${query}`
      : window.location.pathname;
    window.history.replaceState({}, "", nextUrl);
  }, [
    enumFilters,
    pageSize,
    rangeFilters,
    safePage,
    search,
    sortDirection,
    sortKey,
  ]);

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!databaseUrl.trim()) {
      setErrorMessage(
        "Enter a vector database URL or PostgreSQL connection string first.",
      );
      return;
    }

    setIsLoading(true);
    setErrorMessage("");

    try {
      const response = await fetch("/api/explore", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ databaseUrl: databaseUrl.trim() }),
      });

      const payload = (await response.json()) as
        | ExplorerResponse
        | { message?: string };

      if (!response.ok || !("records" in payload)) {
        throw new Error(
          getApiErrorMessage(payload) ?? "Unable to load the vector database.",
        );
      }

      setExplorerData(payload);
      setConnectedUrl(databaseUrl.trim());
      setLastLoadedAt(new Date().toISOString());
      setEnumFilters((current) => sanitizeEnumFilters(payload.fields, current));
      setRangeFilters((current) =>
        sanitizeRangeFilters(payload.fields, current),
      );
      setExpandedFilters(createInitialExpandedFilters(payload.fields));
      setShowSecondaryFilters(false);
      setPage(1);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to load the vector database.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  function handleSort(nextSortKey: string) {
    startTransition(() => {
      if (sortKey === nextSortKey) {
        setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(nextSortKey);
        setSortDirection(nextSortKey === "updatedAt" ? "desc" : "asc");
      }
    });
  }

  function toggleEnumValue(fieldKey: string, option: string) {
    startTransition(() => {
      setEnumFilters((current) => {
        const existing = current[fieldKey] ?? [];
        const nextValues = existing.includes(option)
          ? existing.filter((value) => value !== option)
          : [...existing, option];

        return {
          ...current,
          [fieldKey]: nextValues,
        };
      });
      setPage(1);
    });
  }

  function updateRange(fieldKey: string, side: "min" | "max", value: string) {
    startTransition(() => {
      setRangeFilters((current) => ({
        ...current,
        [fieldKey]: {
          min: side === "min" ? value : (current[fieldKey]?.min ?? ""),
          max: side === "max" ? value : (current[fieldKey]?.max ?? ""),
        },
      }));
      setPage(1);
    });
  }

  function resetFilters() {
    startTransition(() => {
      setEnumFilters({});
      setRangeFilters({});
      setSearch("");
      setPage(1);
    });
  }

  function toggleFilterGroup(fieldKey: string) {
    setExpandedFilters((current) => ({
      ...current,
      [fieldKey]: !current[fieldKey],
    }));
  }

  function clearEnumValue(fieldKey: string, option: string) {
    startTransition(() => {
      setEnumFilters((current) => {
        const nextValues = (current[fieldKey] ?? []).filter(
          (value) => value !== option,
        );

        if (!nextValues.length) {
          return Object.fromEntries(
            Object.entries(current).filter(([key]) => key !== fieldKey),
          );
        }

        return {
          ...current,
          [fieldKey]: nextValues,
        };
      });
      setPage(1);
    });
  }

  function clearRangeValue(fieldKey: string) {
    startTransition(() => {
      setRangeFilters((current) => {
        return Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== fieldKey),
        );
      });
      setPage(1);
    });
  }

  function renderFilterGroup(field: MetadataFieldSchema) {
    const selection = getFilterSelectionState(field, enumFilters, rangeFilters);
    const isExpanded =
      expandedFilters[field.key] ?? highlightedFilterKeys.has(field.key);

    return (
      <section
        key={field.key}
        className={`filter-group ${selection.isActive ? "is-active" : ""}`}
      >
        <button
          type="button"
          className="filter-summary"
          onClick={() => toggleFilterGroup(field.key)}
          aria-expanded={isExpanded}
        >
          <div className="filter-summary__copy">
            <span className="filter-label">{field.label}</span>
            <span className="filter-summary__hint">
              {selection.isActive
                ? selection.label
                : getDefaultFilterHint(field)}
            </span>
          </div>
          <span className="filter-summary__cluster">
            <span className="filter-summary__meta">
              {selection.isActive
                ? `${selection.count} active`
                : field.kind === "enum"
                  ? `${field.options?.length ?? 0}`
                  : field.kind === "date"
                    ? "Date"
                    : "Range"}
            </span>
            <span className="filter-summary__chevron" aria-hidden="true">
              {isExpanded ? "−" : "+"}
            </span>
          </span>
        </button>

        {isExpanded ? (
          field.kind === "enum" ? (
            <div
              className="multi-select-list"
              role="group"
              aria-label={field.label}
            >
              {(field.options ?? []).map((option) => {
                const active = (enumFilters[field.key] ?? []).includes(option);

                return (
                  <button
                    key={option}
                    type="button"
                    className={`choice-pill ${active ? "is-selected" : ""}`}
                    aria-pressed={active}
                    onClick={() => toggleEnumValue(field.key, option)}
                    disabled={isLoading}
                  >
                    <span className="choice-pill__check" aria-hidden="true">
                      {active ? "✓" : ""}
                    </span>
                    <span className="choice-pill__label">{option}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="range-panel">
              <label className="field field--compact">
                <span>{field.kind === "date" ? "From" : "Min"}</span>
                <input
                  type={field.kind === "date" ? "date" : "number"}
                  value={rangeFilters[field.key]?.min ?? ""}
                  onChange={(event) =>
                    updateRange(field.key, "min", event.target.value)
                  }
                  disabled={isLoading}
                />
              </label>
              <label className="field field--compact">
                <span>{field.kind === "date" ? "To" : "Max"}</span>
                <input
                  type={field.kind === "date" ? "date" : "number"}
                  value={rangeFilters[field.key]?.max ?? ""}
                  onChange={(event) =>
                    updateRange(field.key, "max", event.target.value)
                  }
                  disabled={isLoading}
                />
              </label>
            </div>
          )
        ) : null}
      </section>
    );
  }

  return (
    <div className="app-shell">
      <form className="top-bar panel" onSubmit={handleConnect}>
        <label className="field url-field">
          <span>Vector database URL or connection string</span>
          <input
            type="text"
            value={databaseUrl}
            onChange={(event) => setDatabaseUrl(event.target.value)}
            placeholder="http://localhost:6333 or postgresql://user:password@host:5432/db"
          />
        </label>
        <button
          type="submit"
          className="button button--primary"
          disabled={isLoading}
        >
          {isLoading
            ? "Loading…"
            : explorerData
              ? "Reload contents"
              : "Load contents"}
        </button>
      </form>

      {errorMessage ? (
        <div className="panel message-strip message-strip--error">
          {errorMessage}
        </div>
      ) : null}

      <section className="panel content-panel">
        {explorerData ? (
          <>
            <div className="content-header">
              <div>
                <h1>Vector database contents</h1>
                <p>
                  Showing {filteredRecords.length} of {totalRecords} records
                  from {visibleCollectionCount} collections for {connectedUrl}.
                </p>
              </div>
              <div className="content-meta">
                <span className="summary-pill">
                  Provider: {explorerData.provider}
                </span>
                <span className="summary-pill">
                  {activeFilterCount} active filters
                </span>
                <span className="summary-pill">
                  {lastLoadedAt
                    ? `Loaded ${formatDate(lastLoadedAt)}`
                    : "Not loaded yet"}
                </span>
              </div>
            </div>

            {explorerData.warnings.length ? (
              <div className="message-strip message-strip--info">
                {explorerData.warnings.join(" ")}
              </div>
            ) : null}

            <div className="workspace-shell">
              <aside className="filter-rail">
                <div className="filter-rail__header">
                  <div>
                    <h2>Filters</h2>
                    <p>Compact multi-select controls with a fixed rail.</p>
                  </div>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={resetFilters}
                    disabled={isLoading}
                  >
                    Clear all
                  </button>
                </div>

                <div className="filter-tools">
                  <label className="field field--search">
                    <span>Search</span>
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => {
                        startTransition(() => {
                          setSearch(event.target.value);
                          setPage(1);
                        });
                      }}
                      placeholder="Search records or metadata"
                      disabled={isLoading}
                    />
                  </label>

                  <div className="filter-tools__row">
                    <label className="field field--compact">
                      <span>Page size</span>
                      <select
                        value={pageSize}
                        onChange={(event) => {
                          startTransition(() => {
                            setPageSize(Number(event.target.value));
                            setPage(1);
                          });
                        }}
                        disabled={isLoading}
                      >
                        {pageSizeOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="view-stat">
                      <span>Visible now</span>
                      <strong>{filteredRecords.length}</strong>
                    </div>
                  </div>
                </div>

                <div className="active-filter-strip">
                  {activeFilterTokens.length > 0 ? (
                    activeFilterTokens.map((token) => (
                      <button
                        key={token.id}
                        type="button"
                        className="active-filter-chip"
                        onClick={() =>
                          token.kind === "enum" && token.option
                            ? clearEnumValue(token.fieldKey, token.option)
                            : clearRangeValue(token.fieldKey)
                        }
                      >
                        <span>
                          {token.label}: {token.value}
                        </span>
                        <span aria-hidden="true">×</span>
                      </button>
                    ))
                  ) : (
                    <p className="filter-strip__empty">
                      Pick one or more values to build a focused view.
                    </p>
                  )}
                </div>

                <div className="filter-stack">
                  {primaryFilterFields.map(renderFilterGroup)}

                  {secondaryFilterFields.length > 0 ? (
                    <section className="filter-bucket">
                      <button
                        type="button"
                        className="filter-bucket__summary"
                        onClick={() =>
                          setShowSecondaryFilters((current) => !current)
                        }
                        aria-expanded={showSecondaryFilters}
                      >
                        More metadata filters
                        <span
                          className="filter-summary__chevron"
                          aria-hidden="true"
                        >
                          {showSecondaryFilters ? "−" : "+"}
                        </span>
                      </button>
                      {showSecondaryFilters ? (
                        <div className="filter-bucket__body">
                          {secondaryFilterFields.map(renderFilterGroup)}
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                </div>
              </aside>

              <section className="results-panel">
                <div className="results-toolbar">
                  <div className="results-badges">
                    <span className="summary-pill">
                      {filteredRecords.length} matches
                    </span>
                    <span className="summary-pill">{pageCount} pages</span>
                    <span className="summary-pill">
                      {visibleFields.length} metadata columns
                    </span>
                  </div>
                  <p className="results-toolbar__hint">
                    The table scrolls inside this panel so the page stays still.
                  </p>
                </div>

                {pagedRecords.length > 0 ? (
                  <div className="table-stage">
                    <div className="records-table-wrapper">
                      <table className="records-table">
                        <thead>
                          <tr>
                            <th>
                              <button
                                type="button"
                                onClick={() => handleSort("id")}
                              >
                                Record ID{" "}
                                {sortKey === "id"
                                  ? sortDirection === "asc"
                                    ? "↑"
                                    : "↓"
                                  : ""}
                              </button>
                            </th>
                            <th>
                              <button
                                type="button"
                                onClick={() => handleSort("sourceName")}
                              >
                                Source{" "}
                                {sortKey === "sourceName"
                                  ? sortDirection === "asc"
                                    ? "↑"
                                    : "↓"
                                  : ""}
                              </button>
                            </th>
                            <th>
                              <button
                                type="button"
                                onClick={() => handleSort("contentPreview")}
                              >
                                Content{" "}
                                {sortKey === "contentPreview"
                                  ? sortDirection === "asc"
                                    ? "↑"
                                    : "↓"
                                  : ""}
                              </button>
                            </th>
                            {visibleFields.map((field) => (
                              <th key={field.key}>
                                <button
                                  type="button"
                                  onClick={() => handleSort(field.key)}
                                >
                                  {field.label}{" "}
                                  {sortKey === field.key
                                    ? sortDirection === "asc"
                                      ? "↑"
                                      : "↓"
                                    : ""}
                                </button>
                              </th>
                            ))}
                            <th>
                              <button
                                type="button"
                                onClick={() => handleSort("updatedAt")}
                              >
                                Updated{" "}
                                {sortKey === "updatedAt"
                                  ? sortDirection === "asc"
                                    ? "↑"
                                    : "↓"
                                  : ""}
                              </button>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedRecords.map((record) => (
                            <tr key={`${record.collectionId}-${record.id}`}>
                              <td>
                                <span className="record-token">
                                  {record.id}
                                </span>
                              </td>
                              <td>
                                <div className="source-cell">
                                  <strong>{record.source.name}</strong>
                                  <span>{record.source.location}</span>
                                </div>
                              </td>
                              <td>
                                <div className="content-cell">
                                  <p>{record.contentPreview}</p>
                                  <span>
                                    {record.vector.metric} vector ·{" "}
                                    {record.vector.model}
                                  </span>
                                </div>
                              </td>
                              {visibleFields.map((field) => (
                                <td
                                  key={`${record.collectionId}-${record.id}-${field.key}`}
                                >
                                  {String(record.metadata[field.key] ?? "—")}
                                </td>
                              ))}
                              <td>{formatDate(record.updatedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="pagination-row">
                      <div>
                        Showing {startIndex + 1}-{endIndex} of{" "}
                        {filteredRecords.length}
                      </div>
                      <div className="button-row button-row--inline">
                        <button
                          type="button"
                          className="button button--ghost"
                          onClick={() =>
                            startTransition(() =>
                              setPage((current) => Math.max(1, current - 1)),
                            )
                          }
                          disabled={safePage === 1}
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          className="button button--ghost"
                          onClick={() =>
                            startTransition(() =>
                              setPage((current) =>
                                Math.min(pageCount, current + 1),
                              ),
                            )
                          }
                          disabled={safePage === pageCount}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="empty-state">
                    <h2>No records match the current filters.</h2>
                    <p>
                      Clear a few selections or widen the search to bring more
                      records back into view.
                    </p>
                  </div>
                )}
              </section>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <h1>Enter a vector database URL or connection string</h1>
            <p>
              After you load a provider URL or PostgreSQL connection string, the
              app calls a local backend that detects the provider and loads live
              collections plus record previews from the actual vector database.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
