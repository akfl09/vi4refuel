// One-time cleanup: find duplicate employee records by name in the Firestore
// `employees` collection and delete the duplicates, keeping the record whose
// id has the most associated entries in `timeEntries` (so payroll data is not
// orphaned). Use --dry-run to preview without deleting.
//
//   node scripts/cleanup-duplicate-employees.mjs --dry-run
//   node scripts/cleanup-duplicate-employees.mjs

const PROJECT_ID = 'vi4refuel-timesheets';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const DRY_RUN = process.argv.includes('--dry-run');

function decodeValue(v) {
    if (v == null) return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('nullValue' in v) return null;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
    if ('mapValue' in v) {
        const out = {};
        for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = decodeValue(val);
        return out;
    }
    return null;
}

function decodeFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) out[k] = decodeValue(v);
    return out;
}

async function listAll(collection) {
    const docs = [];
    let pageToken = null;
    do {
        const url = new URL(`${BASE}/${collection}`);
        url.searchParams.set('pageSize', '300');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`List ${collection} failed: ${res.status} ${await res.text()}`);
        const data = await res.json();
        for (const d of data.documents || []) {
            const docId = d.name.split('/').pop();
            docs.push({ docId, ...decodeFields(d.fields) });
        }
        pageToken = data.nextPageToken || null;
    } while (pageToken);
    return docs;
}

async function deleteDoc(collection, docId) {
    const res = await fetch(`${BASE}/${collection}/${encodeURIComponent(docId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Delete ${docId} failed: ${res.status} ${await res.text()}`);
}

async function main() {
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`);

    console.log('Loading employees...');
    const employees = await listAll('employees');
    console.log(`  ${employees.length} employees`);

    console.log('Loading time entries...');
    const timeEntries = await listAll('timeEntries');
    console.log(`  ${timeEntries.length} time entries`);

    const entryCount = new Map();
    for (const e of timeEntries) {
        const key = e.employeeId;
        entryCount.set(key, (entryCount.get(key) || 0) + 1);
    }

    const byName = new Map();
    for (const emp of employees) {
        const name = emp.name || '(no name)';
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(emp);
    }

    const toDelete = [];
    for (const [name, group] of byName) {
        if (group.length <= 1) continue;
        console.log(`\nDuplicate name "${name}" (${group.length} records):`);
        const annotated = group.map(e => ({ ...e, _entries: entryCount.get(e.id) || 0 }));
        for (const e of annotated) {
            console.log(`  docId=${e.docId}  id=${e.id}  entries=${e._entries}`);
        }
        annotated.sort((a, b) => b._entries - a._entries);
        const keep = annotated[0];
        const drop = annotated.slice(1);
        console.log(`  -> keep   docId=${keep.docId} (id=${keep.id}, entries=${keep._entries})`);
        for (const d of drop) {
            console.log(`  -> delete docId=${d.docId} (id=${d.id}, entries=${d._entries})`);
            toDelete.push(d);
        }
    }

    if (toDelete.length === 0) {
        console.log('\nNo duplicates found.');
        return;
    }

    if (DRY_RUN) {
        console.log(`\n[dry-run] Would delete ${toDelete.length} document(s).`);
        return;
    }

    console.log(`\nDeleting ${toDelete.length} duplicate(s)...`);
    for (const d of toDelete) {
        await deleteDoc('employees', d.docId);
        console.log(`  deleted ${d.docId}`);
    }
    console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
