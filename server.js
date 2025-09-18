/**
 * spare-parts API
 *
 * - Reads LE.txt once at startup (streaming parse) into memory (array of objects).
 * - Exposes GET /spare-parts with filtering, pagination, sorting.
 * - Supports ?name= (partial, case-insensitive), ?sn= (serial number, exact or contains),
 *   ?search= (checks both name and serial), ?page= (1-based), ?page_size=, ?sort=
 *
 * Usage: put LE.txt in same directory and `npm install` then `npm start`
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const express = require('express');
const cors = require('cors');
app.use(cors());
const rateLimit = require('express-rate-limit');
app.use(rateLimit({ windowMs: 60_000, max: 100 }));


const PORT = process.env.PORT || 3300;
const CSV_FILE = path.join(__dirname, 'LE.txt'); // path to LE.txt
const DEFAULT_PAGE_SIZE = 30;

let parts = [];         // array with all parts (in-memory)
let snIndex = new Map(); // map from serial -> array of indices (for quick exact lookup)

/**
 * Normalize row fields: trim strings, convert numeric columns (price) to numbers if possible.
 * Adjust this function if your CSV column names differ.
 */
function normalizeRow(row) {
  const out = {};
  // copy all columns trimmed
  for (const k of Object.keys(row)) {
    // keep header keys as-is (trim)
    const key = k.trim();
    const val = row[k] == null ? '' : String(row[k]).trim();
    out[key] = val;
  }

  // Common heuristics (adjust to your headers)
  // If there is a column named price, try to parse it to number removing currency symbols and commas.
  if ('price' in out) {
    const raw = out['price'];
    const cleaned = raw.replace(/[^\d.\-]/g, ''); // remove non-numeric except dot and minus
    const n = Number(cleaned);
    out._price = Number.isFinite(n) ? n : null;
  } else {
    out._price = null;
  }

  // prepare lowercase searchable fields
  if ('name' in out) out._name = out['name'].toLowerCase();
  else out._name = '';

  // serial number field - guess common names
  const snCandidates = ['serial_number', 'sn', 'serial', 'part_number', 'partno'];
  let sn = '';
  for (const cand of snCandidates) {
    if (cand in out && out[cand]) {
      sn = out[cand];
      break;
    }
  }
  // fallback: try first column that looks like SN if none of the common names matched
  if (!sn) {
    const keys = Object.keys(out);
    if (keys.length > 0) sn = out[keys[0]] || '';
  }
  out._sn = String(sn).trim();

  return out;
}

/**
 * Load CSV into memory (returns Promise)
 */
function loadCsvIntoMemory() {
  return new Promise((resolve, reject) => {
    const results = [];
    const index = new Map();

    if (!fs.existsSync(CSV_FILE)) {
      return reject(new Error(`CSV file not found at ${CSV_FILE}`));
    }

    const stream = fs.createReadStream(CSV_FILE)
      .pipe(csv({ skipLines: 0, strict: false }))
      .on('data', (row) => {
        try {
          const normalized = normalizeRow(row);
          // keep original row fields plus internal ones
          const obj = { ...row, ...normalized };
          const idx = results.length;
          results.push(obj);

          const snKey = normalized._sn;
          if (snKey) {
            const arr = index.get(snKey) || [];
            arr.push(idx);
            index.set(snKey, arr);
          }
        } catch (err) {
          // ignore single-row parse errors but log
          console.error('Row parse error:', err);
        }
      })
      .on('end', () => {
        parts = results;
        snIndex = index;
        console.log(`Loaded ${parts.length} rows into memory.`);
        resolve();
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

/**
 * Generic sorting function that supports:
 * - sort=price or sort=-price
 * - works with numeric internal field _price if present, else falls back to string compare
 */
function sortParts(array, sortParam) {
  if (!sortParam) return array;
  let key = sortParam;
  let desc = false;
  if (sortParam.startsWith('-')) {
    desc = true;
    key = sortParam.slice(1);
  }

  // map known keys to internal ones
  const keyMap = {
    price: '_price',
    name: 'name',
    sn: '_sn',
    serial: '_sn'
  };
  const resolvedKey = keyMap[key] || key; // default to whatever user provided

  // comparator
  const cmp = (a, b) => {
    const va = a[resolvedKey];
    const vb = b[resolvedKey];

    // handle numeric compare if both are numbers
    const na = typeof va === 'number' && !isNaN(va);
    const nb = typeof vb === 'number' && !isNaN(vb);
    if (na && nb) {
      return va - vb;
    }

    // fallback to string compare
    const sa = (va == null) ? '' : String(va).toLowerCase();
    const sb = (vb == null) ? '' : String(vb).toLowerCase();
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  };

  const sorted = array.slice().sort((a, b) => {
    const r = cmp(a, b);
    return desc ? -r : r;
  });
  return sorted;
}

/**
 * Apply filters:
 * - name: partial, case-insensitive on 'name' column (or _name prepared)
 * - sn: if exact match exists in index, use it for speed; otherwise 'contains'
 * - search: general search both sn and name (contains)
 */
function filterParts({ name, sn, search }) {
  // Fast exact serial lookup, if sn provided and exists in index
  if (sn && snIndex.has(sn) && (!name && !search)) {
    const idxs = snIndex.get(sn);
    return idxs.map(i => parts[i]);
  }

  // otherwise filter whole array
  const nameLc = name ? name.toLowerCase() : null;
  const searchLc = search ? search.toLowerCase() : null;
  const snQuery = sn ? String(sn).toLowerCase() : null;

  return parts.filter((p) => {
    // name filter
    if (nameLc) {
      const target = (p._name || '').toLowerCase();
      if (!target.includes(nameLc)) return false;
    }
    if (snQuery) {
      const targetSn = (p._sn || '').toLowerCase();
      if (!targetSn.includes(snQuery)) return false;
    }
    if (searchLc) {
      // match either name or sn
      const inName = (p._name || '').includes(searchLc);
      const inSn = (p._sn || '').toLowerCase().includes(searchLc);
      if (!(inName || inSn)) return false;
    }
    return true;
  });
}

/**
 * Pagination helper (1-based page)
 */
function paginate(array, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const total = array.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.max(1, Math.min(page, totalPages));
  const start = (p - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  const data = array.slice(start, end);
  return {
    page: p,
    page_size: pageSize,
    total,
    total_pages: totalPages,
    data
  };
}


/* ---------------- EXPRESS server ---------------- */
const app = express();

// simple health endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', rows_loaded: parts.length });
});

/**
 * GET /spare-parts
 * Query params:
 *   name, sn, search, page (1-based), page_size, sort
 */
app.get('/spare-parts', (req, res) => {
  try {
    const { name, sn, search, sort } = req.query;
    const page = parseInt(req.query.page || '1', 10) || 1;
    const pageSize = parseInt(req.query.page_size || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE;

    // filter
    let filtered = filterParts({ name, sn, search });

    // sort (sort applies to full filtered set, then paginate)
    if (sort) {
      filtered = sortParts(filtered, sort);
    }

    // paginate
    const result = paginate(filtered, page, pageSize);

    // Return only data rows plus metadata
    res.setHeader('Content-Type', 'application/json');
    res.json(result);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'internal_server_error' });
  }
});

/**
 * GET /spare-parts/:id
 * Attempt to fetch by exact serial number (most efficient).
 */
app.get('/spare-parts/:id', (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'missing id' });

  if (snIndex.has(id)) {
    const arr = snIndex.get(id).map(i => parts[i]);
    return res.json({ total: arr.length, data: arr });
  }

  // fallback: search contains
  const found = parts.filter(p => (p._sn || '').toLowerCase().includes(String(id).toLowerCase()));
  return res.json({ total: found.length, data: found });
});

/**
 * POST /reload  (manual reload of LE.txt)
 * Note: This is unprotected — in production add auth.
 */
app.post('/reload', async (req, res) => {
  try {
    await loadCsvIntoMemory();
    res.json({ status: 'reloaded', rows: parts.length });
  } catch (err) {
    console.error('Reload failed:', err);
    res.status(500).json({ error: 'reload_failed', message: String(err) });
  }
});

/* Start by loading CSV then start server */
(async () => {
  console.log('Loading CSV into memory from', CSV_FILE);
  try {
    await loadCsvIntoMemory();

    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
      console.log('Endpoints: GET /spare-parts , GET /spare-parts/:id , POST /reload');
    });
  } catch (err) {
    console.error('Failed to load CSV at startup:', err);
    process.exit(1);
  }
})();
