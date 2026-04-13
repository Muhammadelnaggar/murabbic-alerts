// /js/import-engine.js

import { IMPORT_PROFILES } from "/js/import-profiles.js";

function normKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

function toNumber(v) {
  if (isEmpty(v)) return "";
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : "";
}

function toInteger(v) {
  if (isEmpty(v)) return "";
  const n = parseInt(String(v).replace(/,/g, "").trim(), 10);
  return Number.isFinite(n) ? n : "";
}

function toDateYMD(v) {
  if (isEmpty(v)) return "";

  const s = String(v).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // d/m/yyyy أو dd/mm/yyyy
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    let [, dd, mm, yyyy] = m;
    dd = String(dd).padStart(2, "0");
    mm = String(mm).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // d-m-yyyy أو dd-mm-yyyy
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) {
    let [, dd, mm, yyyy] = m;
    dd = String(dd).padStart(2, "0");
    mm = String(mm).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // d/m/yy أو dd/mm/yy
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (m) {
    let [, dd, mm, yy] = m;
    dd = String(dd).padStart(2, "0");
    mm = String(mm).padStart(2, "0");
    const yyyy = Number(yy) >= 50 ? `19${yy}` : `20${yy}`;
    return `${yyyy}-${mm}-${dd}`;
  }

  // d-m-yy أو dd-mm-yy
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
  if (m) {
    let [, dd, mm, yy] = m;
    dd = String(dd).padStart(2, "0");
    mm = String(mm).padStart(2, "0");
    const yyyy = Number(yy) >= 50 ? `19${yy}` : `20${yy}`;
    return `${yyyy}-${mm}-${dd}`;
  }

  // yyyy/m/d
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    let [, yyyy, mm, dd] = m;
    dd = String(dd).padStart(2, "0");
    mm = String(mm).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) {
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return "";
}

function normalizeValueByType(type, value) {
  if (isEmpty(value)) return "";

  if (type === "number") return toNumber(value);
  if (type === "integer") return toInteger(value);
  if (type === "date") return toDateYMD(value);

  return String(value).trim();
}

function findBestColumn(headerMap, aliases) {
  for (const alias of aliases) {
    const k = normKey(alias);
    if (headerMap[k]) return headerMap[k];
  }
  return null;
}

export function detectBestProfile(headers = []) {
  const scored = IMPORT_PROFILES.map(profile => ({
    profile,
    score: profile.confidenceRules?.profileMatch
      ? profile.confidenceRules.profileMatch(headers)
      : 0
  })).sort((a, b) => b.score - a.score);

  return scored[0]?.profile || null;
}

export function buildHeaderMap(headers = []) {
  const map = {};
  headers.forEach((h) => {
    map[normKey(h)] = h;
  });
  return map;
}

export function mapColumns(headers = [], profile) {
  const headerMap = buildHeaderMap(headers);
  const result = {};

  Object.entries(profile.columnMap || {}).forEach(([internalField, aliases]) => {
    result[internalField] = findBestColumn(headerMap, aliases);
  });

  return result;
}

export function translateValue(field, value, profile) {
  if (isEmpty(value)) return "";

  const dict = profile.valueMap?.[field];
  if (!dict) return value;

  const key = normKey(value);
  return dict[key] || value;
}

export function mapRow(rawRow, mappedColumns, profile) {
  const row = {};

  Object.entries(mappedColumns).forEach(([internalField, sourceColumn]) => {
    row[internalField] = sourceColumn ? rawRow[sourceColumn] : "";
  });

  if (mappedColumns.productionStatus) {
    row._rawStatus = rawRow[mappedColumns.productionStatus] || "";
  }

  return row;
}

export function translateRow(row, profile) {
  const out = { ...row };

  Object.keys(out).forEach((field) => {
    out[field] = translateValue(field, out[field], profile);
  });

  return out;
}

export function inferRow(row, profile) {
  const out = { ...row };

  Object.entries(profile.inferRules || {}).forEach(([field, fn]) => {
    if (isEmpty(out[field]) && typeof fn === "function") {
      out[field] = fn(out);
    }
  });

  return out;
}

export function normalizeRow(row, profile) {
  const out = { ...row };

  Object.entries(profile.normalize || {}).forEach(([field, type]) => {
    out[field] = normalizeValueByType(type, out[field]);
  });

  return out;
}

export function validateRow(row, profile) {
  const missing = [];

  for (const field of profile.requiredInternalFields || []) {
    if (isEmpty(row[field])) missing.push(field);
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

export function buildPreviewRows(rawRows = [], profile) {
  const headers = rawRows.length ? Object.keys(rawRows[0]) : [];
  const mappedColumns = mapColumns(headers, profile);

  return rawRows.map((rawRow, index) => {
    const mapped = mapRow(rawRow, mappedColumns, profile);
    const translated = translateRow(mapped, profile);
    const inferred = inferRow(translated, profile);
    const normalized = normalizeRow(inferred, profile);
    const validation = validateRow(normalized, profile);

    return {
      rowIndex: index + 1,
      raw: rawRow,
      mapped,
      translated,
      normalized,
      ok: validation.ok,
      missing: validation.missing
    };
  });
}
