// Tiny CSV parser + serializer. Handles quoted fields, embedded commas,
// embedded newlines, doubled quotes for escaping. No dependencies.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (ch === '\r') { /* skip */ }
      else { cur += ch; }
    }
  }
  // Flush final cell/row if non-empty
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
  // Drop trailing empty row from trailing newline
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

// Parse with header row → array of objects keyed by lowercased header.
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { headers: rows[0] || [], items: [] };
  const headers = rows[0].map((h) => String(h || '').trim());
  const items = rows.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = r[i] != null ? r[i] : '';
    return obj;
  });
  return { headers, items };
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function serializeCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(csvEscape).join(','));
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  }
  return lines.join('\n');
}

// Convenience: trigger a browser download with a Blob.
export function downloadBlob(filename, content, mime = 'text/csv;charset=utf-8') {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch {
    return false;
  }
}

// Job-specific helpers.
export const JOB_CSV_HEADERS = ['title', 'company', 'status', 'jobUrl', 'source', 'submittedAt', 'location', 'compensation', 'workMode', 'employmentType', 'notes'];

export function jobsToCsv(jobs) {
  return serializeCsv(JOB_CSV_HEADERS, jobs.map((j) => ({
    title: j.title || '',
    company: j.company || '',
    status: j.status || '',
    jobUrl: j.jobUrl || '',
    source: j.source || '',
    submittedAt: j.submittedAt || '',
    location: j.location || '',
    compensation: j.compensation || '',
    workMode: j.workMode || '',
    employmentType: j.employmentType || '',
    notes: j.notes || ''
  })));
}

// Normalize CSV row keys to known job fields. Accepts any case + common aliases.
export function csvRowToJob(row) {
  const get = (k) => {
    const lc = k.toLowerCase();
    for (const key of Object.keys(row)) if (key.toLowerCase() === lc) return row[key];
    return '';
  };
  return {
    title: get('title') || get('job title'),
    company: get('company') || get('employer'),
    status: (get('status') || 'started').toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    jobUrl: get('jobUrl') || get('url') || get('link'),
    source: get('source') || 'CSV import',
    submittedAt: get('submittedAt') || get('applied') || '',
    location: get('location'),
    compensation: get('compensation') || get('salary'),
    workMode: get('workMode') || get('work mode'),
    employmentType: get('employmentType') || get('employment type'),
    notes: get('notes')
  };
}
