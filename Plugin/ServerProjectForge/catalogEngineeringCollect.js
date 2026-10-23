'use strict';
const { projectEngineeringDetail, DETAIL_LIMITS } = require('./catalogEngineeringDetail');

function check(ok, code = 'INVALID_ARGUMENT') {
    if (!ok) throw Object.assign(new Error(code), { code });
}

// Trusted host helper, not a renderer/tool endpoint. authorize is synchronous,
// read-only and must not mutate the DB. The caller owns any outer transaction
// and must reject source-wide update/import markers before full publication.
// Limits bound returned rows, not the work required for exact SQL aggregates.
function collectEngineeringDetail(store, projectId, options = {}) {
    check(options !== null && typeof options === 'object' && !Array.isArray(options));
    check(Object.keys(options).every(k => k === 'shared' || k === 'authorize'));
    check(options.shared === undefined || typeof options.shared === 'boolean');
    if (options.shared !== true) return projectEngineeringDetail(null);

    check(typeof projectId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId));
    check(typeof options.authorize === 'function');
    const db = store?.db;
    check(db?.open && typeof db.prepare === 'function' && typeof db.transaction === 'function');

    const read = () => {
        const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
        check(project, 'NOT_FOUND');
        // Authorize before returning availability or history information.
        check(options.authorize({ ...project }) === true, 'FORBIDDEN');
        check(project.availability === 'ready', 'BUSY');

        const batchTotal = db.prepare(`
            SELECT COUNT(*) AS total FROM batches b
            WHERE b.project_id=? AND EXISTS (
                SELECT 1 FROM nodes n WHERE n.batch_id=b.id AND n.project_id=b.project_id
            )
        `).get(projectId).total;

        const batches = db.prepare(`
            SELECT b.id,b.kind,b.reason,b.maid,b.created_at
            FROM batches b WHERE b.project_id=? AND EXISTS (
                SELECT 1 FROM nodes n WHERE n.batch_id=b.id AND n.project_id=b.project_id
            )
            ORDER BY b.id DESC LIMIT ?
        `).all(projectId, DETAIL_LIMITS.maxBatches);

        const batchStats = db.prepare(`
            SELECT COUNT(*) AS node_count,COUNT(DISTINCT file_path) AS file_total,
                COALESCE(SUM(added),0) AS added,COALESCE(SUM(removed),0) AS removed
            FROM nodes WHERE project_id=? AND batch_id=?
        `);
        const batchFiles = db.prepare(`
            SELECT DISTINCT file_path FROM nodes WHERE project_id=? AND batch_id=?
            ORDER BY file_path COLLATE BINARY LIMIT ?
        `);
        for (const batch of batches) {
            Object.assign(batch, batchStats.get(projectId, batch.id));
            batch.files = batchFiles.all(projectId, batch.id, DETAIL_LIMITS.maxBatchFiles)
                .map(row => row.file_path);
        }

        const fileTotal = db.prepare(`
            SELECT COUNT(DISTINCT file_path) AS total FROM nodes WHERE project_id=?
        `).get(projectId).total;
        const files = db.prepare(`
            SELECT file_path,COUNT(*) AS edits,
                COALESCE(SUM(added),0) AS added,COALESCE(SUM(removed),0) AS removed,
                MAX(id) AS last_node
            FROM nodes WHERE project_id=? GROUP BY file_path
            ORDER BY last_node DESC,file_path COLLATE BINARY LIMIT ?
        `).all(projectId, DETAIL_LIMITS.maxFiles);

        return projectEngineeringDetail({
            project, batches, files, batchTotal, fileTotal,
        }, { shared: true });
    };
    return db.inTransaction ? read() : db.transaction(read).deferred();
}

module.exports = { collectEngineeringDetail };