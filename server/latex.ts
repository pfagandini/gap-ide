import type { Run } from "../shared/types";

/**
 * Tracks whether the lines fed so far leave a GAP statement open, to choose
 * between the `gap> ` and `> ` prompts. Counts brackets and block keywords
 * (function/if/for/while/repeat ... end/fi/od/until) outside strings and
 * comments; a statement is complete when nothing is open and it ends in `;`.
 */
class StatementTracker {
  private depth = 0;
  private pending = false; // code seen since the last complete statement

  /** Feeds one line; returns true if a statement is still open after it. */
  feed(line: string): boolean {
    let code = "";
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        code += " ";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        code += " ";
      } else if (ch === "#") break;
      else code += ch;
    }
    for (const ch of code) {
      if ("([{".includes(ch)) this.depth++;
      else if (")]}".includes(ch)) this.depth = Math.max(0, this.depth - 1);
    }
    for (const word of code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      if (/^(function|if|for|while|repeat|atomic)$/.test(word)) this.depth++;
      else if (/^(end|fi|od|until)$/.test(word)) this.depth = Math.max(0, this.depth - 1);
    }
    const trimmed = code.trim();
    if (trimmed) this.pending = true;
    if (this.depth === 0 && trimmed.endsWith(";")) this.pending = false;
    return this.pending;
  }
}

/**
 * The runs as a GAP session transcript (`gap> ` for a new statement, `> ` for
 * continuation lines, output under the line that produced it), wrapped in a
 * LaTeX verbatim environment for pasting into an assignment.
 */
export function runsToLatexVerbatim(runs: Run[]): string {
  const lines: string[] = [];
  for (const run of runs) {
    const entries =
      run.transcript ??
      [{ input: run.code, output: run.stdout + run.stderr }];
    const tracker = new StatementTracker();
    let continuing = false;
    for (const entry of entries) {
      if (entry.input.trim() === "" && !continuing && entry.output.trim() === "") continue;
      const inputLines = entry.input.replace(/\r?\n$/, "").split(/\r?\n/);
      for (const input of inputLines) {
        lines.push(`${continuing ? ">" : "gap>"} ${input}`.trimEnd());
        continuing = tracker.feed(input);
      }
      const output = entry.output.replace(/\r/g, "").replace(/\n+$/, "");
      if (output) lines.push(...output.split("\n"));
    }
  }
  // "\end{verbatim}" cannot appear inside verbatim; break it if GAP printed it.
  const body = lines.join("\n").replace(/\\end\{verbatim\}/g, "\\end {verbatim}");
  return `\\begin{verbatim}\n${body}\n\\end{verbatim}\n`;
}
