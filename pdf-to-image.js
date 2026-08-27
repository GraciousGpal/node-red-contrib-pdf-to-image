/**
 * pdf-to-image Node-RED node.
 *
 * Converts a PDF into PNG/JPEG images using MuPDF (the "mupdf" npm package,
 * compiled to WebAssembly - no native dependencies, so it runs anywhere
 * Node.js runs, including Alpine-based containers).
 *
 * Supported options:
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
const fsp = fs.promises;

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

	const DPI_BOUNDS = [10, 2400];
	const QUALITY_BOUNDS = [1, 100];
	const VALID_ROTATIONS = [0, 90, 180, 270];

	function clampInt(value, fallback, min, max) {
		const n = parseInt(value, 10);
		if (isNaN(n)) return fallback;
		return Math.min(max, Math.max(min, n));
	}

	function clampRotation(value, fallback) {
		const n = parseInt(value, 10);
		return VALID_ROTATIONS.includes(n) ? n : fallback;
	}

	function normalizeFormat(value, fallback) {
		const upper = String(value != null ? value : fallback).toUpperCase();
		return upper === "JPEG" ? "JPEG" : "PNG";
	}

	async function pathExists(p) {
		try {
			await fsp.access(p);
			return true;
		} catch {
			return false;
		}
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

	async function extractPdf(msg) {
		const payload = msg.payload;
		if (payload == null || payload === "") {
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
			if (await pathExists(payload)) {
				return {
					pdfBuffer: await fsp.readFile(payload),
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
			if (
				typeof payload.path === "string" &&
				(await pathExists(payload.path))
			) {
				return {
					pdfBuffer: await fsp.readFile(payload.path),
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

	async function uniqueFilePath(folder, stem, pageNum, ext) {
		let name = `${stem}_page_${pageNum}.${ext}`;
		let full = path.join(folder, name);
		let counter = 1;
		while (await pathExists(full)) {
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
		node.dpi = clampInt(config.dpi, 200, ...DPI_BOUNDS);
		node.format = normalizeFormat(config.format, "PNG");
		node.jpegQuality = clampInt(config.jpegQuality, 85, ...QUALITY_BOUNDS);
		node.rotation = clampRotation(config.rotation, 0);
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

				const { pdfBuffer, stem } = await extractPdf(msg);

				const folder = node.outputMode !== "message" ? node.folder : null;
				if (node.outputMode !== "message" && !folder) {
					throw new Error(
						`outputMode is "${node.outputMode}" but no destination folder is configured`,
					);
				}
				if (folder && !(await pathExists(folder))) {
					await fsp.mkdir(folder, { recursive: true });
				}

				// per-message overrides, otherwise node config
				const dpi = clampInt(
					msg.dpi != null ? msg.dpi : node.dpi,
					node.dpi,
					...DPI_BOUNDS,
				);
				const format = normalizeFormat(msg.format || node.format, node.format);
				const quality = clampInt(
					msg.jpegQuality != null ? msg.jpegQuality : node.jpegQuality,
					node.jpegQuality,
					...QUALITY_BOUNDS,
				);
				const rotation = clampRotation(
					msg.rotation != null ? msg.rotation : node.rotation,
					node.rotation,
				);
				const ext = format.toLowerCase();

				const openStart = performance.now();
				const doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");
				const openMs = performance.now() - openStart;
				const outStem = node.stem || stem;
				let totalPages = 0;
				let renderMs = 0;
				let saveMs = 0;
				try {
					totalPages = doc.countPages();
					if (!totalPages) throw new Error("the PDF contains no pages");

					const pageNumbers = resolvePageNumbers(node, totalPages, msg);
					const scale = mupdf.Matrix.scale(dpi / 72, dpi / 72);
					// Positive rotation = clockwise.
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
					const loopStart = performance.now();
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
							const buffer = Buffer.from(bytes);
							const img = {
								page: pageNum,
								width: pixmap.getWidth(),
								height: pixmap.getHeight(),
								renderMs: performance.now() - pageStart,
							};

							// write immediately so file-only mode never holds every
							// page's buffer in memory at once
							if (folder) {
								const saveStart = performance.now();
								const filePath = await uniqueFilePath(
									folder,
									outStem,
									pageNum,
									ext,
								);
								await fsp.writeFile(filePath, buffer);
								img.path = filePath;
								img.filename = path.basename(filePath);
								saveMs += performance.now() - saveStart;
							}
							if (node.outputMode !== "file") {
								img.buffer = buffer;
							}

							images.push(img);
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

					renderMs = performance.now() - loopStart - saveMs;

					if (!images.length)
						throw new Error("no pages were rendered from the PDF");

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
						const messages = images.map((img, i) => ({
							...msg,
							...meta,
							payload: payloads[i],
							page: img.page,
						}));
						send(messages);
					} else {
						Object.assign(msg, meta);
						msg.payload = payload;
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
