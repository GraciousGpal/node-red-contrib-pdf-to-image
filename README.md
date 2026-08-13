# node-red-contrib-pdf-to-image

A Node-RED node that converts a PDF into PNG/JPEG images using
[MuPDF](https://mupdf.readthedocs.io) compiled to **WebAssembly** (the
[`mupdf`](https://www.npmjs.com/package/mupdf) npm package) — no native
dependencies, so it runs anywhere Node.js runs, including Alpine containers.

Semantics mirror the PDFprocessor reference app (PyMuPDF): page selection,
DPI scaling, PNG/JPEG output with quality, clockwise rotation, and the
`<stem>_page_<n>.<ext>` file naming scheme with collision counters.

## Install

```bash
npm install node-red-contrib-pdf-to-image
```

In this repo it is preinstalled as a local dependency — see the top-level
README. Rebuild the image after changing it:

```bash
docker compose up -d --build
```

## Input

`msg.payload` can be:

| Type | Meaning |
| --- | --- |
| `Buffer` / `Uint8Array` / `ArrayBuffer` | PDF bytes |
| string starting with `%PDF` | base64-encoded PDF |
| string path | PDF file read from disk (container filesystem) |
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
- JPEG output uses MuPDF's `asJPEG(quality)`; the reference app's
  progressive/optimize flags have no direct equivalent.
- The destination folder is a path **inside the container** — use `/data` for
  persistent storage.
