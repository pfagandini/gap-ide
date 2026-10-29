import fs from "node:fs";
import PDFDocument from "pdfkit";
import type { Run } from "../shared/types";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 45;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM = PAGE_HEIGHT - MARGIN;
const CODE_SIZE = 8;
const LINE_HEIGHT = 10;
const TEXT_SIZE = 10;

const MONO_FONTS = [
  "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  "/usr/share/fonts/dejavu-lgc-sans-mono-fonts/DejaVuLGCSansMono.ttf",
  "/usr/share/fonts/google-noto/NotoSansMono-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf"
];

const SANS_FONTS = [
  "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/google-noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
];

const SANS_BOLD_FONTS = [
  "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/google-noto/NotoSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
];

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export interface PdfMeta {
  title?: string;
  author?: string;
  course?: string;
  gapVersion?: string;
  root?: string;
}

export async function renderRunsPdf(runs: Run[], meta: PdfMeta = {}): Promise<Buffer> {
  const monoFont = firstExisting(MONO_FONTS);
  const sansFont = firstExisting(SANS_FONTS);
  const sansBoldFont = firstExisting(SANS_BOLD_FONTS);
  const hasUnicodeMono = Boolean(monoFont);

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: meta.title || "GAP Assignment Report",
      Author: meta.author || "GAP IDE",
      Creator: "GAP IDE"
    }
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  if (monoFont) doc.registerFont("Mono", monoFont);
  if (sansFont) doc.registerFont("Sans", sansFont);
  if (sansBoldFont) doc.registerFont("SansBold", sansBoldFont);

  const mono = monoFont ? "Mono" : "Courier";
  const sans = sansFont ? "Sans" : "Helvetica";
  const sansBold = sansBoldFont ? "SansBold" : "Helvetica-Bold";

  const generated = new Date();
  let y = MARGIN;

  doc.font(sansBold).fontSize(20).fillColor("#111111");
  doc.text(meta.title || "GAP Assignment Report", MARGIN, y, {
    width: CONTENT_WIDTH
  });
  y = doc.y + 4;

  const metaParts = [
    meta.author,
    meta.course,
    generated.toLocaleString(),
    meta.gapVersion ? `GAP ${meta.gapVersion}` : undefined
  ].filter(Boolean);
  doc.font(sans).fontSize(9).fillColor("#555555");
  doc.text(metaParts.join("   ·   "), MARGIN, y, { width: CONTENT_WIDTH });
  y = doc.y + 10;

  doc
    .moveTo(MARGIN, y)
    .lineTo(PAGE_WIDTH - MARGIN, y)
    .lineWidth(0.6)
    .strokeColor("#cccccc")
    .stroke();
  y += 16;

  if (runs.length === 0) {
    doc.font(sans).fontSize(TEXT_SIZE).fillColor("#666666");
    doc.text("No completed runs to export.", MARGIN, y);
    y = doc.y;
  }

  const safe = (text: string) => sanitize(text, hasUnicodeMono);

  const addPage = () => {
    doc.addPage();
    y = MARGIN;
  };

  const ensure = (needed: number) => {
    if (y + needed > BOTTOM) addPage();
  };

  const drawSectionLabel = (label: string) => {
    ensure(22);
    doc.font(sansBold).fontSize(8).fillColor("#777777");
    doc.text(label.toUpperCase(), MARGIN, y, { width: CONTENT_WIDTH });
    y = doc.y + 3;
  };

  const drawRule = () => {
    ensure(10);
    doc
      .moveTo(MARGIN, y)
      .lineTo(PAGE_WIDTH - MARGIN, y)
      .lineWidth(0.4)
      .strokeColor("#e0e0e0")
      .stroke();
    y += 8;
  };

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    ensure(85);

    const statusColor =
      run.status === "ok"
        ? "#1f7a3f"
        : run.status === "interrupted"
          ? "#a36a00"
          : "#b3261e";

    doc.font(sansBold).fontSize(11).fillColor("#111111");
    const runTitle =
      run.kind === "file"
        ? `Run ${i + 1}  ·  ${run.sourcePath ?? run.label}`
        : `Run ${i + 1}  ·  Console`;
    doc.text(runTitle, MARGIN, y, { width: CONTENT_WIDTH - 110, lineBreak: true });
    const headingBottom = doc.y;

    doc.font(sansBold).fontSize(9).fillColor(statusColor);
    doc.text(run.status.toUpperCase(), PAGE_WIDTH - MARGIN - 100, y, {
      width: 100,
      align: "right"
    });

    y = Math.max(headingBottom, doc.y) + 2;
    const details = [
      run.kind === "console" && run.label !== "Console" ? run.label : undefined,
      run.startLine ? `line ${run.startLine}` : undefined,
      run.durationMs !== undefined ? `${(run.durationMs / 1000).toFixed(2)} s` : undefined,
      new Date(run.startedAt).toLocaleString()
    ].filter(Boolean);
    doc.font(sans).fontSize(8).fillColor("#666666");
    doc.text(details.join("   ·   "), MARGIN, y, { width: CONTENT_WIDTH });
    y = doc.y + 10;

    drawSectionLabel("Source");
    const codeLines = splitLines(run.code).map((line) => expandTabs(line));
    const lineCount = Math.max(1, codeLines.length);
    // A selection is numbered from its real position in the source file, not
    // from 1, so the report matches what the reader sees in the editor.
    const firstLine =
      run.kind === "console" && run.sourcePath && run.startLine
        ? run.startLine
        : 1;
    const lastLine = firstLine + lineCount - 1;
    const gutterChars = String(lastLine).length + 2;
    doc.font(mono).fontSize(CODE_SIZE);
    const charWidth = Math.max(4, doc.widthOfString("M"));
    const codeWidth = CONTENT_WIDTH - gutterChars * charWidth;
    const codeMaxChars = Math.max(20, Math.floor(codeWidth / charWidth));

    let codeNumber = firstLine;
    for (const sourceLine of codeLines) {
      const chunks = wrapByChars(safe(sourceLine), codeMaxChars);
      for (let c = 0; c < chunks.length; c++) {
        if (y + LINE_HEIGHT > BOTTOM) {
          addPage();
          drawSectionLabel("Source (continued)");
          doc.font(mono).fontSize(CODE_SIZE);
        }
        if (c === 0) {
          doc.font(mono).fontSize(CODE_SIZE).fillColor("#9a9a9a");
          doc.text(
            String(codeNumber).padStart(gutterChars - 2) + "  ",
            MARGIN,
            y,
            { lineBreak: false }
          );
        }
        doc.font(mono).fontSize(CODE_SIZE).fillColor("#111111");
        doc.text(chunks[c], MARGIN + gutterChars * charWidth, y, {
          lineBreak: false
        });
        y += LINE_HEIGHT;
      }
      codeNumber += 1;
    }
    y += 4;

    drawSectionLabel("Output");
    doc.font(mono).fontSize(CODE_SIZE);
    const outputMaxChars = Math.max(30, Math.floor(CONTENT_WIDTH / charWidth));

    const drawOutput = (text: string, color: string) => {
      const lines = splitLines(text);
      for (const line of lines) {
        const chunks = wrapByChars(safe(line), outputMaxChars);
        for (const chunk of chunks) {
          if (y + LINE_HEIGHT > BOTTOM) {
            addPage();
            drawSectionLabel("Output (continued)");
            doc.font(mono).fontSize(CODE_SIZE);
          }
          doc.fillColor(color);
          doc.text(chunk, MARGIN, y, { lineBreak: false });
          y += LINE_HEIGHT;
        }
      }
    };

    if (run.stdout.length > 0) {
      drawOutput(run.stdout, "#222222");
    }
    if (run.stderr.length > 0) {
      if (run.stdout.length > 0) {
        ensure(18);
        doc.font(sans).fontSize(8).fillColor("#b3261e");
        doc.text("stderr", MARGIN, y);
        y = doc.y + 2;
      }
      drawOutput(run.stderr, "#b3261e");
    }
    if (run.stdout.length === 0 && run.stderr.length === 0) {
      ensure(LINE_HEIGHT + 2);
      doc.font(mono).fontSize(CODE_SIZE).fillColor("#999999");
      doc.text("(no output)", MARGIN, y, { lineBreak: false });
      y += LINE_HEIGHT;
    }

    y += 14;
    if (i < runs.length - 1) {
      drawRule();
    }
  }

  // Page footers. bufferPages lets us revisit every page after layout.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The footer sits below the normal bottom margin. Disable that margin while
    // drawing so PDFKit does not treat it as overflow and append a new page.
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(sans).fontSize(7.5).fillColor("#999999");
    doc.text("GAP IDE", MARGIN, PAGE_HEIGHT - 26, {
      width: CONTENT_WIDTH / 2,
      lineBreak: false
    });
    doc.text(`${i + 1} / ${range.count}`, MARGIN, PAGE_HEIGHT - 26, {
      width: CONTENT_WIDTH,
      align: "right",
      lineBreak: false
    });
    doc.page.margins.bottom = oldBottom;
  }

  doc.end();
  return finished;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function expandTabs(line: string): string {
  return line.replace(/\t/g, "    ");
}

function sanitize(text: string, unicode: boolean): string {
  const cleaned = text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  if (unicode) return cleaned;
  // Standard PDF fonts only cover WinAnsi. Keep the layout readable on systems
  // without a Unicode monospace font instead of failing during export.
  return cleaned.replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "?");
}

function wrapByChars(text: string, maxChars: number): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}
