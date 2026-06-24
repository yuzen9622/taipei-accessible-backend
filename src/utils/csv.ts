/**
 * Split one CSV line into fields, honouring double-quoted fields that may
 * contain commas (e.g. `"計次收費,假日計時收費"`) and escaped `""` quotes.
 * Line-based: callers must split the file into lines first (only valid when no
 * field contains a newline).
 * @param line A single raw CSV line (without trailing newline).
 * @returns The field values in order.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}
