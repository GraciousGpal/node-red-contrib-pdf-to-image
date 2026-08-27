# @graciousstar/node-red-contrib-pdf-to-image

A Node-RED node that converts a PDF into PNG/JPEG images using
[PDFium](https://pdfium.googlesource.com/pdfium/) compiled to **WebAssembly**
(via [`@hyzyla/pdfium`](https://www.npmjs.com/package/@hyzyla/pdfium)) for
rasterising, and [`@napi-rs/image`](https://www.npmjs.com/package/@napi-rs/image)
for PNG/JPEG encoding.

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
`msg.pageMode`, `msg.pageRange`, `msg.transparent`.

### Transparent background

Pages render onto white by default. Enable **Transparent background** (or set
`msg.transparent`) to keep the page background transparent in the PNG alpha
channel. JPEG has no alpha channel, so the option is ignored with a warning
when the output format is JPEG — otherwise a transparent background would
silently come out black.

## Output

- `msg.payload` — image bytes (Buffer) or an array of Buffers; in
  **file** mode it is the written path / array of paths instead
- `msg.images` — array of `{ page, width, height, filename, path }`
- `msg.pageCount`, `msg.pages`, `msg.dpi`, `msg.format`, `msg.rotation`,
  `msg.filename`, `msg.transparent`, `msg.durationMs`
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

- Requires Node.js >= 18. Both engine packages expose CommonJS entry points.
- JPEG output uses `@napi-rs/image`'s `jpegSync(quality)`. At the same
  quality setting it currently produces larger files than the MuPDF build
  did — see **Known gaps** below.
- The destination folder is a path on **whatever machine runs Node-RED**, not
  on the machine with the browser open. Node-RED must have write permission to
  it; the folder is created if missing. In Docker that path is inside the
  container, so point it at a mounted volume such as `/data` if the images
  need to outlive the container.

## Licensing

Everything in this package, and every dependency it pulls in, is permissively
licensed:

| Component | Role | License |
| --- | --- | --- |
| this package | node | MIT |
| `@hyzyla/pdfium` | rasterising | MIT (over BSD-3-Clause PDFium) |
| `@napi-rs/image` | PNG/JPEG encoding | MIT |

There is no AGPL obligation. The `main` branch depends on `mupdf`
(AGPL-3.0-or-later), which covers the running combination and requires
offering source to users who reach it over a network; that constraint does
not apply here.

`@napi-rs/image` is a Node-API addon rather than pure WebAssembly. It ships
13 prebuilt targets — including `linux-x64-musl` and `linux-arm64-musl`
(verified in an Alpine container), `linux-arm-gnueabihf` for 32-bit Raspberry
Pi, and a `wasm32-wasi` fallback — so nothing is compiled at install time and
no toolchain is required.

## Verification

Rendered output was compared against the MuPDF implementation by
downsampling both to an 8x8 luminance grid, which tolerates antialiasing and
the 1px size difference but not a wrong orientation:

| Rotation | Mean difference (0-255) | Result |
| --- | --- | --- |
| 0 | 3.09 | match |
| 90 | 3.07 | match |
| 180 | 3.09 | match |
| 270 | 3.11 | match |

A control comparing rot0 against rot90 from the same engine scores 43.0,
confirming the check can actually detect a mismatch. The residual ~3.1 is
rasteriser variance, present at rotation 0 where no rotation is applied.

Measured against the MuPDF build on the same machine, 3 pages at 200 DPI:
332 ms against 446 ms, a 26% improvement.

## Known gaps

- **JPEG files are larger at equal quality.** The quality dial is not
  mis-scaled — both encoders land at the same PSNR for the same setting
  (q85 gives 40.17 dB here against MuPDF's 40.34 dB). `@napi-rs/image` is
  simply less space-efficient: 17% larger on graphics-heavy pages and 31% –
  34% larger on text-heavy ones, measured at matched PSNR.

  The encoder itself is **2.3x faster** (31 ms against 74 ms for a
  1629x1122 page); where end-to-end JPEG timings look slower it is PDFium's
  rasterising of that page, not the encoding.

  Alternatives were measured and rejected:

  | Approach | Result |
  | --- | --- |
  | `compressJpegSync` (MozJPEG recompress) | No gain — 350 KB vs 351 KB at the same PSNR, 2.4x slower. Re-encoding an already-lossy JPEG cancels the benefit. |
  | `@jsquash/jpeg` (MozJPEG from raw pixels) | ~6% smaller at matched PSNR but **7x – 11x slower** (232 – 354 ms). |

  No permissive JPEG encoder tested matches MuPDF's efficiency at an
  acceptable speed. If output size matters more than throughput for your
  JPEG usage, this branch is a regression; for PNG it is a clear win.

- **Output is 1px smaller in each dimension** (e.g. 2172x1497 against
  2173x1498) because PDFium rounds page sizes differently. Anything holding a
  golden image produced by the MuPDF build would need rebaselining. Note this
  does not affect the NodeRed-Test palette repo, whose `golden-compare`
  template is a camera capture and is not fed from this node.
- The installed binary is 16.5 MB, against 12.5 KB for the `main` package.
- Installing with `--omit=optional` leaves `@napi-rs/image` unable to find
  its native binding, failing at require time rather than install time.
