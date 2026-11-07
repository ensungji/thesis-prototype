// mobile/lib/csv-share.ts
// Build a CSV file and hand it to the phone's share sheet (save to Files /
// Drive, send by email or chat, ...).
//
// Needs the native modules expo-file-system and expo-sharing. They are loaded
// only when sharing, so an app build made before expo-sharing was added
// doesn't crash: it shares the CSV as plain text instead.

import { Share } from "react-native";
import { requireOptionalNativeModule } from "expo";

type Cell = string | number | boolean | null | undefined;

// One field. Quoted when it holds a comma, quote or line break (RFC 4180).
// A field that starts like a formula gets a leading ' so Excel / Sheets show
// it as text instead of running it.
function csvField(value: Cell): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  // The byte-order mark makes Excel read the file as UTF-8
  return "﻿" + [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/**
 * Write `csv` to a file named `fileName` in the cache folder and open the
 * share sheet for it. Resolves once the share sheet is closed.
 * Returns "file", or "text" when this build can't share files.
 */
export async function shareCsv(fileName: string, csv: string, title: string): Promise<"file" | "text"> {
  if (requireOptionalNativeModule("ExpoSharing") && requireOptionalNativeModule("FileSystem")) {
    const [{ File, Paths }, Sharing] = await Promise.all([
      import("expo-file-system"),
      import("expo-sharing"),
    ]);
    if (await Sharing.isAvailableAsync()) {
      const file = new File(Paths.cache, fileName);
      file.create({ overwrite: true });
      file.write(csv);
      await Sharing.shareAsync(file.uri, {
        mimeType: "text/csv",
        UTI: "public.comma-separated-values-text",
        dialogTitle: title,
      });
      return "file";
    }
  }
  await Share.share({ title, message: csv.replace(/^﻿/, "") });
  return "text";
}
