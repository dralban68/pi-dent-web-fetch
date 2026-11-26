/**
 * PDF fixture builder for the tests (specs/web-fetch.md, Section 10): a committed helper that
 * assembles minimal PDFs from content streams, so a fixture controls the text render mode, the
 * font size and the position exactly. No committed binary fixture files.
 */

export interface TextOptions {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size?: number;
  /** The text render mode (`Tr`): 3 is invisible, 7 adds to the clip path only. */
  readonly mode?: number;
  /** The horizontal scale in percent (`Tz`). */
  readonly hscale?: number;
  /** A `Tm` matrix set before the text is shown. */
  readonly tm?: readonly number[];
  readonly font?: string;
}

/** One `BT … ET` block showing one text run. */
export function textRun(options: TextOptions): string {
  const size = options.size ?? 12;
  const font = options.font ?? "/F1";
  const lines = ["BT", `${font} ${size} Tf`];
  if (options.mode !== undefined) lines.push(`${options.mode} Tr`);
  if (options.tm !== undefined) lines.push(`${options.tm.join(" ")} Tm`);
  lines.push(`${options.x} ${options.y} Td`);
  if (options.hscale !== undefined) lines.push(`${options.hscale} Tz`);
  const escaped = options.text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
  lines.push(`(${escaped}) Tj`, "ET");
  return lines.join(" ");
}

/** Assembles a PDF whose pages hold the given content streams. */
export function buildPdf(
  pages: readonly string[],
  options?: { mediaBox?: readonly number[] },
): Buffer {
  const mediaBox = options?.mediaBox ?? [0, 0, 612, 792];
  const objects = new Map<number, string>();
  const fontId = 3 + pages.length * 2;
  const pageIds = pages.map((_stream, index) => 3 + index * 2);
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  pages.forEach((stream, index) => {
    const pageId = pageIds[index];
    if (pageId === undefined) throw new Error("page id missing");
    const contentId = pageId + 1;
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    objects.set(contentId, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let out = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (const [id, body] of objects) {
    offsets.set(id, out.length);
    out += `${id} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  const count = Math.max(...objects.keys()) + 1;
  out += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id += 1) {
    const offset = offsets.get(id);
    out +=
      offset === undefined
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A corrupt PDF: valid bytes with the middle cut out, so parsing fails. */
export function corruptPdf(): Buffer {
  const pdf = buildPdf([textRun({ text: "irrelevant", x: 72, y: 720 })]);
  return pdf.subarray(0, Math.floor(pdf.length / 3));
}

/** A form XObject holding text, drawn by `Do` from the page's content stream. */
export function formFixture(options: {
  formText: string;
  formMatrix?: readonly number[];
  pageText?: string;
}): Buffer {
  const matrix = options.formMatrix ?? [1, 0, 0, 1, 0, 0];
  const formStream = textRun({ text: options.formText, x: 100, y: 100, size: 12 });
  const pageStream = `${options.pageText ?? ""}${options.pageText === undefined ? "" : "\n"}/Fx Do`;
  const objects = new Map<number, string>([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fx 6 0 R >> >> >>",
    ],
    [4, `<< /Length ${pageStream.length} >>\nstream\n${pageStream}\nendstream`],
    [5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    [
      6,
      `<< /Type /XObject /Subtype /Form /Matrix [${matrix.join(" ")}] /BBox [0 0 400 400] /Length ${formStream.length} >>\nstream\n${formStream}\nendstream`,
    ],
  ]);
  return assemble(objects);
}

/** Assembles objects `{id: body}` into a PDF buffer. */
export function assemble(objects: Map<number, string>): Buffer {
  let out = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  const ids = Array.from(objects.keys()).toSorted((a: number, b: number) => a - b);
  for (const id of ids) {
    offsets.set(id, out.length);
    out += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xref = out.length;
  const last = ids.at(-1);
  if (last === undefined) throw new Error("no objects");
  const count = last + 1;
  out += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id += 1) {
    const offset = offsets.get(id);
    out +=
      offset === undefined
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
