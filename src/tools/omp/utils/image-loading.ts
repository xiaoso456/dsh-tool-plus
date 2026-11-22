/**
 * Image-input loading pipeline (restored from OMP upstream for DSH, 拍板#22).
 *
 * Kept verbatim from refs `coding-agent/src/utils/image-loading.ts` for
 * everything the read/fetch image paths consume. The agent/model-boundary
 * normalizers (`normalizeModelContextImages`, `normalizeModelContextMessages`,
 * `normalizeProviderContextImagesForModel`, the STB memo cache) and the chat
 * attachment loader (`loadImageAttachmentInput`) stay removed: DSH has no OMP
 * agent loop — the host normalizes image context on its own (attachment
 * service), so those consumers do not exist here.
 *
 * Resize backend note: `resizeImage` (./image-resize) is Bun.Image-shaped;
 * under DSH the shared bun-shim resolves `Bun.Image` onto host-provided sharp.
 */
import * as fs from "node:fs/promises";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { formatBytes, readImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils";
import { resolveReadPath } from "../tools/path-utils";
import { formatDimensionNote, type ImageResizeOptions, resizeImage } from "./image-resize";

/**
 * Ollama and its local-backend family decode image input through llama.cpp /
 * `stb_image`, which is compiled without WebP support, so a WebP upload fails
 * with an opaque HTTP 400. Detect those models so the resize pipeline encodes
 * to PNG/JPEG instead — the automatic equivalent of `OMP_NO_WEBP=1`.
 */
export function modelLacksWebpSupport(
	model: Pick<Model, "provider" | "api" | "imageInputDecoder"> | undefined,
): boolean {
	if (!model) return false;
	return (
		model.imageInputDecoder === "stb" ||
		model.provider === "ollama" ||
		model.provider === "ollama-cloud" ||
		model.provider === "llama.cpp" ||
		model.provider === "lm-studio" ||
		model.provider === "local-server" ||
		model.api === "ollama-chat"
	);
}

/**
 * `true` when `model` cannot decode WebP, otherwise `undefined` so the
 * `OMP_NO_WEBP` env fallback in {@link resizeImage} still applies. Feed straight
 * into {@link ImageResizeOptions.excludeWebP}.
 */
export function webpExclusionForModel(model: Pick<Model, "provider" | "api"> | undefined): true | undefined {
	return modelLacksWebpSupport(model) ? true : undefined;
}

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

/** Longest edge used when rasterizing an SVG for the model (same bound as OMP 18.12.6). */
const SVG_IMAGE_MAX_EDGE_PX = 2048;
export const SUPPORTED_INPUT_IMAGE_MIME_TYPES = SUPPORTED_IMAGE_MIME_TYPES;

export interface LoadImageInputOptions {
	path: string;
	cwd: string;
	autoResize: boolean;
	maxBytes?: number;
	resolvedPath?: string;
	detectedMimeType?: string;
	/** Force non-WebP output (e.g. for Ollama). Leave unset to honor `OMP_NO_WEBP`. */
	excludeWebP?: boolean;
	/**
	 * DSH extension (拍板#22 config expansion): resize-knob passthrough onto
	 * {@link resizeImage}. Upstream never passes these — it relies on the
	 * hardcoded 1568px/500KB/200px/quality-80 defaults; the tool-plus config
	 * panel wires user-tunable values through here. Unset = upstream behavior.
	 */
	resize?: ImageResizeOptions;
}

export interface LoadedImageInput {
	resolvedPath: string;
	mimeType: string;
	data: string;
	textNote: string;
	dimensionNote?: string;
	bytes: number;
}

export class ImageInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Image file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "ImageInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

/** Converts an image to PNG, rejecting when the runtime cannot decode or encode it. */
export async function convertImageToPng(image: ImageContent): Promise<ImageContent> {
	const bytes = Buffer.from(image.data, "base64");
	const data = await new Bun.Image(bytes).png().toBase64();
	return { ...image, data, mimeType: "image/png" };
}

export async function ensureSupportedImageInput(image: ImageContent): Promise<ImageContent | null> {
	if (SUPPORTED_INPUT_IMAGE_MIME_TYPES.has(image.mimeType)) {
		return image;
	}
	try {
		return await convertImageToPng(image);
	} catch {
		return null;
	}
}

export async function loadImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const metadata = options.detectedMimeType
		? { mimeType: options.detectedMimeType }
		: await readImageMetadata(resolvedPath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) return null;

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	if (inputBuffer.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	return finishImageInput({
		resolvedPath,
		bytes: inputBuffer,
		mimeType,
		label: "Read image file",
		autoResize: options.autoResize,
		excludeWebP: options.excludeWebP,
		resize: options.resize,
	});
}

/**
 * Shared tail of both loaders: encode the accepted bytes as base64, optionally
 * re-encode through {@link resizeImage}, and compose the model-facing note.
 * `label` is what the note leads with ("Read image file" / "Read SVG file").
 */
async function finishImageInput(input: {
	resolvedPath: string;
	bytes: Uint8Array;
	mimeType: string;
	label: string;
	autoResize: boolean;
	excludeWebP?: boolean;
	resize?: ImageResizeOptions;
}): Promise<LoadedImageInput> {
	let outputData = Buffer.from(input.bytes).toBase64();
	let outputMimeType = input.mimeType;
	let outputBytes = input.bytes.byteLength;
	let dimensionNote: string | undefined;

	const shouldReencodeWebP = input.excludeWebP === true && input.mimeType === "image/webp";
	if (input.autoResize || shouldReencodeWebP) {
		try {
			const resized = await resizeImage(
				{ type: "image", data: outputData, mimeType: input.mimeType },
				{ ...input.resize, excludeWebP: input.excludeWebP },
			);
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} catch {
			// keep original image when resize fails
		}
	}

	let textNote = `${input.label} [${outputMimeType}]`;
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath: input.resolvedPath,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}

/**
 * Load an SVG/SVGZ by rasterizing it to PNG first (OMP 18.12.6 `:img` selector).
 *
 * SVG is text, so a plain read returns the markup; `:img` is the explicit "show
 * me the picture" request. Returns null for any other extension so the caller can
 * keep its "only .svg/.svgz" error path.
 */
export async function loadSvgImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	const extension = resolvedPath.slice(resolvedPath.lastIndexOf(".")).toLowerCase();
	if (extension !== ".svg" && extension !== ".svgz") return null;

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const source = await fs.readFile(resolvedPath);
	if (source.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(source.byteLength, maxBytes);
	}

	let png: Uint8Array;
	try {
		png = await rasterizeSvg(source, SVG_IMAGE_MAX_EDGE_PX, SVG_IMAGE_MAX_EDGE_PX);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not rasterize SVG: ${message}`);
	}

	return finishImageInput({
		resolvedPath,
		bytes: png,
		mimeType: "image/png",
		label: "Read SVG file",
		autoResize: options.autoResize,
		excludeWebP: options.excludeWebP,
		resize: options.resize,
	});
}
