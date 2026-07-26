# Resize images

Downsizes any image under `src/assets/images/trips/` whose largest dimension
exceeds 2048px, overwriting it in place. EXIF metadata (capture date, GPS,
etc.) is preserved via sharp's `withMetadata()`; images already at or under
the limit are left untouched.

This is a one-off/occasional cleanup tool for shrinking full-resolution
photos already committed to the repo. New photos downloaded via
[`util/google-photos`](../google-photos/README.md) are already resized to
the same 2048px limit at import time, so you shouldn't normally need to run
this against freshly-imported trips.

## Setup

```bash
cd util/resizeImages
npm install
```

## Usage

From the repo root:

```bash
node util/resizeImages/resizeImages.js
```

Preview what would change without writing anything:

```bash
node util/resizeImages/resizeImages.js --dry-run
```

Limit the scan to a single trip's folder (name matches
`src/assets/images/trips/<slug>/`):

```bash
node util/resizeImages/resizeImages.js 2023-mouse
node util/resizeImages/resizeImages.js --dry-run 2023-mouse
```

The script prints each resized file's old/new dimensions and file size, plus
a total bytes-saved summary at the end.
