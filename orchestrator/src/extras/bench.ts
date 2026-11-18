// Benchmark dashboard (docs/usage.md, section 10.1). One page that shows how the current template
// version scores, and the history of every version.
//
// The page is <eval_store>/benchmarks.html, because it shows scores. It has no JavaScript and opens
// from the disk. Its data are the reports of the eval store (reports/*/measure.json, round.json,
// scores.jsonl): the page is a view of them, not a second copy. No agent reads the eval store.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Ctx } from "../kernel/ctx.js";
import type { TemplateStats } from "./lessonstore.js";
import { templateStats } from "./lessonstore.js";
import type { RunRecord } from "../kernel/runs.js";
import { readRunRecords } from "../kernel/runs.js";
import { readJson, readJsonl } from "../util/fs.js";

// ---------------------------------------------------------------------------------------------
// Versions and epochs.

export type { Epoch } from "../kernel/epoch.js";
export { epochId, epochOf, templateLabel } from "../kernel/epoch.js";
import type { Epoch } from "../kernel/epoch.js";
import { epochId, epochOf, templateLabel } from "../kernel/epoch.js";

// ---------------------------------------------------------------------------------------------
// Collect.

export interface ArmSummary {
  arm: string;
  scored: number;
  unscored: number;
  meanScore: number | null;
  meanTokens: number | null;
}

export interface EstimateRow {
  name: string;
  outcome: "pass" | "fail" | "worse" | "inconclusive" | "n/a";
  mean: number | null;
  lower: number | null;
  upper: number | null;
  tasks: number;
  droppedPairs: number;
}

export interface BenchRound {
  id: string;
  date: string;
  kind: "measure" | "round";
  split: "dev" | "holdout";
  decision: string | null;
  template: string;
  epoch: string;
  epochInfo: Partial<Epoch> | null;
  m: number | null;
  tasks: number | null;
  sigmaRun: number | null;
  mde80Gate: number | null;
  deltaTarget: number | null;
  gatePass: boolean | null;
  estimates: EstimateRow[];
  gainPerMtok: number | null;
  arms: ArmSummary[];
  notes: string[];
}

export interface ProductionRow {
  template: string;
  runs: number;
  composed: number;
  reference: number;
  none: number;
  meanTokens: number | null;
  meanCostUsd: number | null;
  budgetStopRate: number | null;
  reuseRate: number | null;
}

export interface CurrentInfo {
  template: string;
  epoch: string;
  phase: number;
  claudeCodeVersion: string | null;
  models: { executor: string; editor: string; judge: string };
  h0Sha: string;
  project: string;
}

export interface BenchHistory {
  schema: 1;
  generated_at: string;
  current: CurrentInfo | null;
  rounds: BenchRound[];
  production: ProductionRow[];
  lessons: TemplateStats[];
}

interface ScoreLine {
  kind: string;
  arm?: string;
  scored?: boolean;
  score?: number | null;
  tokens?: number;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10) / 10);
const rate = (n: number, d: number): number | null => (d ? Math.round((n / d) * 1000) / 1000 : null);

/** The date of a report folder: from created_at, else from the folder name (YYYYMMDD-HHMMSS-...). */
function reportDate(id: string, createdAt: unknown): string {
  if (typeof createdAt === "string") return createdAt;
  const m = id.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : id;
}

function armsOf(dir: string): ArmSummary[] {
  const rows = readJsonl<ScoreLine>(path.join(dir, "scores.jsonl")).filter((r) => r.kind === "score" && r.arm);
  const out: ArmSummary[] = [];
  for (const arm of [...new Set(rows.map((r) => r.arm as string))]) {
    const a = rows.filter((r) => r.arm === arm);
    const scores = a.filter((r) => r.scored && typeof r.score === "number").map((r) => r.score as number);
    out.push({ arm, scored: scores.length, unscored: a.length - scores.length, meanScore: r1(mean(scores)), meanTokens: r1(mean(a.map((r) => r.tokens ?? 0))) });
  }
  return out;
}

interface MeasureJson {
  created_at?: string;
  m?: number;
  tasks?: number;
  sigmaRun?: number;
  gate?: { mde80: number; deltaTarget: number; pass: boolean };
  epoch?: Partial<Epoch>;
}
interface RoundJson {
  created_at?: string;
  m?: number;
  split?: "dev" | "holdout";
  decision?: string;
  estimates?: { name: string; tasks: number; droppedPairs: number; rule: { mean: number; lower: number; upper: number; outcome: EstimateRow["outcome"] } | null }[];
  gainPerMtok?: number | null;
  notes?: string[];
  epoch?: Partial<Epoch>;
}

export function collectHistory(store: string, ctx: Ctx | null): BenchHistory {
  const reports = path.join(store, "reports");
  const rounds: BenchRound[] = [];
  if (fs.existsSync(reports)) {
    for (const d of fs.readdirSync(reports, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(reports, d.name);
      const meas = readJson<MeasureJson | null>(path.join(dir, "measure.json"), null);
      const round = readJson<RoundJson | null>(path.join(dir, "round.json"), null);
      if (meas) {
        rounds.push({
          id: d.name,
          date: reportDate(d.name, meas.created_at),
          kind: "measure",
          split: "dev",
          decision: "Phase 0 measurement",
          template: templateLabel(meas.epoch),
          epoch: epochId(meas.epoch),
          epochInfo: meas.epoch ?? null,
          m: meas.m ?? null,
          tasks: meas.tasks ?? null,
          sigmaRun: meas.sigmaRun ?? null,
          mde80Gate: meas.gate?.mde80 ?? null,
          deltaTarget: meas.gate?.deltaTarget ?? null,
          gatePass: meas.gate?.pass ?? null,
          estimates: [],
          gainPerMtok: null,
          arms: armsOf(dir),
          notes: [],
        });
      } else if (round) {
        rounds.push({
          id: d.name,
          date: reportDate(d.name, round.created_at),
          kind: "round",
          split: round.split ?? "dev",
          decision: round.decision ?? null,
          template: templateLabel(round.epoch),
          epoch: epochId(round.epoch),
          epochInfo: round.epoch ?? null,
          m: round.m ?? null,
          tasks: Math.max(0, ...(round.estimates ?? []).map((e) => e.tasks)),
          sigmaRun: null,
          mde80Gate: null,
          deltaTarget: null,
          gatePass: null,
          estimates: (round.estimates ?? []).map((e) => ({
            name: e.name,
            outcome: e.rule?.outcome ?? "n/a",
            mean: r1(e.rule?.mean ?? null),
            lower: r1(e.rule?.lower ?? null),
            upper: r1(e.rule?.upper ?? null),
            tasks: e.tasks,
            droppedPairs: e.droppedPairs,
          })),
          gainPerMtok: round.gainPerMtok ?? null,
          arms: armsOf(dir),
          notes: round.notes ?? [],
        });
      }
    }
  }
  rounds.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  let current: CurrentInfo | null = null;
  let production: ProductionRow[] = [];
  let lessons: TemplateStats[] = [];
  if (ctx) {
    const e = epochOf(ctx);
    current = {
      template: templateLabel(e),
      epoch: epochId(e),
      phase: ctx.config.phase,
      claudeCodeVersion: ctx.runtime.claude_code_version,
      models: ctx.config.models,
      h0Sha: ctx.h0Sha,
      project: path.basename(ctx.pp.projectDir),
    };
    production = productionRows(readRunRecords(ctx.pp.runsDir).filter((r) => r.mode === "production"));
    if (ctx.lessonStore) lessons = templateStats(ctx.lessonStore.path);
  }
  return { schema: 1, generated_at: new Date().toISOString(), current, rounds, production, lessons };
}

function productionRows(recs: RunRecord[]): ProductionRow[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of recs) {
    const k = templateLabel({ plugin_version: r.fingerprint.plugin.version, plugin_sha: r.fingerprint.plugin.git_sha });
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].map(([template, g]) => {
    const looped = g.filter((r) => r.composed_tree_hash);
    return {
      template,
      runs: g.length,
      composed: g.filter((r) => r.outcome === "composed").length,
      reference: g.filter((r) => r.outcome === "reference").length,
      none: g.filter((r) => r.outcome === "none").length,
      meanTokens: r1(mean(g.map((r) => r.totals.tokens))),
      meanCostUsd: g.length ? Math.round((g.reduce((a, r) => a + r.totals.costUsd, 0) / g.length) * 10000) / 10000 : null,
      budgetStopRate: rate(g.filter((r) => r.budget_stop).length, g.length),
      reuseRate: rate(looped.filter((r) => r.reuse_event).length, looped.length),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Render. Every text from the data goes through esc(): task IDs and decisions are free text.

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Color tokens for the charts and the page (dataviz reference palette; status colors are fixed). */
const TOKENS = `
  --surface: #fcfcfb; --page: #f9f9f7; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --series-1: #2a78d6; --ring: #fcfcfb;
  --good: #0ca30c; --serious: #ec835a; --critical: #d03b3b; --neutral: #898781;`;
const TOKENS_DARK = `
  --surface: #1a1a19; --page: #0d0d0d; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --series-1: #3987e5; --ring: #1a1a19; color-scheme: dark;`;

function themeCss(scope: string): string {
  return `${scope} { ${TOKENS} }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) ${scope === ":root" ? "" : scope} { ${TOKENS_DARK} } }
:root[data-theme="dark"] ${scope === ":root" ? "" : scope} { ${TOKENS_DARK} }`;
}

const OUTCOME: Record<EstimateRow["outcome"], { label: string; icon: string; color: string; shape: "circle" | "diamond" | "square" | "ring" }> = {
  pass: { label: "Pass", icon: "✓", color: "var(--good)", shape: "circle" },
  fail: { label: "Fail", icon: "↓", color: "var(--serious)", shape: "square" },
  worse: { label: "Tệ hơn", icon: "✕", color: "var(--critical)", shape: "diamond" },
  inconclusive: { label: "Chưa kết luận", icon: "?", color: "var(--neutral)", shape: "ring" },
  "n/a": { label: "Thiếu task", icon: "–", color: "var(--neutral)", shape: "ring" },
};

function marker(shape: string, x: number, y: number, color: string): string {
  const ring = `stroke="var(--ring)" stroke-width="2"`;
  if (shape === "diamond") return `<path d="M${x} ${y - 6}L${x + 6} ${y}L${x} ${y + 6}L${x - 6} ${y}Z" fill="${color}" ${ring}/>`;
  if (shape === "square") return `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2" fill="${color}" ${ring}/>`;
  if (shape === "ring") return `<circle cx="${x}" cy="${y}" r="5" fill="var(--surface)" stroke="${color}" stroke-width="2"/>`;
  return `<circle cx="${x}" cy="${y}" r="5.5" fill="${color}" ${ring}/>`;
}

function niceTicks(lo: number, hi: number, count = 6): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * pow).find((s) => s >= raw) ?? pow * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const shortDate = (iso: string): string => iso.slice(0, 10);

/** Forest plot: one row for each estimate of each eval round. Returns null when no round has an estimate. */
export function estimatesSvg(h: BenchHistory, deltaMin: number): string | null {
  const rows = h.rounds.flatMap((r) => r.estimates.filter((e) => e.mean !== null).map((e) => ({ r, e })));
  if (!rows.length) return null;
  const W = 860;
  const left = 300;
  const right = 720;
  const rowH = 38;
  const top = 40;
  const H = top + rows.length * rowH + 46;
  const lo = Math.min(-deltaMin, ...rows.map((x) => x.e.lower as number)) - 1;
  const hi = Math.max(deltaMin, ...rows.map((x) => x.e.upper as number)) + 1;
  const ticks = niceTicks(lo, hi);
  const t0 = Math.min(lo, ticks[0] as number);
  const t1 = Math.max(hi, ticks[ticks.length - 1] as number);
  const sx = (v: number): number => left + ((v - t0) / (t1 - t0)) * (right - left);
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="var(--surface)"/>`);
  for (const t of ticks) {
    parts.push(`<line x1="${sx(t)}" y1="${top - 8}" x2="${sx(t)}" y2="${H - 34}" stroke="var(--grid)" stroke-width="1"/>`);
    parts.push(`<text x="${sx(t)}" y="${H - 18}" text-anchor="middle" class="tick">${t}</text>`);
  }
  parts.push(`<line x1="${sx(0)}" y1="${top - 12}" x2="${sx(0)}" y2="${H - 34}" stroke="var(--axis)" stroke-width="1.5"/>`);
  parts.push(`<line x1="${sx(deltaMin)}" y1="${top - 12}" x2="${sx(deltaMin)}" y2="${H - 34}" stroke="var(--good)" stroke-width="1" stroke-dasharray="4 3"/>`);
  parts.push(`<text x="${sx(deltaMin) + 4}" y="${top - 16}" class="lab">δ_min = ${deltaMin}</text>`);
  parts.push(`<text x="${left}" y="${H - 2}" class="lab">điểm (estimate mới − estimate cũ), khoảng tin cậy one-sided 90%</text>`);
  rows.forEach(({ r, e }, i) => {
    const y = top + i * rowH + rowH / 2;
    const o = OUTCOME[e.outcome];
    const title = `${shortDate(r.date)} · ${r.split} · ${e.name}: mean ${e.mean}, 90% [${e.lower}, ${e.upper}], ${e.tasks} task, ${o.label}`;
    parts.push(`<g><title>${esc(title)}</title>`);
    parts.push(`<rect x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}" fill="transparent"/>`);
    parts.push(`<text x="12" y="${y - 2}" class="row">${esc(shortDate(r.date))} · ${esc(r.split)} · ${esc(e.name)}</text>`);
    parts.push(`<text x="12" y="${y + 13}" class="tick">${esc(r.template)} · ${e.tasks} task</text>`);
    parts.push(`<line x1="${sx(e.lower as number)}" y1="${y}" x2="${sx(e.upper as number)}" y2="${y}" stroke="${o.color}" stroke-width="2" stroke-linecap="round"/>`);
    parts.push(marker(o.shape, sx(e.mean as number), y, o.color));
    parts.push(`<text x="${right + 18}" y="${y + 4}" class="row">${o.icon} ${esc(o.label)}</text>`);
    parts.push(`</g>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" class="viz" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Ước lượng của từng đợt eval với khoảng tin cậy 90%">${parts.join("")}</svg>`;
}

/** Mean score of frozen H0 in each measurement, with a mark where the epoch changes. */
export function scoreTrendSvg(h: BenchHistory): string | null {
  const pts = h.rounds
    .filter((r) => r.kind === "measure")
    .map((r) => ({ r, v: r.arms.find((a) => a.arm === "h0")?.meanScore ?? null }))
    .filter((p): p is { r: BenchRound; v: number } => p.v !== null);
  if (!pts.length) return null;
  const W = 860;
  const H = 220;
  const left = 56;
  const right = 820;
  const top = 24;
  const bottom = 172;
  const sy = (v: number): number => bottom - (v / 100) * (bottom - top);
  const step = pts.length > 1 ? (right - left) / (pts.length - 1) : 0;
  const sx = (i: number): number => (pts.length > 1 ? left + i * step : (left + right) / 2);
  const parts: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="var(--surface)"/>`];
  for (const t of [0, 20, 40, 60, 80, 100]) {
    parts.push(`<line x1="${left}" y1="${sy(t)}" x2="${right}" y2="${sy(t)}" stroke="${t === 0 ? "var(--axis)" : "var(--grid)"}" stroke-width="1"/>`);
    parts.push(`<text x="${left - 10}" y="${sy(t) + 4}" text-anchor="end" class="tick">${t}</text>`);
  }
  pts.forEach((p, i) => {
    if (i > 0 && p.r.epoch !== (pts[i - 1] as { r: BenchRound }).r.epoch) {
      const x = (sx(i) + sx(i - 1)) / 2;
      parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="var(--axis)" stroke-width="1"/>`);
      parts.push(`<text x="${x + 4}" y="${top + 10}" class="lab">epoch mới</text>`);
    }
    parts.push(`<text x="${sx(i)}" y="${bottom + 20}" text-anchor="middle" class="tick">${esc(shortDate(p.r.date))}</text>`);
  });
  if (pts.length > 1) parts.push(`<polyline points="${pts.map((p, i) => `${sx(i)},${sy(p.v)}`).join(" ")}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
  pts.forEach((p, i) => {
    parts.push(`<g><title>${esc(`${shortDate(p.r.date)} · ${p.r.template} · H0 mean ${p.v} · σ_run ${p.r.sigmaRun ?? "n/a"}`)}</title>`);
    parts.push(`<circle cx="${sx(i)}" cy="${sy(p.v)}" r="12" fill="transparent"/>`);
    parts.push(`<circle cx="${sx(i)}" cy="${sy(p.v)}" r="5" fill="var(--series-1)" stroke="var(--ring)" stroke-width="2"/></g>`);
  });
  const last = pts[pts.length - 1] as { v: number };
  parts.push(`<text x="${sx(pts.length - 1)}" y="${sy(last.v) - 12}" text-anchor="middle" class="row">${last.v}</text>`);
  parts.push(`<text x="${left}" y="${H - 6}" class="lab">score trung bình của H0 đông cứng trên dev (0–100); chỉ so được trong cùng epoch</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="viz" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Score trung bình của H0 theo từng lần measure">${parts.join("")}</svg>`;
}

const fmt = (x: number | null | undefined, unit = ""): string => (x === null || x === undefined ? "–" : `${x}${unit}`);
const pct = (x: number | null): string => (x === null ? "–" : `${Math.round(x * 1000) / 10}%`);

function latest<T>(xs: T[]): T | null {
  return xs.length ? (xs[xs.length - 1] as T) : null;
}

export function renderDashboard(h: BenchHistory, deltaMin: number): string {
  const lastMeasure = latest(h.rounds.filter((r) => r.kind === "measure"));
  const lastRound = latest(h.rounds.filter((r) => r.kind === "round"));
  const e1 = lastRound?.estimates.find((e) => e.name === "E1") ?? null;
  const cur = h.current;
  const inEpoch = cur ? h.rounds.filter((r) => r.epoch === cur.epoch).length : 0;
  const est = estimatesSvg(h, deltaMin);
  const trend = scoreTrendSvg(h);
  const tile = (label: string, value: string, note: string): string => `<div class="tile"><span class="tl">${esc(label)}</span><span class="tv">${value}</span><span class="tn">${note}</span></div>`;
  const outcomePill = (o: EstimateRow["outcome"]): string => `<span class="pill o-${o}">${OUTCOME[o].icon} ${esc(OUTCOME[o].label)}</span>`;

  const tiles = [
    tile("Template version", `<code class="tv-code">${esc(cur?.template ?? lastRound?.template ?? lastMeasure?.template ?? "–")}</code>`, cur ? `Phase ${cur.phase} · epoch ${esc(cur.epoch)}` : "chạy với --project để thấy version hiện tại"),
    tile(
      "Gate Phase 0",
      lastMeasure ? `${fmt(lastMeasure.mde80Gate)} / ${fmt(lastMeasure.deltaTarget)}` : "–",
      lastMeasure ? `MDE80 / δ_target · ${lastMeasure.gatePass ? "✓ PASS" : "✕ FAIL"}` : "chưa có lần measure",
    ),
    tile("σ_run", fmt(lastMeasure?.sigmaRun ?? null), lastMeasure ? `${lastMeasure.tasks} task × m=${lastMeasure.m}` : "–"),
    tile("E1 gần nhất", e1 && e1.mean !== null ? `${e1.mean > 0 ? "+" : ""}${e1.mean}` : "–", e1 ? `${OUTCOME[e1.outcome].icon} ${esc(OUTCOME[e1.outcome].label)} · 90% [${fmt(e1.lower)}, ${fmt(e1.upper)}]` : "chưa có đợt eval"),
    tile("Gain per Mtok", fmt(lastRound?.gainPerMtok ?? null), "điểm E1 trên 1 triệu token thêm"),
  ].join("");

  const historyRows = [...h.rounds]
    .reverse()
    .map((r) => {
      const est2 = r.estimates.length
        ? r.estimates.map((e) => `<div>${esc(e.name)}: ${fmt(e.mean)} [${fmt(e.lower)}, ${fmt(e.upper)}] ${outcomePill(e.outcome)}</div>`).join("")
        : r.kind === "measure"
          ? `MDE80 ${fmt(r.mde80Gate)} / ${fmt(r.deltaTarget)} ${r.gatePass ? '<span class="pill o-pass">✓ PASS</span>' : '<span class="pill o-worse">✕ FAIL</span>'}`
          : "–";
      const arms = r.arms.map((a) => `${esc(a.arm)} ${fmt(a.meanScore)} (${a.scored}${a.unscored ? `+${a.unscored} unscored` : ""})`).join("<br>");
      const current = cur && r.epoch === cur.epoch ? ' class="cur"' : "";
      return `<tr${current}><td>${esc(shortDate(r.date))}</td><td>${r.kind === "measure" ? "measure" : "eval"} · ${esc(r.split)}<br><span class="sub">${esc(r.decision ?? "")}</span></td><td><code>${esc(r.template)}</code><br><span class="sub">epoch ${esc(r.epoch)}</span></td><td class="num">${fmt(r.tasks)} × ${fmt(r.m)}</td><td class="num">${fmt(r.sigmaRun)}</td><td>${est2}</td><td class="num">${arms || "–"}</td><td class="num">${fmt(r.gainPerMtok)}</td></tr>`;
    })
    .join("");

  const prodRows = h.production
    .map((p) => `<tr><td><code>${esc(p.template)}</code></td><td class="num">${p.runs}</td><td class="num">${p.composed} / ${p.reference} / ${p.none}</td><td class="num">${fmt(p.meanTokens)}</td><td class="num">${p.meanCostUsd === null ? "–" : "$" + p.meanCostUsd}</td><td class="num">${pct(p.budgetStopRate)}</td><td class="num">${pct(p.reuseRate)}</td></tr>`)
    .join("");
  const lessonRows = h.lessons
    .map((t) => `<tr><td><code>${esc(t.template)}</code></td><td class="num">${t.episodes}</td><td class="num">${fmt(t.meanTokens)}</td><td class="num">${pct(t.budgetStopRate)}</td><td class="num">${pct(t.keptBaseRate)}</td><td class="num">${pct(t.composedGatePassRate)}</td><td class="num">${t.lessons}</td><td class="num">${pct(t.mergeRate)}</td><td class="num">${pct(t.editRate)}</td></tr>`)
    .join("");
  const empty = (text: string): string => `<p class="empty">${text}</p>`;

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness Benchmarks</title>
<style>
${themeCss(":root")}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px max(16px, env(safe-area-inset-left, 0px)); }
main { max-width: 1100px; margin: 0 auto; display: grid; gap: 22px; }
h1 { font-size: 1.5rem; margin: 0; } h2 { font-size: 1.05rem; margin: 0 0 8px; }
.meta { color: var(--ink-2); font-size: 0.85rem; }
.warn { border: 1px solid var(--serious); border-radius: 8px; padding: 10px 14px; background: var(--surface); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.tile { background: var(--surface); border: 1px solid var(--grid); border-radius: 10px; padding: 12px 14px; display: grid; gap: 2px; min-width: 0; }
.tv-code { font-size: 1rem; font-weight: 500; }
.tl { font-size: 0.78rem; color: var(--ink-2); } .tv { font-size: 1.5rem; font-weight: 600; overflow-wrap: anywhere; } .tn { font-size: 0.8rem; color: var(--muted); }
section { background: var(--surface); border: 1px solid var(--grid); border-radius: 10px; padding: 14px 16px; min-width: 0; }
.scroll { overflow-x: auto; }
.scroll svg { min-width: 640px; display: block; }
table { border-collapse: collapse; width: 100%; font-size: 0.86rem; }
th, td { text-align: left; vertical-align: top; padding: 7px 8px; border-bottom: 1px solid var(--grid); }
th { color: var(--ink-2); font-weight: 600; font-size: 0.78rem; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.cur td:first-child { box-shadow: inset 3px 0 0 var(--series-1); }
.sub { color: var(--muted); font-size: 0.78rem; }
code { font: 0.82rem ui-monospace, Menlo, monospace; }
.pill { display: inline-block; border-radius: 99px; padding: 0 7px; font-size: 0.75rem; border: 1px solid currentColor; white-space: nowrap; }
.o-pass { color: var(--good); } .o-fail { color: var(--serious); } .o-worse { color: var(--critical); } .o-inconclusive, .o-n\\/a { color: var(--ink-2); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 0.8rem; color: var(--ink-2); margin: 6px 0 0; }
.empty { color: var(--ink-2); margin: 0; }
svg text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--ink); }
svg .row { font-size: 13px; } svg .tick { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; } svg .lab { font-size: 11px; fill: var(--ink-2); }
</style></head>
<body><main>
<header>
  <h1>Harness benchmarks</h1>
  <div class="meta">Tạo lúc ${esc(h.generated_at)}${cur ? ` · project ${esc(cur.project)} · Claude Code ${esc(cur.claudeCodeVersion ?? "?")} · executor ${esc(cur.models.executor)} · judge ${esc(cur.models.judge)}` : ""}</div>
</header>
<div class="warn">Trang này có score. Duyệt library PR của tuần trước khi mở trang (B4). Chỉ so score trong cùng epoch: đổi H0, model, Claude Code hay version template là epoch mới.</div>
<div class="tiles">${tiles}</div>
<section><h2>Ước lượng của từng đợt eval</h2>
${est ? `<div class="scroll">${est}</div><div class="legend"><span>● ✓ Pass</span><span>■ ↓ Fail</span><span>◆ ✕ Tệ hơn</span><span>○ ? Chưa kết luận</span><span>vạch đứt: δ_min</span></div>` : empty("Chưa có đợt eval. Từ Phase 2, chạy <code>harness eval --split dev</code>.")}
</section>
<section><h2>Score của H0 theo từng lần measure</h2>
${trend ? `<div class="scroll">${trend}</div>` : empty("Chưa có lần measure. Chạy <code>harness measure</code> (Phase 0).")}
</section>
<section><h2>Lịch sử version (${h.rounds.length} đợt${cur ? `, ${inEpoch} trong epoch hiện tại` : ""})</h2>
${h.rounds.length ? `<div class="scroll"><table><thead><tr><th>Ngày</th><th>Loại</th><th>Template version</th><th>Task × m</th><th>σ_run</th><th>Kết quả</th><th>Score trung bình theo nhánh (số run)</th><th>Gain/Mtok</th></tr></thead><tbody>${historyRows}</tbody></table></div>` : empty("Chưa có dữ liệu.")}
</section>
<section><h2>Production theo template version (không có score)</h2>
${prodRows ? `<div class="scroll"><table><thead><tr><th>Template version</th><th>Run</th><th>Composed / reference / none</th><th>Token TB</th><th>Chi phí TB</th><th>Chạm trần budget</th><th>Reuse</th></tr></thead><tbody>${prodRows}</tbody></table></div>` : empty(cur ? "Project này chưa có run production." : "Chạy <code>harness bench --project .</code> để thêm phần này.")}
</section>
<section><h2>Hiệu quả theo template version (lesson store)</h2>
${lessonRows ? `<div class="scroll"><table><thead><tr><th>Template version</th><th>Episode</th><th>Token/episode</th><th>Chạm trần budget</th><th>KEEP_BASE</th><th>Composed qua gate</th><th>Lesson</th><th>Merge</th><th>Thức sửa</th></tr></thead><tbody>${lessonRows}</tbody></table></div>` : empty("Lesson store chưa có episode, hoặc lesson store tắt.")}
</section>
<footer class="meta">Nguồn: <code>reports/*/measure.json</code>, <code>reports/*/round.json</code>, <code>reports/*/scores.jsonl</code>, run record của project, lesson store.</footer>
</main></body></html>
`;
}

/** Write the dashboard to <eval_store>/benchmarks.html. Returns its path and the number of rounds. */
export function writeBenchmarks(store: string, ctx: Ctx | null, deltaMin: number): { dashboard: string; rounds: number } {
  const h = collectHistory(store, ctx);
  const dashboard = path.join(store, "benchmarks.html");
  fs.writeFileSync(dashboard, renderDashboard(h, deltaMin));
  return { dashboard, rounds: h.rounds.length };
}

/** Update the dashboard after a measurement or a round. A failure here never fails the command. */
export function refreshDashboard(ctx: Ctx): string | null {
  const store = ctx.user.eval_store;
  if (!store) return null;
  try {
    const w = YAML.parse(fs.readFileSync(path.join(store, "weights.yaml"), "utf8")) as { delta_min?: number } | null;
    return writeBenchmarks(store, ctx, w?.delta_min ?? 3).dashboard;
  } catch {
    return null;
  }
}
