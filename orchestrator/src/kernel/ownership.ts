// Owner classes of project paths. This is a port of plugins/harness/scripts/lib/ownership.mjs.
// The plugin copy has no dependencies, because hooks run it on every tool call. A test checks that
// both copies classify the same list of paths in the same way.

export type OwnerClass = "pinned" | "exception" | "loop-owned" | "task";

export function normalize(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

export function globToRegExp(glob: string): RegExp {
  const g = normalize(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        const alts = g
          .slice(i + 1, end)
          .split(",")
          .map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
        re += "(?:" + alts.join("|") + ")";
        i = end;
      }
    } else if (".+^$()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchGlob(glob: string, rel: string): boolean {
  return globToRegExp(glob).test(normalize(rel));
}

export function isPinned(rel: string): boolean {
  return normalize(rel)
    .split("/")
    .some((s) => s.startsWith("pinned-"));
}

export function isException(rel: string): boolean {
  const segs = normalize(rel).split("/");
  const base = segs[segs.length - 1] ?? "";
  if (/^CLAUDE.*\.md$/.test(base)) return true;
  if (base === "AGENTS.md" || base === ".mcp.json") return true;
  if (segs[0] === ".github" || segs[0] === ".gitlab" || segs[0] === ".husky") return true;
  if (segs.length === 1 && base === ".gitlab-ci.yml") return true;
  if (segs[0] === ".claude") {
    if (segs.length === 2 && /^settings.*\.json$/.test(base)) return true;
    if (["rules", "hooks", "commands"].includes(segs[1] ?? "")) return true;
  }
  return segs.indexOf(".claude", 1) !== -1;
}

export function classifyPath(rel: string, loopOwned: string[]): OwnerClass {
  if (isPinned(rel)) return "pinned";
  if (isException(rel)) return "exception";
  if (loopOwned.some((g) => matchGlob(g, rel))) return "loop-owned";
  return "task";
}
