// Built plugin entry — runs in an isolated child process.
const { definePlugin } = require('trek-plugin-sdk');

function ok(data) {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) };
}

function bad(status, message) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: message }) };
}

function toDto(row) {
  return {
    id: row.id,
    fullFileId: row.full_file_id,
    thumbFileId: row.thumb_file_id,
    caption: row.caption || '',
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name || '',
    width: row.width || null,
    height: row.height || null,
    createdAt: row.created_at,
  };
}

async function requireTripAccess(ctx, tripId) {
  const trip = await ctx.trips.getById(tripId);
  if (!trip) throw Object.assign(new Error('no access to this trip'), { status: 403 });
  return trip;
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate(
      '001_init',
      `CREATE TABLE IF NOT EXISTS photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL,
        full_file_id INTEGER NOT NULL,
        thumb_file_id INTEGER NOT NULL,
        caption TEXT,
        uploaded_by INTEGER,
        uploaded_by_name TEXT,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL
      )`
    );
    ctx.log.info('trip-gallery loaded');
  },

  events: [
    {
      // Keeps the gallery in sync when a photo is removed from the trip's Files
      // tab directly (rather than from this gallery's own delete button) — drop
      // whichever photo row referenced it as its full or thumb file. Event
      // handlers run userless (no ctx.trips/files/ws here), so this only touches
      // our own db:own table.
      on: 'file:deleted',
      async handler({ tripId, entityId }, ctx) {
        if (!tripId || !entityId) return;
        await ctx.db.exec(
          'DELETE FROM photos WHERE trip_id = ? AND (full_file_id = ? OR thumb_file_id = ?)',
          tripId,
          entityId,
          entityId
        );
      },
    },
  ],

  routes: [
    {
      method: 'GET',
      path: '/photos',
      auth: true,
      async handler(req, ctx) {
        const tripId = Number(req.query.tripId);
        if (!tripId) return bad(400, 'tripId is required');
        try {
          await requireTripAccess(ctx, tripId);
        } catch (e) {
          return bad(e.status || 403, e.message);
        }
        const rows = await ctx.db.query(
          'SELECT * FROM photos WHERE trip_id = ? ORDER BY id DESC',
          tripId
        );

        // Self-heal rows left over from files deleted before this plugin subscribed to
        // file:deleted (or from any other way the underlying file could have gone away) —
        // ctx.files.list excludes trash, so anything not in it is gone. Without this the
        // client keeps retrying a fetch that can never succeed.
        const live = new Set((await ctx.files.list(tripId)).map((f) => f.id));
        const good = [];
        const staleIds = [];
        for (const row of rows) {
          if (live.has(row.full_file_id) && live.has(row.thumb_file_id)) good.push(row);
          else staleIds.push(row.id);
        }
        if (staleIds.length) {
          const placeholders = staleIds.map(() => '?').join(',');
          await ctx.db.exec(`DELETE FROM photos WHERE id IN (${placeholders})`, ...staleIds);
        }

        return ok({ photos: good.map(toDto) });
      },
    },
    {
      // Uploads a single image chunk (either the full-res photo or its thumbnail) and
      // returns the stored file's id. The host applies a small (~100kb) body-size limit
      // to every plugin route, so a photo's full image and thumbnail must be sent as two
      // separate requests rather than bundled into one — see /photos below, which only
      // ever receives the two resulting fileIds plus small metadata.
      method: 'POST',
      path: '/photos/upload-image',
      auth: true,
      async handler(req, ctx) {
        const b = req.body || {};
        const tripId = Number(b.tripId);
        if (!tripId) return bad(400, 'tripId is required');
        if (!b.base64 || !b.filename) return bad(400, 'filename and base64 are required');
        try {
          await requireTripAccess(ctx, tripId);
        } catch (e) {
          return bad(e.status || 403, e.message);
        }

        try {
          const file = await ctx.files.create(tripId, {
            name: String(b.filename).slice(0, 150),
            mimetype: 'image/jpeg',
            content_base64: b.base64,
          });
          return ok({ fileId: file.id });
        } catch (e) {
          return bad(400, 'could not store image: ' + e.message);
        }
      },
    },
    {
      method: 'POST',
      path: '/photos',
      auth: true,
      async handler(req, ctx) {
        const b = req.body || {};
        const tripId = Number(b.tripId);
        const fullFileId = Number(b.fullFileId);
        const thumbFileId = Number(b.thumbFileId);
        if (!tripId) return bad(400, 'tripId is required');
        if (!fullFileId || !thumbFileId) return bad(400, 'fullFileId and thumbFileId are required');
        try {
          await requireTripAccess(ctx, tripId);
        } catch (e) {
          return bad(e.status || 403, e.message);
        }

        const createdAt = new Date().toISOString();
        await ctx.db.exec(
          `INSERT INTO photos
            (trip_id, full_file_id, thumb_file_id, caption, uploaded_by, uploaded_by_name, width, height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          tripId,
          fullFileId,
          thumbFileId,
          b.caption ? String(b.caption).slice(0, 500) : null,
          req.user ? req.user.id : null,
          req.user ? req.user.username : null,
          b.width || null,
          b.height || null,
          createdAt
        );

        await ctx.ws.broadcastToTrip(tripId, 'photo-added', {});
        return ok({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/photos/content',
      auth: true,
      async handler(req, ctx) {
        const b = req.body || {};
        const tripId = Number(b.tripId);
        const fileIds = Array.isArray(b.fileIds) ? b.fileIds.map(Number).filter(Boolean) : [];
        if (!tripId || !fileIds.length) return bad(400, 'tripId and fileIds are required');
        try {
          await requireTripAccess(ctx, tripId);
        } catch (e) {
          return bad(e.status || 403, e.message);
        }

        // Only allow reading files that belong to this plugin's own photo rows in this trip.
        const placeholders = fileIds.map(() => '?').join(',');
        const owned = await ctx.db.query(
          `SELECT DISTINCT v FROM (
             SELECT full_file_id AS v FROM photos WHERE trip_id = ?
             UNION ALL
             SELECT thumb_file_id AS v FROM photos WHERE trip_id = ?
           ) WHERE v IN (${placeholders})`,
          tripId,
          tripId,
          ...fileIds
        );
        const allowed = new Set(owned.map((r) => r.v));

        const result = {};
        for (const fileId of fileIds) {
          if (!allowed.has(fileId)) continue;
          try {
            const content = await ctx.files.getContent(tripId, fileId);
            result[fileId] = { mimetype: content.mimetype, contentBase64: content.content_base64 };
          } catch (e) {
            // skip files that fail to load (e.g. trashed)
          }
        }
        return ok({ files: result });
      },
    },
    {
      method: 'POST',
      path: '/photos/caption',
      auth: true,
      async handler(req, ctx) {
        const b = req.body || {};
        const tripId = Number(b.tripId);
        const photoId = Number(b.photoId);
        if (!tripId || !photoId) return bad(400, 'tripId and photoId are required');
        try {
          await requireTripAccess(ctx, tripId);
        } catch (e) {
          return bad(e.status || 403, e.message);
        }
        await ctx.db.exec(
          'UPDATE photos SET caption = ? WHERE id = ? AND trip_id = ?',
          b.caption ? String(b.caption).slice(0, 500) : null,
          photoId,
          tripId
        );
        await ctx.ws.broadcastToTrip(tripId, 'photo-updated', {});
        return ok({ ok: true });
      },
    },
    {
      method: 'POST',
      path: '/photos/delete',
      auth: true,
      async handler(req, ctx) {
        const b = req.body || {};
        const tripId = Number(b.tripId);
        const photoId = Number(b.photoId);
        if (!tripId || !photoId) return bad(400, 'tripId and photoId are required');
        try {
          await requireTripAccess(ctx, tripId);
        } catch (e) {
          return bad(e.status || 403, e.message);
        }
        const rows = await ctx.db.query('SELECT * FROM photos WHERE id = ? AND trip_id = ?', photoId, tripId);
        if (!rows.length) return bad(404, 'photo not found');
        const row = rows[0];
        try {
          await ctx.files.softDelete(tripId, row.full_file_id);
          await ctx.files.softDelete(tripId, row.thumb_file_id);
        } catch (e) {
          // continue removing our own record even if the underlying file was already gone
        }
        await ctx.db.exec('DELETE FROM photos WHERE id = ?', photoId);
        await ctx.ws.broadcastToTrip(tripId, 'photo-deleted', {});
        return ok({ ok: true });
      },
    },
  ],
});
