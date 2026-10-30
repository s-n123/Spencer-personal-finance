# Test fixtures (committed)

Only non-personal test data lives here. Owner photos never go in this folder: they belong in
`/fixtures/` at the repo root, which is gitignored (the repo is public).

| File | Provenance |
|---|---|
| `example.heic` | Third-party sample image, used only to test HEIC decoding (`src/server/media/heic.test.ts`, `image.test.ts`). See below. |
| `images.ts` | Synthetic images generated in memory with sharp at test time. Nothing is a real photo; the EXIF GPS values are arbitrary. `heicWithRotation()` derives a rotated variant of `example.heic` in memory (an added `irot` property); nothing derived is committed. |

## `example.heic`

- **Source:** `https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic`
  (the `examples/` folder of the libheif repository, <https://github.com/strukturag/libheif>).
- **Retrieved:** 2026-10-30, unmodified.
- **SHA-256:** `7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2` (718,114 bytes).
- **Contents:** a 1280×854 HEVC-coded HEIF image; `ftyp` major brand `mif1`, compatible brands
  `mif1 heic hevc`.
- **License:** the libheif repository is distributed under the GNU LGPL-3.0 (the library) with its
  sample applications under MIT, per its README ("License" section) and `COPYING`. The sample image
  carries no separate license statement; it is used here unmodified, solely as a decoder test
  input, and is not shipped with the app.
