import { ImageAnnotatorClient } from "@google-cloud/vision";

let annotator: ImageAnnotatorClient | null = null;

function client(): ImageAnnotatorClient {
  if (!annotator) {
    annotator = new ImageAnnotatorClient(
      process.env.GCS_KEY_FILE ? { keyFilename: process.env.GCS_KEY_FILE } : {},
    );
  }
  return annotator;
}

const LIKELY = new Set(["LIKELY", "VERY_LIKELY"]);

export interface VisionPrefilter {
  detectedLabels: string[];
  safeSearchBlocked: boolean;
}

/**
 * Runs Cloud Vision label/object detection plus SafeSearch on a photo. Flags the
 * image as blocked when adult/violence/racy are LIKELY+ or spoof is VERY_LIKELY,
 * and returns deduped detection labels as hints for the downstream LLM judge.
 *
 * @param buffer Raw photo bytes.
 * @returns Detected labels and whether SafeSearch blocked the image.
 */
export async function prefilterImage(buffer: Buffer): Promise<VisionPrefilter> {
  const [result] = await client().annotateImage({
    image: { content: buffer },
    features: [
      { type: "LABEL_DETECTION", maxResults: 10 },
      { type: "OBJECT_LOCALIZATION", maxResults: 10 },
      { type: "SAFE_SEARCH_DETECTION" },
    ],
  } as Parameters<ImageAnnotatorClient["annotateImage"]>[0]);

  const safe = result.safeSearchAnnotation ?? {};
  const safeSearchBlocked =
    LIKELY.has(String(safe.adult)) ||
    LIKELY.has(String(safe.violence)) ||
    LIKELY.has(String(safe.racy)) ||
    String(safe.spoof) === "VERY_LIKELY";

  const labels = [
    ...(result.labelAnnotations ?? []).map((l) => l.description ?? ""),
    ...(result.localizedObjectAnnotations ?? []).map((o) => o.name ?? ""),
  ].filter(Boolean);
  const detectedLabels = Array.from(new Set(labels)).slice(0, 12);

  return { detectedLabels, safeSearchBlocked };
}
