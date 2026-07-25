# Google Photos trip importer

Pick a trip, open Google Photos to the right time frame, select photos, and
have them downloaded straight into `src/assets/images/trips/<slug>/` as
`.jpg` files.

It uses the [Google Photos Picker API](https://developers.google.com/photos/picker/guides/get-started-picker),
which is Google's replacement for the old Library API's date-search — Google
removed programmatic library search in March 2025, so **you** still have to
search/scroll to the right dates inside the picker UI. This tool works out
the +/- 15 day window from the trip's front matter date and prints it so you
can paste it into the picker's search box.

## One-time setup

### 1. Create a Google Cloud OAuth client

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or select) a project.
2. **APIs & Services → Library** → search for **"Google Photos Picker API"** (not the similarly-named "Google Picker API") → **Enable**.
3. **APIs & Services → OAuth consent screen** → configure it (External is fine for personal use) → add your own Google account as a **Test user**. You don't need to add the picker scope here; the app requests it directly.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type **Desktop app** → Create.
5. Download the JSON for that client and save it as:

   ```text
   util/google-photos/credentials.json
   ```

   This file is git-ignored — it never gets committed.

### 2. Install dependencies

```bash
cd util/google-photos
npm install
```

## Usage

From the repo root:

```bash
node util/google-photos/import-photos.js
```

or from inside `util/google-photos/`:

```bash
npm run import-photos
```

You can also skip the interactive trip picker by passing a trip slug directly
(the filename of `src/content/trips/<slug>.md`, without the extension):

```bash
node util/google-photos/import-photos.js 2026-happy-isle-proulx
```

What happens:

1. The first run opens a browser window to authorize your Google account (scope: view photos you pick). A `token.json` is saved afterwards so future runs skip this step.
2. The tool reads the trip's `date` front matter and prints a +/- 15 day range.
3. A Google Photos picker session opens in your browser. Use the search box for the date range printed in the terminal, then select any number of photos and tap **Done**.
4. Once you're done picking, the tool downloads each photo, converts it to a JPEG (auto-rotated using EXIF orientation), and saves it into `src/assets/images/trips/<slug>/`, preserving each photo's original filename (extension swapped to `.jpg`) and never overwriting existing files.
5. Selected videos are skipped — this tool only imports photos.

Afterwards, reference the new files from the trip's markdown/MDX, e.g.:

```yaml
coverImage: "../../assets/images/trips/2026-happy-isle-proulx/IMG_0752.jpg"
```

## Troubleshooting

- **"insufficient authentication scopes" / stuck picker** — delete `util/google-photos/token.json` and rerun to re-authorize.
- **"Missing .../credentials.json"** — redo step 1 above and confirm the file is at `util/google-photos/credentials.json`.
- **HEIC/HEIF conversion errors** — the bundled `sharp` binary generally reads HEIC, but if you hit a decode error on an iPhone photo, convert it manually first or install a `libvips` build with HEIF support.
- **`FAILED_PRECONDITION` on session creation** — the Google account used to authorize doesn't have an active Google Photos library.
