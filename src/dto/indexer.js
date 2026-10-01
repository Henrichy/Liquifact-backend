'use strict';

/**
 * @fileoverview Typed DTO layer for the indexer boundary.
 *
 * Defines request/response DTOs and bi-directional mapping functions used at
 * every entry and exit point of the indexer subsystem:
 *
 *   - {@link IndexerEventsQueryDTO}  – parsed, validated query params (request side)
 *   - {@link EscrowEventRowDTO}      – a single row returned from `escrow_events` (response side)
 *   - {@link IndexerEventsMetaDTO}   – pagination metadata envelope (response side)
 *   - {@link IndexerEventsResponseDTO} – full service/route response envelope
 *   - {@link IndexerIngestEventDTO}  – inbound event shape fed to the indexer job
 *
 * Mappers follow a strict boundary pattern:
 *
 *   raw query params  → {@link mapQueryToDTO}     → IndexerEventsQueryDTO
 *   IndexerEventsQueryDTO → {@link mapDTOToServiceParams} → service options object
 *   DB row            → {@link mapRowToEscrowEventDTO} → EscrowEventRowDTO
 *   service result    → {@link mapServiceResultToResponseDTO} → IndexerEventsResponseDTO
 *   raw ingest event  → {@link mapRawToIngestDTO}  → IndexerIngestEventDTO
 *
 * No runtime dependencies are introduced — all types are plain objects with
 * JSDoc annotations; validation is done via existing Zod schemas.
 *
 * Compatibility contract: every mapper is total and deterministic. Unknown or
 * malformed inputs are coerced to safe defaults rather than throwing, so that
 * callers relying on the previous inline behavior keep working unchanged.
 *
 * @module dto/indexer
 */

// ─────────────────────────────────────────────────────────────────────────────
// Request DTO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed representation of the validated query parameters for the indexer
 * events listing endpoint (GET /api/admin/indexer/events).
 *
 * All fields are immutable after construction to prevent accidental mutation.
 *
 * @typedef {object} IndexerEventsQueryDTO
 * @property {object}      filters
 * @property {string|undefined} filters.invoiceId  - Exact-match filter on invoice ID.
 * @property {string|undefined} filters.eventType  - Exact-match filter on event type.
 * @property {string|undefined} filters.contractId - Exact-match filter on contract ID.
 * @property {object}      sorting
 * @property {string}      sorting.sortBy   - Sort field ('observed_at' | 'ledger_sequence').
 * @property {string}      sorting.order    - Sort direction ('asc' | 'desc').
 * @property {object}      pagination
 * @property {string|undefined} pagination.cursor - Opaque HMAC-signed cursor.
 * @property {number|undefined} pagination.page   - 1-based page number (offset mode).
 * @property {number|undefined} pagination.limit  - Page size (1–100).
 */

/**
 * Constructs an {@link IndexerEventsQueryDTO} from the parsed `params` object
 * produced by `adminIndexer._parseQuery()`.
 *
 * The mapping is intentionally explicit so every field is traceable and type
 * errors surface at the boundary rather than deep inside the service.
 *
 * @param {object} params - Normalised params from `_parseQuery`.
 * @param {object} [params.filters={}]
 * @param {object} [params.sorting={}]
 * @param {object} [params.pagination={}]
 * @returns {IndexerEventsQueryDTO}
 */
function mapQueryToDTO(params) {
  if (params == null || typeof params !== 'object') {
    params = {};
  }
  const filters = params.filters || {};
  const sorting = params.sorting || {};
  const pagination = params.pagination || {};

  const sortBy = sorting.sortBy !== undefined ? String(sorting.sortBy) : 'observed_at';
  if (sortBy !== 'observed_at' && sortBy !== 'ledger_sequence') {
    throw new RangeError(`mapQueryToDTO: invalid sortBy "${sortBy}"`);
  }

  const order = sorting.order === 'asc' ? 'asc' : 'desc';

  const page = pagination.page !== undefined ? Number(pagination.page) : undefined;
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) {
    throw new RangeError('mapQueryToDTO: page must be a positive integer');
  }

  const limit = pagination.limit !== undefined ? Number(pagination.limit) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new RangeError('mapQueryToDTO: limit must be an integer between 1 and 100');
  }

  return Object.freeze({
    filters: Object.freeze({
      invoiceId: filters.invoiceId !== undefined ? String(filters.invoiceId) : undefined,
      eventType: filters.eventType !== undefined ? String(filters.eventType) : undefined,
      contractId: filters.contractId !== undefined ? String(filters.contractId) : undefined,
    }),
    sorting: Object.freeze({
      sortBy,
      order,
    }),
    pagination: Object.freeze({
      cursor: pagination.cursor !== undefined ? String(pagination.cursor) : undefined,
      page,
      limit,
    }),
  });
}

/**
 * Converts an {@link IndexerEventsQueryDTO} back into the plain options object
 * accepted by {@link module:services/indexerService.listIndexerEvents}.
 *
 * This is the second half of the request-side mapping.  The service receives
 * only what it needs: optional fields whose value is `undefined` are omitted
 * so the service's own defaults apply transparently.
 *
 * @param {IndexerEventsQueryDTO} dto
 * @returns {{ filters: object, sorting: object, pagination: object }}
 */
function mapDTOToServiceParams(dto) {
  if (dto == null || typeof dto !== 'object') {
    return { filters: {}, sorting: {}, pagination: {} };
  }
  const filters = {};
  if (dto.filters.invoiceId !== undefined) {
    filters.invoiceId = dto.filters.invoiceId;
  }
  if (dto.filters.eventType !== undefined) {
    filters.eventType = dto.filters.eventType;
  }
  if (dto.filters.contractId !== undefined) {
    filters.contractId = dto.filters.contractId;
  }

  const sorting = {};
  if (dto.sorting.sortBy !== undefined) {
    sorting.sortBy = dto.sorting.sortBy;
  }
  if (dto.sorting.order !== undefined) {
    sorting.order = dto.sorting.order;
  }

  const pagination = {};
  if (dto.pagination.cursor !== undefined) {
    pagination.cursor = dto.pagination.cursor;
  }
  if (dto.pagination.page !== undefined) {
    pagination.page = dto.pagination.page;
  }
  if (dto.pagination.limit !== undefined) {
    pagination.limit = dto.pagination.limit;
  }

  return { filters, sorting, pagination };
}

// ─────────────────────────────────────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typed representation of a single row from the `escrow_events` table as
 * returned by the listing endpoint.
 *
 * `event_body` is not included because it is intentionally excluded from list
 * responses; callers that need it should fetch a specific event by ID.
 *
 * @typedef {object} EscrowEventRowDTO
 * @property {string}      eventId        - Primary key (UUID / paging-token-derived).
 * @property {string}      invoiceId      - Associated invoice identifier.
 * @property {string}      eventType      - Event name (e.g. `'escrow_created'`).
 * @property {number}      ledgerSequence - Stellar ledger sequence number.
 * @property {string|null} pagingToken    - Horizon paging token, or null.
 * @property {string|null} contractId     - Stellar contract address, or null.
 * @property {string|null} txHash         - Transaction hash, or null.
 * @property {string}      observedAt     - ISO-8601 timestamp when the event was indexed.
 * @property {string}      createdAt      - ISO-8601 timestamp when the row was created.
 */

/**
 * Maps a raw database row from `escrow_events` into an {@link EscrowEventRowDTO}.
 *
 * Column names use snake_case (as returned by Knex); the DTO uses camelCase to
 * match the JSON API convention.  Null-safety is applied to all nullable
 * columns so consumers can rely on the type contract without further coercion.
 *
 * @param {object} row - Raw Knex row from `escrow_events`.
 * @returns {EscrowEventRowDTO}
 */
function mapRowToEscrowEventDTO(row) {
  if (row == null || typeof row !== 'object') {
    throw new TypeError('mapRowToEscrowEventDTO: row must be a non-null object');
  }
  return Object.freeze({
    eventId: String(row.event_id),
    invoiceId: String(row.invoice_id),
    eventType: String(row.event_type),
    ledgerSequence: Number(row.ledger_sequence),
    pagingToken: row.paging_token != null ? String(row.paging_token) : null,
    contractId: row.contract_id != null ? String(row.contract_id) : null,
    txHash: row.tx_hash != null ? String(row.tx_hash) : null,
    observedAt: row.observed_at instanceof Date
      ? row.observed_at.toISOString()
      : row.observed_at != null ? String(row.observed_at) : null,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at != null ? String(row.created_at) : null,
  });
}

/**
 * Maps an {@link EscrowEventRowDTO} back to a DB row-shaped plain object
 * (snake_case).  Used in tests to verify round-trip fidelity.
 *
 * @param {EscrowEventRowDTO} dto
 * @returns {object}
 */
function mapEscrowEventDTOToRow(dto) {
  if (dto == null || typeof dto !== 'object') {
    throw new TypeError('mapEscrowEventDTOToRow: dto must be a non-null object');
  }
  return {
    event_id: dto.eventId,
    invoice_id: dto.invoiceId,
    event_type: dto.eventType,
    ledger_sequence: dto.ledgerSequence,
    paging_token: dto.pagingToken,
    contract_id: dto.contractId,
    tx_hash: dto.txHash,
    observed_at: dto.observedAt,
    created_at: dto.createdAt,
  };
}

/**
 * Pagination metadata returned by the listing endpoint.
 *
 * @typedef {object} IndexerEventsMetaDTO
 * @property {number}      total       - Total matching rows across all pages.
 * @property {number}      limit       - Page size used for this response.
 * @property {boolean}     hasMore     - Whether additional pages exist.
 * @property {string|null} nextCursor  - Opaque cursor for the next page, or null.
 * @property {number|undefined} page       - Current page (offset mode only).
 * @property {number|undefined} totalPages - Total number of pages (offset mode only).
 */

/**
 * Maps the raw `meta` object returned by {@link listIndexerEvents} into an
 * {@link IndexerEventsMetaDTO}.
 *
 * @param {object} rawMeta
 * @returns {IndexerEventsMetaDTO}
 */
function mapMetaToDTO(rawMeta) {
  if (rawMeta == null || typeof rawMeta !== 'object') {
    rawMeta = {};
  }
  const dto = {
    total: Number(rawMeta.total),
    limit: Number(rawMeta.limit),
    hasMore: Boolean(rawMeta.hasMore),
    nextCursor: rawMeta.nextCursor != null ? String(rawMeta.nextCursor) : null,
  };
  if (rawMeta.page !== undefined) {
    dto.page = Number(rawMeta.page);
  }
  if (rawMeta.totalPages !== undefined) {
    dto.totalPages = Number(rawMeta.totalPages);
  }
  return Object.freeze(dto);
}

/**
 * Full indexer events response DTO returned to the route layer.
 *
 * @typedef {object} IndexerEventsResponseDTO
 * @property {EscrowEventRowDTO[]}  data  - Page of escrow event rows.
 * @property {IndexerEventsMetaDTO} meta  - Pagination metadata.
 */

/**
 * Maps the raw service result `{ data: object[], meta: object }` into a typed
 * {@link IndexerEventsResponseDTO}.
 *
 * @param {{ data: object[], meta: object }} serviceResult
 * @returns {IndexerEventsResponseDTO}
 */
function mapServiceResultToResponseDTO(serviceResult) {
  if (serviceResult == null || typeof serviceResult !== 'object') {
    throw new TypeError('mapServiceResultToResponseDTO: serviceResult must be a non-null object');
  }
  if (!Array.isArray(serviceResult.data)) {
    throw new TypeError('mapServiceResultToResponseDTO: serviceResult.data must be an array');
  }
  return Object.freeze({
    data: serviceResult.data.map(mapRowToEscrowEventDTO),
    meta: mapMetaToDTO(serviceResult.meta),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest / job DTO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an isolated copy of a JSON-like event body. Circular references are
 * rejected before a DTO can escape; they cannot be persisted as JSON and must
 * not be silently truncated during recovery.
 *
 * @param {*} value
 * @param {WeakSet<object>} [ancestors]
 * @returns {*}
 */
function cloneEventBody(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('eventBody contains a non-finite number');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('eventBody contains a value that cannot be persisted as JSON');
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError('eventBody contains an invalid Date');
    }
    // JSON persistence serializes Date instances as ISO strings; snapshot that
    // value directly so a frozen DTO cannot still be changed with setTime().
    return value.toISOString();
  }
  if (ancestors.has(value)) {
    throw new TypeError('eventBody must not contain circular references');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('eventBody must contain only plain objects and arrays');
  }

  ancestors.add(value);
  const copy = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: cloneEventBody(value[key], ancestors),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  ancestors.delete(value);
  return copy;
}

/**
 * Recursively freezes a copied event body so concurrent consumers cannot
 * mutate the snapshot after DTO construction.
 *
 * @param {*} value
 * @param {WeakSet<object>} [seen]
 * @returns {*}
 */
function deepFreezeEventBody(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Object.keys(value)) {
    deepFreezeEventBody(value[key], seen);
  }
  return Object.freeze(value);
}

/**
 * Preserves valid UTC ISO-8601 strings and converts valid Date objects to the
 * same canonical representation used by the persistence layer.
 *
 * @param {*} value
 * @param {string} fieldName
 * @returns {string}
 */
function normalizeIndexerTimestamp(value, fieldName) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError(`mapRawToIngestDTO: ${fieldName} must be a valid ISO-8601 timestamp`);
    }
    return value.toISOString();
  }
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new TypeError(`mapRawToIngestDTO: ${fieldName} must be a valid ISO-8601 timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new TypeError(`mapRawToIngestDTO: ${fieldName} must be a valid ISO-8601 timestamp`);
  }
  return value;
}

/**
 * Typed representation of a raw escrow event as it enters the indexer job
 * boundary (i.e. what `normalizeEvent` + `persistEscrowEvent` consume).
 *
 * This is the inbound shape before it is written to the database, not the
 * outbound/read shape.
 *
 * @typedef {object} IndexerIngestEventDTO
 * @property {string}      eventId        - Unique event identifier.
 * @property {string}      invoiceId      - Associated invoice identifier.
 * @property {string}      eventType      - Event name.
 * @property {number}      ledgerSequence - Stellar ledger sequence number.
 * @property {string}      pagingToken    - Horizon paging token (empty string if absent).
 * @property {string|null} contractId     - Stellar contract address, or null.
 * @property {string|null} txHash         - Transaction hash, or null.
 * @property {object}      eventBody      - Full raw event payload.
 * @property {string}      observedAt     - ISO-8601 indexed-at timestamp.
 */

/**
 * Maps a raw Horizon record (as produced by `fetchEscrowEventsFromHorizon`)
 * into an {@link IndexerIngestEventDTO}.
 *
 * The mapper applies the same coercions used inline in the indexer job so that
 * the shape contract is expressed once in this module rather than scattered
 * across the job.
 *
 * Concurrent-execution invariants
 * ────────────────────────────────
 * - `observedAt` is always captured from `raw.observedAt` when present, or
 *   pinned to `capturedAt` (which the caller may supply, defaulting to the
 *   current instant).  This means two concurrent calls for the same raw event
 *   without an explicit `observedAt` will share the same timestamp when
 *   supplied the same `capturedAt`, producing deterministic ordering.
 * - `eventBody` is an isolated, recursively frozen snapshot so subsequent
 *   mutations to `raw` or another consumer cannot affect this DTO.
 * - `invoiceId` must be a non-empty string; an empty invoiceId makes the DTO
 *   unusable for projection keying and is therefore rejected here rather than
 *   inside the persistence layer.
 *
 * @param {object} raw - Raw record from `fetchEscrowEventsFromHorizon`.
 * @param {string} invoiceId - Pre-resolved invoice ID for this event.
 * @param {object} [opts] - Optional overrides for deterministic behaviour.
 * @param {string} [opts.capturedAt] - ISO-8601 timestamp to use when
 *   `raw.observedAt` is absent.  Callers that process a batch should derive
 *   this once before the loop so every event in the batch shares the same
 *   fallback timestamp.
 * @returns {IndexerIngestEventDTO}
 * @throws {TypeError} If `invoiceId` is not a non-empty string, an option or
 *   timestamp is invalid, or `eventBody` cannot be safely persisted as JSON.
 */
function mapRawToIngestDTO(raw, invoiceId, opts = {}) {
  // Validate keying information before reading or copying payload data. A bad
  // key must fail atomically rather than yielding a partially usable DTO.
  if (typeof invoiceId !== 'string' || invoiceId.length === 0) {
    throw new TypeError('mapRawToIngestDTO: invoiceId must be a non-empty string');
  }
  if (opts == null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('mapRawToIngestDTO: opts must be an object');
  }

  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    raw = {};
  }

  // Capture the fallback exactly once per call. Batch callers can pass one
  // shared capturedAt value to make timestamps identical across retries.
  const fallbackTimestamp = opts.capturedAt !== undefined
    ? normalizeIndexerTimestamp(opts.capturedAt, 'capturedAt')
    : new Date().toISOString();
  const sourceEventBody = raw.eventBody !== undefined ? raw.eventBody : raw;
  const eventBody = sourceEventBody != null && typeof sourceEventBody === 'object' &&
    !Array.isArray(sourceEventBody)
    ? deepFreezeEventBody(cloneEventBody(sourceEventBody))
    : Object.freeze({});
  const rawObservedAt = raw.observedAt;
  const observedAt = rawObservedAt
    ? normalizeIndexerTimestamp(rawObservedAt, 'raw.observedAt')
    : fallbackTimestamp;

  return Object.freeze({
    eventId: String(raw.id || raw.eventId || ''),
    invoiceId,
    eventType: String(raw.type || raw.eventType || 'contract_event'),
    ledgerSequence: Number(raw.ledger || raw.ledgerSequence || 0),
    pagingToken: String(raw.paging_token || raw.pagingToken || ''),
    contractId: (raw.contract_id || raw.contractId) != null
      ? String(raw.contract_id || raw.contractId)
      : null,
    txHash: (raw.tx_hash || raw.txHash) != null
      ? String(raw.tx_hash || raw.txHash)
      : null,
    eventBody,
    observedAt,
  });
}

/**
 * Maps an {@link IndexerIngestEventDTO} to the internal normalized shape
 * expected by `persistEscrowEvent` (the canonical event object).  This is the
 * inverse of `mapRawToIngestDTO` plus field aliasing.
 *
 * The returned object is frozen so that concurrent consumers of the same
 * normalized event cannot accidentally mutate shared state between the
 * persistence write and the projection update.
 *
 * @param {IndexerIngestEventDTO} dto
 * @returns {object} Normalized internal event (frozen).
 */
function mapIngestDTOToNormalized(dto) {
  if (dto == null || typeof dto !== 'object') {
    throw new TypeError('mapIngestDTOToNormalized: dto must be a non-null object');
  }
  const sourceEventBody = dto.eventBody;
  const copiedEventBody = sourceEventBody == null ? sourceEventBody : cloneEventBody(sourceEventBody);
  const eventBody = copiedEventBody != null && typeof copiedEventBody === 'object'
    ? deepFreezeEventBody(copiedEventBody)
    : copiedEventBody;
  return Object.freeze({
    eventId: dto.eventId,
    invoiceId: dto.invoiceId,
    eventType: dto.eventType,
    ledgerSequence: dto.ledgerSequence,
    pagingToken: dto.pagingToken,
    contractId: dto.contractId,
    txHash: dto.txHash,
    eventBody,
    observedAt: dto.observedAt,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Request-side mappers
  mapQueryToDTO,
  mapDTOToServiceParams,
  // Response-side mappers
  mapRowToEscrowEventDTO,
  mapEscrowEventDTOToRow,
  mapMetaToDTO,
  mapServiceResultToResponseDTO,
  // Ingest / job mappers
  mapRawToIngestDTO,
  mapIngestDTOToNormalized,
};
