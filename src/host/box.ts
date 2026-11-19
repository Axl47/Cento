// Uploads the analysis data that lives only on this Mac to the storage box, as the daily refresh's last step.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../core/config.ts";

/** Each lands in the box's `data/` under its own name. `audio.json` is the song order of the rows in `edges.bin`. */
const features = process.env.FEATURES_FILE ?? join(homedir(), ".cache/audio-embed-engine/features/features.jsonl");
const FILES = [features, "data/edges.bin", "data/audio.json", "data/features.json", "data/skips.json", "data/plays.json"];

/** Sends the files whose content changed (`-c`: the daily rebuilds touch files that come out identical). */
export const uploadToBox = () => promisify(execFile)("rsync", ["-t", "-c", ...FILES.filter((f) => existsSync(f)), config.boxData], { timeout: 15 * 60_000 });
