# trip-gallery

Shared photo gallery for your trip, with automatic HEIC conversion.

![screenshot](./docs/screenshot.png)

## What it does

Trip Gallery adds a dedicated **Gallery** tab to every trip in TREK — a proper
photo-sharing surface, instead of digging through the generic Files tab. Anyone on
the trip can drop in photos from their phone or computer and they show up for
everyone else instantly, grouped in a simple grid with a full-size lightbox view.

The problem this solves is cross-device photo sharing on a group trip: an iPhone
saves photos as HEIC by default, which most Android phones, Windows PCs, and
browsers can't display at all. Trip Gallery converts every photo to JPEG **in the
browser at upload time** — no server-side image processing, no native
dependencies — so it doesn't matter whether a photo came from an iPhone, an
Android phone, or a laptop: everyone sees the same picture. Uploads are also
automatically downscaled and a lightweight thumbnail is generated client-side, so
the gallery grid stays fast even with a big trip full of photos.

Once uploaded, any trip member can open a photo to see who added it and when, add
or edit a caption, or remove it. New uploads from other members appear live via a
trip broadcast, so the gallery refreshes itself while people are adding photos
during the trip.

Under the hood, photos are stored using TREK's own trip-file storage (so they're
included in TREK's regular backups), with a small amount of the plugin's own
database used to track captions, uploader, and thumbnail/full-image pairing.

## Screenshots

Show it in context. Commit a `docs/screenshot.png` — it's what the store card
shows. A 16:9 image (e.g. 1600×900) with your plugin centred and some margin
looks best (the card crops the edges).

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Stores each photo's caption, uploader, and the pairing between its thumbnail and full-size file, keyed by trip. |
| `db:read:trips` | Checks that the requesting user is actually a member of the trip before showing or accepting photos for it. |
| `db:read:files` | Needed alongside file storage so the plugin's own file records are visible to the trip. |
| `db:read:files:content` | Reads back the stored thumbnail/full-image bytes so the gallery grid and lightbox can display them. |
| `db:write:files` | Stores each converted photo (and its thumbnail) as a trip file, and removes them when a photo is deleted. |
| `ws:broadcast:trip` | Notifies everyone else viewing the trip when a photo is added, edited, or removed, so the gallery refreshes live. |
| `events:subscribe` | Listens for `file:deleted` so removing a photo from the trip's Files tab also removes it from the gallery. |

## Setup

No configuration needed — install the plugin, activate it, and grant the
permissions above. A new **Gallery** tab appears on every trip. Uploading works
from any modern browser; HEIC/HEIF conversion happens automatically and needs no
extra setup on the admin or user side.

## License

MIT
