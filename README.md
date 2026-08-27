# @graciousstar/node-red-contrib-pdf-to-image

A Node-RED node that converts a PDF into PNG/JPEG images using
[MuPDF](https://mupdf.readthedocs.io) compiled to **WebAssembly** (the
[`mupdf`](https://www.npmjs.com/package/mupdf) npm package) — no native
dependencies, so it runs anywhere Node.js runs, including Alpine containers.

Supports page selection, DPI scaling, PNG/JPEG output with quality,
clockwise rotation, and the `<stem>_page_<n>.<ext>` file naming scheme
with collision counters.

## Install

```bash
npm install @graciousstar/node-red-contrib-pdf-to-image
```

Or install it from the Node-RED editor via **Manage palette → Install**,
searching for the full scoped name. Restart Node-RED afterwards so the node
is registered.

The node appears in the palette as **pdf-to-image** under the *PDF* category;
the npm scope does not change the node type, so existing flows keep working.

Running Node-RED in Docker? Add it to the image's `package.json` and rebuild
(`docker compose up -d --build`) rather than installing into a container that
gets replaced.

## Input

`msg.payload` can be:

| Type | Meaning |
| --- | --- |
| `Buffer` / `Uint8Array` / `ArrayBuffer` | PDF bytes |
| string starting with `%PDF` | base64-encoded PDF |
| string path | PDF file read from disk, on the host running Node-RED |
| string (base64) | base64-encoded PDF, auto-detected via the `%PDF` magic in the decoded bytes |
| object `{ data }` / `{ buffer }` / `{ path }` | any of the above |

Optional per-message overrides: `msg.filename` (output file stem),
`msg.dpi`, `msg.format`, `msg.rotation`, `msg.jpegQuality`,
`msg.pageMode`, `msg.pageRange`.

## Output

- `msg.payload` — image bytes (Buffer) or an array of Buffers; in
  **file** mode it is the written path / array of paths instead
- `msg.images` — array of `{ page, width, height, filename, path }`
- `msg.pageCount`, `msg.pages`, `msg.dpi`, `msg.format`, `msg.rotation`,
  `msg.filename`, `msg.durationMs`
- `msg.timings` — phase breakdown in ms:
  `{ openMs, renderMs, renderPerPageMs, saveMs, totalMs }`; each
  `msg.images[i]` entry also carries its own `renderMs`
- the node logs the same breakdown (`open / render (per-page) / save / total`)
  at info level
- with *one message per page* enabled: one message per page, each with
  `msg.page` set

## Example flow

```json
[{"id":"pdf2img-demo","type":"tab","label":"PDF -> image"},{"id":"pdf2img-inj","type":"inject","z":"pdf2img-demo","name":"read /data/input.pdf","props":[{"p":"payload"},{"p":"filename","v":"input.pdf","vt":"str"}],"repeat":"","crontab":"","once":false,"onceDelay":0.1,"topic":"","payload":"","payloadType":"str","x":140,"y":80,"wires":[["pdf2img-node"]]},{"id":"pdf2img-node","type":"pdf-to-image","z":"pdf2img-demo","name":"","pageMode":"all","pageRange":"1","dpi":200,"format":"PNG","jpegQuality":85,"rotation":0,"outputMode":"file","folder":"/data/pdf-output","stem":"","splitPages":false,"x":340,"y":80,"wires":[["pdf2img-debug"]]},{"id":"pdf2img-debug","type":"debug","z":"pdf2img-demo","name":"written files","active":true,"tosidebar":true,"console":false,"tostatus":false,"complete":"payload","targetType":"msg","statusVal":"","statusType":"auto","x":540,"y":80,"wires":[]}]
```

> The inject node in the example only *sends* the filename string; wire a
> file-read node (e.g. `fs-ops`) or an HTTP upload into this node to feed it
> actual PDF bytes.

## Notes

- Requires Node.js >= 18 (dynamic `import()` of the ESM-only `mupdf` package).
- JPEG output uses MuPDF's `asJPEG(quality)`; progressive and optimize
  flags are not exposed.
- The destination folder is a path on **whatever machine runs Node-RED**, not
  on the machine with the browser open. Node-RED must have write permission to
  it; the folder is created if missing. In Docker that path is inside the
  container, so point it at a mounted volume such as `/data` if the images
  need to outlive the container.

## Licensing

The code in this package is **MIT** (see `LICENSE`). The rendering engine it
depends on is not.

[`mupdf`](https://www.npmjs.com/package/mupdf) is **AGPL-3.0-or-later**, and
npm installs it alongside this node. What that means in practice:

- This package does not bundle or redistribute MuPDF — it calls it at
  runtime — so the MIT license above covers the wrapper code only.
- The *running combination* is covered by the AGPL. Node-RED is normally
  reachable over a network, and AGPL section 13 entitles users who interact
  with a program remotely to the corresponding source of that combined work.
- Artifex, MuPDF's owner, sells commercial licenses for deployments where AGPL
  terms do not fit.

If you are running this in an open-source or internal-only Node-RED project,
this needs no action from you. If you are embedding it in a closed-source
product or a hosted service you sell, read the AGPL terms first.

## Roadmap

### Relicensing the whole stack under MIT

The AGPL obligation comes entirely from the rendering engine, not from any
code in this package — so replacing the engine removes it. The intended
path is [`@hyzyla/pdfium`](https://www.npmjs.com/package/@hyzyla/pdfium)
(MIT wrapper around Google's BSD-3-Clause PDFium).

PDFium renders to a raw BGRA bitmap, so PNG encoding — which MuPDF gives us
for free via `asPNG()` — becomes this package's job. Benchmarking says the
engine swap is close to free, and the encoder choice decides everything.

#### Method

Two PDFs (a graphics-heavy 3.3 MB sample and a text/vector-heavy 4.2 MB
document) at 100/200/300 DPI, median of 3 runs, Node 24, WASM library
initialisation hoisted out of the timing. Encoder figures below are page 0
of the sample at 200 DPI (2172x1497); ratios are against `mupdf` +
`asPNG()` at 63 ms / 512 KB.

#### Rasterising: MuPDF and PDFium are the only serious options

| Engine | sample @200 | text doc @200 | License |
| --- | --- | --- | --- |
| `mupdf` | 1.00x | 1.00x | AGPL-3.0 |
| PDFium via `@hyzyla/pdfium` | 1.41x | 1.09x | BSD-3-Clause |
| `pdf.js` + `@napi-rs/canvas` | 6.21x | 4.89x | Apache-2.0 |

PDFium is at parity across most content, though it runs 2.45x slower on
heavy vector graphics at 300 DPI. `pdf.js` is 3.8x – 7.7x slower — it
interprets PDF content streams in JavaScript, and no canvas backend changes
that. `node-poppler` shells out to a CLI binary and is GPL.
`@embedpdf/pdfium` is the same engine behind a different binding.

**There is no faster rasteriser than what we already have.**

#### Encoding: this is the real decision

| Encoder | Type | Time | Size | License |
| --- | --- | --- | --- | --- |
| `mupdf` `asPNG()` (current) | WASM | 1.00x | 1.00x | AGPL-3.0 |
| [`@napi-rs/image`](https://www.npmjs.com/package/@napi-rs/image) | native + WASI | **0.42x** | 1.00x | MIT |
| `libdeflate` + ~60 lines (below) | **pure WASM** | **0.83x** | 1.00x | MIT |
| `libdeflate`, level 1 | pure WASM | 0.45x | 1.17x | MIT |
| [`@jsquash/png`](https://www.npmjs.com/package/@jsquash/png) | WASM | 0.32x | 2.82x | Apache-2.0 |
| [`fast-png`](https://www.npmjs.com/package/fast-png) | pure JS | 2.16x | 0.96x | MIT |
| `sharp` (libvips) | native | 2.19x | **0.53x** | Apache-2.0 |
| `pngjs` | pure JS | 2.9x | 1.53x | MIT |

Whole-pipeline results (PDFium + encoder, 3 pages, both PDFs, all DPIs):

| Pipeline | Time vs current | Size vs current |
| --- | --- | --- |
| PDFium + `@napi-rs/image` | 0.54x – 1.08x | 0.95x – 1.29x |
| PDFium + `@jsquash/png` | 0.61x – 0.93x | 2.5x – 4.1x |
| PDFium + `fast-png` | 1.9x – 2.7x | 0.96x – 1.33x |

Notes on the rejected options:

- **`oxipng` is not viable in a render path.** Level 0 costs 3.3x – 4.9x for
  1.06x – 1.18x the size; level 2 costs 22x – 24x; level 3 costs 67x – 72x
  for ~1% over level 2. Encoding with `@jsquash/png` then optimising with
  `oxipng` lands at 23x – 25x.
- **`@jsquash/png` exposes no quality knob** (`encode(data, width, height,
  bitDepth)`), which is why it is fast and why its files are 3x – 4x larger.
- **`sharp` produces by far the smallest files** — roughly half of everything
  else — but is 2x at 200 DPI and 6.4x at 300 DPI, and is native without a
  WASM fallback.
- **`fpnge`, `zune-png` and `mtpng` are not published to npm.** Using them
  means compiling to WASM yourself, which `libdeflate` makes unnecessary.
- **MuPDF's `asPNG()` is genuinely strong.** At 300 DPI it produced 377 KB
  where every permissive encoder needed 400 – 500 KB. This is not a weak
  component being replaced.

#### The two candidate paths

**`@napi-rs/image`** is fastest and size-neutral. It is an N-API addon, but
ships 13 prebuilt targets including `linux-x64-musl` and `linux-arm64-musl`
(verified working in an Alpine container), `linux-arm-gnueabihf` for 32-bit
Raspberry Pi, and a `wasm32-wasi` fallback for anything unlisted. Nothing
compiles at install time. Adopting it means rewording the "no native
dependencies" claim above, though the practical "runs anywhere" property
holds.

**`libdeflate` + a minimal PNG writer** keeps the pure-WASM story completely
intact and still beats the current implementation: same file size, 17%
faster. A PNG is filtered scanlines wrapped in a zlib stream, so the writer
is roughly 60 lines over
[`libdeflate`](https://www.npmjs.com/package/libdeflate). Use filter `None`
at level 6; level 12 is a trap, costing 29x for 15% size. The cost is owning
a PNG encoder — the prototype measured here handles only 8-bit RGB, with no
interlacing and a fixed filter, so it would need hardening and tests.

#### Remaining work

- Swap the engine calls in `pdf-to-image.js`. MuPDF is touched in only a few
  places: document open, `countPages()`, `Matrix` DPI scaling and rotation,
  and pixmap encoding.
- Pick an encoder per the trade-off above, and note PDFium only emits BGRA,
  so a channel repack is required on every page either way.
- Supply a JPEG encoder. `asJPEG(quality)` disappears with MuPDF; `jpeg-js`
  (BSD-3-Clause) is the permissive equivalent, and is not yet benchmarked.
- Regenerate any golden templates. PDFium's output is consistently **1px
  smaller** in each dimension (e.g. 1086x748 against MuPDF's 1087x749) due to
  different page-size rounding, so downstream template matching would need
  rebaselining.

Until this lands, treat the effective license of a deployed instance as AGPL.
