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
(MIT wrapper around Google's BSD-3-Clause PDFium), which is also WebAssembly
and so preserves the no-native-dependencies property that lets this node run
anywhere Node.js does.

Scope of the change:

- Swap the engine calls in `pdf-to-image.js`. MuPDF is touched in only a few
  places: document open, `countPages()`, `Matrix` DPI scaling and rotation,
  and pixmap encoding.
- Supply an image encoder. MuPDF gives us `asPNG()` / `asJPEG(quality)` for
  free; PDFium renders to a raw bitmap, so encoding becomes this package's
  job. It needs a permissive, pure-JS or WASM encoder (`pngjs`, `jpeg-js`)
  rather than a native one like `sharp`, or the portability gain is lost.
- Confirm rendering fidelity and per-page timings match the current output
  before making the swap the default.

Until that lands, treat the effective license of a deployed instance as AGPL.
