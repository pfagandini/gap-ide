import fs from "node:fs/promises";
import path from "node:path";
import type { FilePayload, TreeNode } from "../shared/types";

const IGNORED = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".gap-ide"
]);

export class Project {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  resolve(relative: string): string {
    if (relative.includes("\0")) throw new Error("Invalid path.");
    if (path.isAbsolute(relative)) throw new Error("Paths must be relative to the project root.");
    const full = path.resolve(this.root, relative || ".");
    const prefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (full !== this.root && !full.startsWith(prefix)) {
      throw new Error("Path escapes the project root.");
    }
    return full;
  }

  async resolveExisting(relative: string): Promise<string> {
    const full = this.resolve(relative);
    const real = await fs.realpath(full);
    const rootReal = await fs.realpath(this.root);
    const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (real !== rootReal && !real.startsWith(prefix)) {
      throw new Error("Path escapes the project root.");
    }
    return real;
  }

  async tree(): Promise<TreeNode> {
    const rootNode: TreeNode = {
      name: path.basename(this.root) || this.root,
      path: "",
      type: "dir",
      children: []
    };
    let count = 0;

    const walk = async (node: TreeNode, depth: number): Promise<void> => {
      if (depth > 8 || count > 2000) return;
      const entries = await fs.readdir(this.resolve(node.path), {
        withFileTypes: true
      });
      const sorted = entries
        .filter((entry) => !entry.name.startsWith(".") && !IGNORED.has(entry.name))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      for (const entry of sorted) {
        count += 1;
        if (count > 2000) break;
        const childPath = node.path ? `${node.path}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          const child: TreeNode = {
            name: entry.name,
            path: childPath,
            type: "dir",
            children: []
          };
          node.children?.push(child);
          await walk(child, depth + 1);
        } else if (entry.isFile()) {
          node.children?.push({
            name: entry.name,
            path: childPath,
            type: "file"
          });
        }
      }
    };

    await walk(rootNode, 0);
    return rootNode;
  }

  async readFile(relative: string): Promise<FilePayload> {
    const full = await this.resolveExisting(relative);
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new Error("Not a file.");
    if (stat.size > 4 * 1024 * 1024) throw new Error("File is too large to edit (over 4 MB).");
    const buffer = await fs.readFile(full);
    if (buffer.includes(0)) throw new Error("This looks like a binary file.");
    return {
      path: relative,
      content: buffer.toString("utf8"),
      mtimeMs: stat.mtimeMs
    };
  }

  async writeFile(relative: string, content: string): Promise<{ mtimeMs: number }> {
    if (content.length > 4 * 1024 * 1024) throw new Error("File is too large to save.");
    const full = this.resolve(relative);
    const parent = path.dirname(full);
    await fs.mkdir(parent, { recursive: true });
    const realParent = await fs.realpath(parent);
    const rootReal = await fs.realpath(this.root);
    const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (realParent !== rootReal && !realParent.startsWith(prefix)) {
      throw new Error("Path escapes the project root.");
    }

    const temporary = path.join(
      realParent,
      `.${path.basename(full)}.gap-ide-${process.pid}-${Date.now()}`
    );
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, full);
    const stat = await fs.stat(full);
    return { mtimeMs: stat.mtimeMs };
  }

  async createFile(relative: string): Promise<void> {
    const full = this.resolve(relative);
    if (!/\.(g|gi|gd|tst|txt|md)$/i.test(full)) {
      throw new Error("New files should end in .g, .gi, .gd, .tst, .txt or .md.");
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, "", { flag: "wx" });
  }

  async downloadPath(relative: string): Promise<string> {
    return this.resolveExisting(relative);
  }
}
