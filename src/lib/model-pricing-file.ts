/**
 * Server-only loader for `data/model-pricing.json`.
 *
 * List prices move, and a real contract price is often not the list price at all, so the price book
 * is overridable without a rebuild. Kept apart from model-pricing.ts because that module is reachable
 * from client components (the estimators and formatters are used in the UI) and must not pull `fs`
 * into the browser bundle.
 *
 * File shape (both keys optional; `match` is a case-insensitive regular expression on the model id):
 *   { "token": [{ "match": "^my-model", "rate": { "input": 1, "output": 3 } }],
 *     "media": [{ "match": "^my-video", "rate": { "perVideoSecond": 0.05 } }] }
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getDataDir } from "@/lib/paths";
import { PRICE_OVERRIDE_FILE, setPriceOverrides, type PriceBook } from "@/lib/model-pricing";

let lastMtimeMs = -1;

/**
 * Re-read the override file when it has changed and install the result.
 * Cheap enough (one stat) to call before each recorded call, so editing the file takes effect
 * immediately instead of at the next restart. A malformed file is ignored — a typo in a price
 * table must never break a generation.
 */
export function loadPriceOverrides(): void {
  try {
    const file = join(getDataDir(), PRICE_OVERRIDE_FILE);
    if (!existsSync(file)) {
      if (lastMtimeMs !== 0) {
        lastMtimeMs = 0;
        setPriceOverrides(null);
      }
      return;
    }
    const mtimeMs = statSync(file).mtimeMs;
    if (mtimeMs === lastMtimeMs) return;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PriceBook>;
    setPriceOverrides({
      token: Array.isArray(parsed.token) ? parsed.token : [],
      media: Array.isArray(parsed.media) ? parsed.media : [],
    });
    lastMtimeMs = mtimeMs;
  } catch {
    /* unreadable or invalid override file → keep whatever is installed */
  }
}
