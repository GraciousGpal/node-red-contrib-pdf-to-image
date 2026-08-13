/**
 * pdf-to-image Node-RED node.
 *
 * Converts a PDF into PNG/JPEG images using MuPDF (the "mupdf" npm package,
 * compiled to WebAssembly - no native dependencies, so it runs anywhere
 * Node.js runs, including Alpine-based containers).
 *
 * Semantics follow the PDFprocessor reference app (PyMuPDF):
 *   - page selection: all / first / last / range ("a-b", 1-indexed)
 *   - DPI scaling (default 200; PDFs are 72 DPI base)
 *   - PNG or JPEG output (JPEG quality 1-100)
 *   - clockwise rotation (0 / 90 / 180 / 270)
 *   - file naming "<stem>_page_<n>.<ext>" with collision counters
 *
 * Input (msg.payload):
 *   - Buffer / Uint8Array / ArrayBuffer  -> PDF bytes
 *   - string starting with "%PDF"        -> base64-encoded PDF
 *   - string path to an existing file    -> PDF read from disk
 *   - object { data | buffer } or { path }
 * Also honoured: msg.filename (base name for output files), msg.dpi,
 * msg.format, msg.rotation, msg.jpegQuality, msg.pageMode, msg.pageRange.
 */

const path = require("path");
const fs = require("fs");

module.exports = (RED) => {
	// "mupdf" is ESM-only, so it cannot be require()'d from this CommonJS
	// module. Load it once per process; the promise resolves long before the
	// first message needs it. Node >= 18 supports dynamic import.
	const mupdfReady = import("mupdf")
		.then((m) => m.default || m)
		.catch((err) => {
			RED.log.error(
				"[pdf-to-image] could not load the mupdf package: " +
					(err && err.stack ? err.stack : err),
			);
			return null;
		});

	function clampInt(value, fallback, min, max) {
		const n = parseInt(value, 10);
		if (isNaN(n)) return fallback;
		return Math.min(max, Math.max(min, n));
	}

	function fmtMs(ms) {
		return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
	}

	function stemFromString(str) {
		const base =
			path.basename(String(str || "")).replace(/\.[^.]+$/, "") || "document";
		// keep the name filesystem-friendly and prevent path traversal
		return base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "");
	}

	function resolvePageNumbers(node, totalPages, msg) {
		const mode = msg.pageMode || node.pageMode;
		switch (mode) {
			case "first":
				return [1];
			case "last":
				return [totalPages];
			case "range": {
				const rangeStr = String(msg.pageRange || node.pageRange || "");
				const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(rangeStr);
				if (m) {
					const a = parseInt(m[1], 10);
					const b = m[2] ? parseInt(m[2], 10) : a;
					if (a >= 1 && a <= b) {
						const lo = Math.max(a, 1);
						const hi = Math.min(b, totalPages);
						const pages = [];
						for (let i = lo; i <= hi; i++) pages.push(i);
						if (pages.length) return pages;
					}
				}
				node.warn(
					`[pdf-to-image] invalid page range "${rangeStr}" - converting all pages`,
				);
				break;
			}
			default:
				break;
		}
		const all = [];
		for (let i = 1; i <= totalPages; i++) all.push(i);
		return all;
	}

	function extractPdf(msg) {
		const payload = msg.payload;
		if (payload == null) {
			throw new Error(
				"msg.payload is empty - send a PDF buffer, a file path, or a base64 PDF string",
			);
		}
		const fallbackName =
			msg.filename != null && msg.filename !== ""
				? stemFromString(msg.filename)
				: null;
		if (
			Buffer.isBuffer(payload) ||
			payload instanceof Uint8Array ||
			payload instanceof ArrayBuffer
		) {
			return {
				pdfBuffer: Buffer.from(payload),
				stem: fallbackName || "document",
			};
		}
		if (typeof payload === "string") {
			// base64-encoded PDF? verify the decoded bytes carry the PDF magic
			const decoded = Buffer.from(payload, "base64");
			if (
				decoded.length >= 5 &&
				decoded.subarray(0, 5).toString("latin1") === "%PDF-"
			) {
				return { pdfBuffer: decoded, stem: fallbackName || "document" };
			}
			if (fs.existsSync(payload)) {
				return {
					pdfBuffer: fs.readFileSync(payload),
					stem: fallbackName || stemFromString(payload),
				};
			}
			throw new Error(
				`msg.payload string is neither an existing file path nor a base64 PDF (found: "${payload.slice(0, 40)}")`,
			);
		}
		if (payload && typeof payload === "object") {
			const data = payload.data || payload.buffer;
			if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
				return {
					pdfBuffer: Buffer.from(data),
					stem: fallbackName || stemFromString(payload.filename),
				};
			}
			if (typeof payload.path === "string" && fs.existsSync(payload.path)) {
				return {
					pdfBuffer: fs.readFileSync(payload.path),
					stem:
						fallbackName || stemFromString(payload.filename || payload.path),
				};
			}
			throw new Error(
				'msg.payload object must contain "data" (a buffer) or a "path" to an existing file',
			);
		}
		throw new Error(`unsupported msg.payload type: ${typeof payload}`);
	}

	function uniqueFilePath(folder, stem, pageNum, ext) {
		let name = `${stem}_page_${pageNum}.${ext}`;
		let full = path.join(folder, name);
		let counter = 1;
		while (fs.existsSync(full)) {
			name = `${stem}_page_${pageNum}_${counter}.${ext}`;
			full = path.join(folder, name);
			counter += 1;
		}
		return full;
	}

	function PdfToImageNode(config) {
		RED.nodes.createNode(this, config);
		const node = this;

		node.pageMode = ["all", "first", "last", "range"].includes(config.pageMode)
			? config.pageMode
			: "all";
		node.pageRange = String(config.pageRange || "1");
		node.dpi = clampInt(config.dpi, 200, 10, 2400);
		node.format =
			String(config.format || "PNG").toUpperCase() === "JPEG" ? "JPEG" : "PNG";
		node.jpegQuality = clampInt(config.jpegQuality, 85, 1, 100);
		node.rotation = parseInt(config.rotation, 10) || 0;
		node.outputMode = ["message", "file", "both"].includes(config.outputMode)
			? config.outputMode
			: "message";
		node.folder = String(config.folder || "").trim();
		node.stem = String(config.stem || "").trim();
		node.splitPages = !!config.splitPages;

		node.on("input", async (msg, send, done) => {
			send =
				send ||
				function () {
					node.send.apply(node, arguments);
				};
			const totalStart = performance.now();
			try {
				const mupdf = await mupdfReady;
				if (!mupdf)
					throw new Error(
						"the mupdf package failed to load - see the Node-RED log",
					);

				const { pdfBuffer, stem } = extractPdf(msg);

				const folder = node.outputMode !== "message" ? node.folder : null;
				if (folder && !fs.existsSync(folder)) {
					fs.mkdirSync(folder, { recursive: true });
				}

				// per-message overrides, otherwise node config
				const dpi = clampInt(
					msg.dpi != null ? msg.dpi : node.dpi,
					node.dpi,
					10,
					2400,
				);
				const format =
					String(msg.format || node.format).toUpperCase() === "JPEG"
						? "JPEG"
						: "PNG";
				const quality = clampInt(
					msg.jpegQuality != null ? msg.jpegQuality : node.jpegQuality,
					node.jpegQuality,
					1,
					100,
				);
				const rotation =
					parseInt(msg.rotation != null ? msg.rotation : node.rotation, 10) ||
					0;
				const ext = format.toLowerCase();

				const openStart = performance.now();
				const doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");
				const outStem = node.stem || stem;
				let totalPages = 0;
				let openMs = 0;
				let renderMs = 0;
				let saveMs = 0;
				try {
					totalPages = doc.countPages();
					openMs = performance.now() - openStart;
					if (!totalPages) throw new Error("the PDF contains no pages");

					const pageNumbers = resolvePageNumbers(node, totalPages, msg);
					const scale = mupdf.Matrix.scale(dpi / 72, dpi / 72);
					// reference app semantics: positive rotation = clockwise.
					// MuPDF's Matrix.rotate() is counterclockwise, hence the negation.
					const matrix = rotation
						? mupdf.Matrix.concat(mupdf.Matrix.rotate(-rotation), scale)
						: scale;

					node.status({
						fill: "blue",
						shape: "dot",
						text: `rendering ${pageNumbers.length} page${pageNumbers.length === 1 ? "" : "s"}…`,
					});

					const images = [];
					const renderStart = performance.now();
					for (const pageNum of pageNumbers) {
						const pageStart = performance.now();
						const page = doc.loadPage(pageNum - 1);
						let pixmap = null;
						try {
							pixmap = page.toPixmap(
								matrix,
								mupdf.ColorSpace.DeviceRGB,
								false,
								true,
							);
							const bytes =
								format === "JPEG" ? pixmap.asJPEG(quality) : pixmap.asPNG();
							images.push({
								page: pageNum,
								width: pixmap.getWidth(),
								height: pixmap.getHeight(),
								buffer: Buffer.from(bytes),
								renderMs: performance.now() - pageStart,
							});
						} finally {
							if (pixmap) pixmap.destroy();
							page.destroy();
						}
						if (pageNumbers.length > 1) {
							node.status({
								fill: "blue",
								shape: "dot",
								text: `page ${pageNum}/${pageNumbers.length}…`,
							});
						}
					}

					renderMs = performance.now() - renderStart;

					if (!images.length)
						throw new Error("no pages were rendered from the PDF");

					// write files (file / both modes)
					const saveStart = performance.now();
					if (folder) {
						for (const img of images) {
							const filePath = uniqueFilePath(folder, outStem, img.page, ext);
							fs.writeFileSync(filePath, img.buffer);
							img.path = filePath;
							img.filename = path.basename(filePath);
						}
					}

					saveMs = performance.now() - saveStart;

					const single = images.length === 1;
					const payloads = images.map((img) =>
						folder && node.outputMode === "file" ? img.path : img.buffer,
					);
					const totalMs = performance.now() - totalStart;
					const meta = {
						images: images.map((img) => ({
							page: img.page,
							width: img.width,
							height: img.height,
							filename: img.filename,
							path: img.path,
							renderMs: Math.round(img.renderMs),
						})),
						pageCount: totalPages,
						pages: images.length,
						dpi,
						format,
						rotation,
						filename: outStem,
						durationMs: Math.round(totalMs),
						timings: {
							openMs: Math.round(openMs),
							renderMs: Math.round(renderMs),
							renderPerPageMs: images.length
								? Math.round((renderMs / images.length) * 10) / 10
								: 0,
							saveMs: Math.round(saveMs),
							totalMs: Math.round(totalMs),
						},
					};
					if (folder) meta.folder = folder;

					const payload = single ? payloads[0] : payloads;

					if (node.splitPages && !single) {
						const messages = images.map((img, i) => {
							const m = { ...msg };
							m.payload = payloads[i];
							m.images = meta.images;
							m.page = img.page;
							m.pageCount = meta.pageCount;
							m.pages = meta.pages;
							m.dpi = meta.dpi;
							m.format = meta.format;
							m.rotation = meta.rotation;
							m.filename = meta.filename;
							m.durationMs = meta.durationMs;
							m.timings = meta.timings;
							if (meta.folder) m.folder = meta.folder;
							return m;
						});
						send(messages);
					} else {
						msg.payload = payload;
						msg.images = meta.images;
						msg.pageCount = meta.pageCount;
						msg.pages = meta.pages;
						msg.dpi = meta.dpi;
						msg.format = meta.format;
						msg.rotation = meta.rotation;
						msg.filename = meta.filename;
						msg.durationMs = meta.durationMs;
						msg.timings = meta.timings;
						if (meta.folder) msg.folder = meta.folder;
						send(msg);
					}

					node.status({
						fill: "green",
						shape: "dot",
						text: `${images.length} page${images.length === 1 ? "" : "s"} · ${format} · ${dpi} dpi`,
					});
					node.log(
						`[pdf-to-image] ${totalPages}-page PDF -> ${images.length} ${format} image(s) at ${dpi} dpi | ` +
							`open ${fmtMs(meta.timings.openMs)}, render ${fmtMs(meta.timings.renderMs)} ` +
							`(${fmtMs(meta.timings.renderPerPageMs)}/page), save ${fmtMs(meta.timings.saveMs)}, ` +
							`total ${fmtMs(meta.timings.totalMs)}`,
					);
					done();
				} finally {
					doc.destroy();
				}
			} catch (err) {
				node.status({ fill: "red", shape: "ring", text: "error" });
				const message = err && err.message ? err.message : String(err);
				node.error(`pdf-to-image: ${message}`, msg);
				done(err);
			}
		});
	}

	RED.nodes.registerType("pdf-to-image", PdfToImageNode);
};
