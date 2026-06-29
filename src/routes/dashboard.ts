import type { JsonValue } from "../types/json.js"
import type {
  WorkflowDefinition,
  WorkflowEventRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepAttemptRecord,
  WorkflowUsageRecord,
} from "../types/workflow.js"
import { getWorkflowMermaidNodeIds } from "../lib/workflow-definition.js"

const dashboardRunPath = (runId: string) => `/dashboard/runs/${runId}`

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const formatDateTime = (value: Date | null) =>
  value ? value.toISOString().replace("T", " ").replace("Z", " UTC") : "—"

const formatJsonRaw = (value: JsonValue) =>
  JSON.stringify(value, null, 2) ?? "null"

const formatJson = (value: JsonValue) => escapeHtml(formatJsonRaw(value))

const statusToneByRun = {
  queued: "tone-queued",
  running: "tone-running",
  waiting: "tone-waiting",
  completed: "tone-completed",
  failed: "tone-failed",
  compensation_failed: "tone-failed",
  exhausted_budget: "tone-failed",
  canceled: "tone-canceled",
} as const

let mermaidMountCounter = 0
const nextMermaidMountId = () =>
  `hm-${(++mermaidMountCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const renderMermaidMount = (
  graph: string,
  nodeActions?: Record<
    string,
    { label: string; nodeText?: string; stepKey?: string; href?: string }
  >
) => {
  if (!nodeActions || Object.keys(nodeActions).length === 0) {
    return `<div class="mermaid" data-graph="${escapeHtml(graph)}"></div>`
  }

  const mountId = nextMermaidMountId()
  const clickLines = Object.entries(nodeActions).map(([nodeId, action]) => {
    const tooltip = (action.label ?? "").replaceAll('"', "'")
    return `  click ${nodeId} call hippoMermaidActivate("${mountId}", "${nodeId}")${
      tooltip ? ` "${tooltip}"` : ""
    }`
  })
  const enriched = `${graph}\n${clickLines.join("\n")}`

  return `<div class="mermaid" data-mount-id="${escapeHtml(mountId)}" data-graph="${escapeHtml(enriched)}"></div>
<script>(window.__hippoMermaidActions=window.__hippoMermaidActions||{})[${JSON.stringify(mountId)}]=${JSON.stringify(nodeActions)};</script>`
}

const renderMermaidBootstrap = () => `<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"

  const storageKey = "hippo-dashboard-theme"
  const root = document.documentElement
  const getPreferredTheme = () => {
    const storedTheme = window.localStorage.getItem(storageKey)

    if (storedTheme === "light" || storedTheme === "dark") {
      return storedTheme
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
  }

  const applyTheme = (theme) => {
    root.classList.toggle("dark", theme === "dark")
    root.style.colorScheme = theme
    window.localStorage.setItem(storageKey, theme)
    const toggle = document.querySelector("[data-theme-toggle]")

    if (toggle instanceof HTMLButtonElement) {
      toggle.dataset.theme = theme
      toggle.setAttribute(
        "aria-label",
        theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
      )
      toggle.textContent = theme === "dark" ? "Light" : "Dark"
    }
  }

  const renderFallback = () => {
    for (const node of document.querySelectorAll(".mermaid")) {
      const graph = node.getAttribute("data-graph")

      if (!graph) {
        continue
      }

      node.innerHTML = '<pre class="mermaid-fallback"></pre>'
      const pre = node.querySelector("pre")

      if (pre) {
        pre.textContent = graph
      }
    }
  }

  const applyStepSelection = (stepKey) => {
    const cards = [...document.querySelectorAll("[data-step-key]")]
    let firstMatch = null

    for (const card of cards) {
      const matches = card instanceof HTMLElement && card.dataset.stepKey === stepKey
      card.classList.toggle("entry-selected", matches)

      if (matches && firstMatch === null && card instanceof HTMLElement) {
        firstMatch = card
      }
    }

    firstMatch?.scrollIntoView({ behavior: "smooth", block: "center" })
    return firstMatch !== null
  }

  window.hippoMermaidActivate = (mountId, nodeId) => {
    const registry = window.__hippoMermaidActions || {}
    const action = registry[mountId] && registry[mountId][nodeId]

    if (!action || typeof action !== "object") {
      return
    }

    if (typeof action.stepKey === "string") {
      const selected = applyStepSelection(action.stepKey)

      if (selected) {
        return
      }
    }

    if (typeof action.href === "string") {
      window.location.assign(action.href)
    }
  }

  const renderMermaids = async () => {
    const isDark = root.classList.contains("dark")

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: "base",
      themeVariables: {
        primaryColor: isDark ? "#0f172a" : "#ffffff",
        primaryTextColor: isDark ? "#e2e8f0" : "#0f172a",
        primaryBorderColor: isDark ? "#475569" : "#cbd5e1",
        lineColor: isDark ? "#64748b" : "#94a3b8",
        secondaryColor: isDark ? "#111827" : "#f8fafc",
        tertiaryColor: isDark ? "#020617" : "#f8fafc",
        background: "transparent",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      },
      flowchart: {
        curve: "linear",
        useMaxWidth: true,
        htmlLabels: false,
      },
    })

    for (const node of document.querySelectorAll(".mermaid")) {
      const graph = node.getAttribute("data-graph")

      if (!graph) {
        continue
      }

      node.removeAttribute("data-processed")
      node.textContent = graph
    }

    try {
      await mermaid.run({
        querySelector: ".mermaid",
      })
    } catch (error) {
      renderFallback()
      console.error(error)
    }
  }

  applyTheme(getPreferredTheme())
  await renderMermaids()

  document.querySelector("[data-theme-toggle]")?.addEventListener("click", async () => {
    const nextTheme = root.classList.contains("dark") ? "light" : "dark"
    applyTheme(nextTheme)
    await renderMermaids()
  })
</script>`

const shadcnThemeTokens = `
      :root {
        color-scheme: light;
        --background: 0 0% 100%;
        --foreground: 240 10% 3.9%;
        --card: 0 0% 100%;
        --card-foreground: 240 10% 3.9%;
        --popover: 0 0% 100%;
        --popover-foreground: 240 10% 3.9%;
        --primary: 240 5.9% 10%;
        --primary-foreground: 0 0% 98%;
        --secondary: 240 4.8% 95.9%;
        --secondary-foreground: 240 5.9% 10%;
        --muted: 240 4.8% 95.9%;
        --muted-foreground: 240 3.8% 46.1%;
        --accent: 240 4.8% 95.9%;
        --accent-foreground: 240 5.9% 10%;
        --destructive: 0 84.2% 60.2%;
        --destructive-foreground: 0 0% 98%;
        --warning: 38 92% 50%;
        --success: 142 71% 36%;
        --info: 217 91% 60%;
        --border: 240 5.9% 90%;
        --input: 240 5.9% 90%;
        --ring: 240 10% 3.9%;
        --radius: 0.5rem;
      }

      :root.dark {
        color-scheme: dark;
        --background: 240 10% 3.9%;
        --foreground: 0 0% 98%;
        --card: 240 10% 3.9%;
        --card-foreground: 0 0% 98%;
        --popover: 240 10% 3.9%;
        --popover-foreground: 0 0% 98%;
        --primary: 0 0% 98%;
        --primary-foreground: 240 5.9% 10%;
        --secondary: 240 3.7% 15.9%;
        --secondary-foreground: 0 0% 98%;
        --muted: 240 3.7% 15.9%;
        --muted-foreground: 240 5% 64.9%;
        --accent: 240 3.7% 15.9%;
        --accent-foreground: 0 0% 98%;
        --destructive: 0 62.8% 30.6%;
        --destructive-foreground: 0 0% 98%;
        --warning: 38 92% 60%;
        --success: 142 71% 45%;
        --info: 217 91% 70%;
        --border: 240 3.7% 15.9%;
        --input: 240 3.7% 15.9%;
        --ring: 240 4.9% 83.9%;
      }`

const shadcnBaseStyles = `
      *, *::before, *::after { box-sizing: border-box; border-color: hsl(var(--border)); }

      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-feature-settings: "rlig" 1, "calt" 1;
        background: hsl(var(--background));
        color: hsl(var(--foreground));
        -webkit-font-smoothing: antialiased;
        line-height: 1.5;
      }

      h1, h2, h3, h4, p { margin: 0; }
      a { color: inherit; text-decoration: none; }
      code { font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace; font-size: 0.85em; }

      .container {
        width: 100%;
        max-width: 1400px;
        margin: 0 auto;
        padding: 0 2rem;
      }

      .site-header {
        position: sticky;
        top: 0;
        z-index: 40;
        background: hsl(var(--background) / 0.95);
        border-bottom: 1px solid hsl(var(--border));
        backdrop-filter: blur(8px);
      }

      .header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        height: 3.5rem;
      }

      .brand-row {
        display: flex;
        align-items: center;
        gap: 1.5rem;
      }

      .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        font-weight: 600;
        font-size: 0.95rem;
        letter-spacing: -0.01em;
      }

      .brand-mark {
        display: inline-flex;
        width: 1.5rem;
        height: 1.5rem;
        border-radius: 0.375rem;
        background: hsl(var(--primary));
        color: hsl(var(--primary-foreground));
        align-items: center;
        justify-content: center;
        font-size: 0.7rem;
        font-weight: 700;
      }

      .nav {
        display: flex;
        align-items: center;
        gap: 1.25rem;
      }

      .nav-item {
        font-size: 0.875rem;
        font-weight: 500;
        color: hsl(var(--muted-foreground));
        transition: color 0.15s;
      }
      .nav-item:hover { color: hsl(var(--foreground)); }
      .nav-item-active { color: hsl(var(--foreground)); }

      .header-actions { display: flex; align-items: center; gap: 0.5rem; }

      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        font-size: 0.875rem;
        font-weight: 500;
        border-radius: calc(var(--radius) - 2px);
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        cursor: pointer;
        border: 1px solid transparent;
        font-family: inherit;
        text-decoration: none;
      }
      .btn-sm { height: 2.25rem; padding: 0 0.75rem; }
      .btn-primary {
        background: hsl(var(--primary));
        color: hsl(var(--primary-foreground));
      }
      .btn-primary:hover { background: hsl(var(--primary) / 0.9); }
      .btn-outline {
        background: hsl(var(--background));
        border-color: hsl(var(--input));
        color: hsl(var(--foreground));
      }
      .btn-outline:hover { background: hsl(var(--accent)); color: hsl(var(--accent-foreground)); }

      .card {
        background: hsl(var(--card));
        color: hsl(var(--card-foreground));
        border: 1px solid hsl(var(--border));
        border-radius: var(--radius);
        box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.04);
      }

      .card-header {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        padding: 1.5rem 1.5rem 0;
      }
      .card-header-row {
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 0.5rem;
        gap: 0.5rem;
      }
      .card-title {
        font-size: 1rem;
        font-weight: 600;
        letter-spacing: -0.01em;
        line-height: 1.2;
      }
      .card-title-sm {
        font-size: 0.875rem;
        font-weight: 500;
        line-height: 1;
      }
      .card-description {
        font-size: 0.875rem;
        color: hsl(var(--muted-foreground));
      }
      .card-content { padding: 1.5rem; }
      .card-header + .card-content { padding-top: 1rem; }

      .icon { width: 1rem; height: 1rem; color: hsl(var(--muted-foreground)); flex-shrink: 0; }

      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: calc(var(--radius) - 2px);
        padding: 0.125rem 0.5rem;
        border: 1px solid transparent;
        font-size: 0.75rem;
        font-weight: 600;
        line-height: 1.25;
        text-transform: capitalize;
      }
      .tone-queued, .tone-waiting {
        background: hsl(var(--warning) / 0.12);
        border-color: hsl(var(--warning) / 0.3);
        color: hsl(var(--warning));
      }
      .tone-running {
        background: hsl(var(--info) / 0.12);
        border-color: hsl(var(--info) / 0.3);
        color: hsl(var(--info));
      }
      .tone-completed {
        background: hsl(var(--success) / 0.12);
        border-color: hsl(var(--success) / 0.3);
        color: hsl(var(--success));
      }
      .tone-failed {
        background: hsl(var(--destructive) / 0.12);
        border-color: hsl(var(--destructive) / 0.3);
        color: hsl(var(--destructive));
      }
      .tone-canceled {
        background: hsl(var(--muted));
        border-color: hsl(var(--border));
        color: hsl(var(--muted-foreground));
      }

      .meta {
        font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
        font-size: 0.75rem;
        color: hsl(var(--muted-foreground));
      }

      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      .stack { display: grid; gap: 0.75rem; }

      .shell {
        display: grid;
        grid-template-columns: 240px minmax(0, 1fr);
        min-height: 100vh;
      }

      .sidebar {
        position: sticky;
        top: 0;
        align-self: start;
        height: 100vh;
        border-right: 1px solid hsl(var(--border));
        background: hsl(var(--background));
        display: flex;
        flex-direction: column;
        padding: 1rem 0.75rem;
        gap: 1rem;
      }
      .sidebar-brand {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.25rem 0.5rem;
        font-weight: 600;
        font-size: 0.95rem;
      }
      .sidebar-section {
        display: grid;
        gap: 0.125rem;
      }
      .sidebar-heading {
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: hsl(var(--muted-foreground));
        padding: 0.5rem 0.5rem 0.25rem;
      }
      .sidebar-link {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.625rem;
        border-radius: calc(var(--radius) - 2px);
        font-size: 0.875rem;
        font-weight: 500;
        color: hsl(var(--muted-foreground));
        transition: background 0.15s, color 0.15s;
      }
      .sidebar-link:hover {
        background: hsl(var(--accent));
        color: hsl(var(--accent-foreground));
      }
      .sidebar-link-active {
        background: hsl(var(--accent));
        color: hsl(var(--accent-foreground));
      }
      .sidebar-foot {
        margin-top: auto;
        padding: 0.5rem;
        display: flex;
        justify-content: flex-end;
      }

      .content {
        min-width: 0;
        padding: 1.5rem 2rem 4rem;
        display: grid;
        gap: 1.5rem;
        align-content: start;
        grid-auto-rows: min-content;
      }

      .stat-grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }

      .page-bar {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .page-bar h1 {
        font-size: 1.5rem;
        font-weight: 700;
        letter-spacing: -0.025em;
        line-height: 1.2;
      }
      .page-bar p {
        font-size: 0.875rem;
        color: hsl(var(--muted-foreground));
        margin-top: 0.25rem;
      }

      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        align-items: center;
        padding: 0.75rem;
        border: 1px solid hsl(var(--border));
        border-radius: calc(var(--radius) - 2px);
        background: hsl(var(--card));
      }
      .chip-group { display: flex; flex-wrap: wrap; gap: 0.25rem; }
      .chip {
        display: inline-flex;
        align-items: center;
        padding: 0.25rem 0.625rem;
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: 500;
        border: 1px solid hsl(var(--border));
        color: hsl(var(--muted-foreground));
        background: hsl(var(--background));
        white-space: nowrap;
      }
      .chip:hover { color: hsl(var(--foreground)); }
      .chip-active {
        background: hsl(var(--primary));
        color: hsl(var(--primary-foreground));
        border-color: hsl(var(--primary));
      }

      .input {
        font-family: inherit;
        font-size: 0.8125rem;
        padding: 0.375rem 0.625rem;
        border-radius: calc(var(--radius) - 2px);
        border: 1px solid hsl(var(--input));
        background: hsl(var(--background));
        color: hsl(var(--foreground));
        min-width: 0;
      }
      .input:focus { outline: 2px solid hsl(var(--ring)); outline-offset: -1px; }

      .runs-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.8125rem;
      }
      .runs-table th, .runs-table td {
        text-align: left;
        padding: 0.5rem 0.75rem;
        border-bottom: 1px solid hsl(var(--border));
      }
      .runs-table th {
        font-weight: 600;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: hsl(var(--muted-foreground));
        background: hsl(var(--muted) / 0.3);
      }
      .runs-table tr[data-href] { cursor: pointer; }
      .runs-table tr:hover td { background: hsl(var(--muted) / 0.4); }
      .runs-table tr:focus-visible td { outline: 2px solid hsl(var(--ring)); outline-offset: -2px; }

      .pre-json {
        color: hsl(var(--foreground));
      }
      .pre-json .j-key { color: hsl(217 91% 60%); }
      .pre-json .j-str { color: hsl(142 71% 38%); }
      .pre-json .j-num { color: hsl(28 92% 50%); }
      .pre-json .j-bool { color: hsl(280 70% 55%); }
      .pre-json .j-null { color: hsl(0 70% 55%); }
      :root.dark .pre-json .j-key { color: hsl(217 91% 70%); }
      :root.dark .pre-json .j-str { color: hsl(142 71% 55%); }
      :root.dark .pre-json .j-num { color: hsl(28 92% 65%); }
      :root.dark .pre-json .j-bool { color: hsl(280 75% 72%); }
      :root.dark .pre-json .j-null { color: hsl(0 80% 70%); }
      .runs-table td.mono {
        font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
        font-size: 0.75rem;
      }
      .runs-table a.run-link {
        font-weight: 500;
        color: hsl(var(--foreground));
      }
      .runs-table a.run-link:hover { text-decoration: underline; text-underline-offset: 3px; }

      .load-more-wrap {
        display: flex;
        justify-content: center;
        padding: 1rem 0;
      }

      @media (max-width: 900px) {
        .shell { grid-template-columns: 1fr; }
        .sidebar {
          position: static;
          height: auto;
          flex-direction: row;
          overflow-x: auto;
          gap: 0.5rem;
          padding: 0.5rem 0.75rem;
        }
        .sidebar-heading { display: none; }
        .sidebar-foot { margin-top: 0; padding: 0; }
        .content { padding: 1rem; }
      }`

export type SidebarNavId = "runs" | "definitions"

const renderSidebar = (activeNav: SidebarNavId | null) => {
  const item = (id: SidebarNavId, href: string, label: string) =>
    `<a class="sidebar-link${activeNav === id ? " sidebar-link-active" : ""}" href="${href}">${label}</a>`

  return `<aside class="sidebar">
      <a class="sidebar-brand" href="/dashboard/runs">
        <span class="brand-mark">H</span>
        <span>Hippo</span>
      </a>
      <div class="sidebar-section">
        <div class="sidebar-heading">Activity</div>
        ${item("runs", "/dashboard/runs", "Runs")}
      </div>
      <div class="sidebar-section">
        <div class="sidebar-heading">Catalog</div>
        ${item("definitions", "/dashboard/definitions", "Definitions")}
      </div>
      <div class="sidebar-foot">
        <button class="btn btn-outline btn-sm" type="button" data-theme-toggle aria-label="Switch theme">Dark</button>
      </div>
    </aside>`
}

const renderShellDocument = (args: {
  activeNav: SidebarNavId | null
  content: string
  includeMermaid?: boolean
  title: string
  pageStyles?: string
}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(args.title)}</title>
    <style>${shadcnThemeTokens}${shadcnBaseStyles}${args.pageStyles ?? ""}</style>
  </head>
  <body>
    <div class="shell">
      ${renderSidebar(args.activeNav)}
      <main class="content">${args.content}</main>
    </div>
    ${args.includeMermaid ? renderMermaidBootstrap() : ""}
    <script>
      (() => {
        const root = document.documentElement
        const storageKey = "hippo-dashboard-theme"
        const getStored = () => {
          const v = window.localStorage.getItem(storageKey)
          return v === "light" || v === "dark" ? v : null
        }
        const apply = (theme) => {
          root.classList.toggle("dark", theme === "dark")
          root.style.colorScheme = theme
          window.localStorage.setItem(storageKey, theme)
          const btn = document.querySelector("[data-theme-toggle]")
          if (btn) {
            btn.dataset.theme = theme
            btn.textContent = theme === "dark" ? "Light" : "Dark"
            btn.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode")
          }
        }
        const initial = getStored() ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        apply(initial)
        document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
          apply(root.classList.contains("dark") ? "light" : "dark")
          if (window.__hippoOnThemeChange) window.__hippoOnThemeChange()
        })

        const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        const jsonTokenRe = /("(?:\\\\u[a-fA-F0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(?:true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g
        window.hippoHighlightJson = (raw) => {
          const escaped = escapeHtml(raw)
          return escaped.replace(new RegExp(jsonTokenRe.source, "g"), (match) => {
            let cls = "j-num"
            if (match.startsWith("&quot;") || match.startsWith('"')) {
              cls = match.endsWith(":") || /:\\s*$/.test(match) ? "j-key" : "j-str"
            } else if (match === "true" || match === "false") {
              cls = "j-bool"
            } else if (match === "null") {
              cls = "j-null"
            }
            return '<span class="' + cls + '">' + match + "</span>"
          })
        }
        const highlightAll = (scope) => {
          ;(scope || document).querySelectorAll(".pre-json:not([data-highlighted])").forEach((el) => {
            el.innerHTML = window.hippoHighlightJson(el.textContent || "")
            el.setAttribute("data-highlighted", "1")
          })
        }
        window.hippoHighlightAllJson = highlightAll
        highlightAll(document)

        document.addEventListener("click", (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          if (target.closest("a, button, input, select, textarea, label, .chip")) return
          const row = target.closest("tr[data-href]")
          if (!row) return
          const href = row.getAttribute("data-href")
          if (!href) return
          if (event.metaKey || event.ctrlKey || event.button === 1) {
            window.open(href, "_blank")
          } else {
            window.location.assign(href)
          }
        })

        document.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return
          const target = event.target
          if (!(target instanceof Element)) return
          const row = target.closest("tr[data-href]")
          if (!row) return
          const href = row.getAttribute("data-href")
          if (href) window.location.assign(href)
        })
      })()
    </script>
  </body>
</html>`

const statusFilterOptions: { label: string; statuses: WorkflowRunStatus[]; id: string }[] = [
  { id: "all", label: "All", statuses: [] },
  {
    id: "active",
    label: "Active",
    statuses: ["queued", "running", "waiting"],
  },
  { id: "completed", label: "Completed", statuses: ["completed"] },
  {
    id: "failed",
    label: "Failed",
    statuses: ["failed", "compensation_failed", "exhausted_budget"],
  },
  { id: "canceled", label: "Canceled", statuses: ["canceled"] },
]

export const RUNS_PAGE_SIZE = 50

export const resolveStatusFilter = (id: string | undefined) =>
  statusFilterOptions.find((option) => option.id === id) ?? statusFilterOptions[0]!

const buildRunsQueryString = (params: {
  status?: string | undefined
  definition?: string | undefined
  search?: string | undefined
  afterUpdatedAt?: Date | undefined
  afterId?: string | undefined
}) => {
  const usp = new URLSearchParams()

  if (params.status && params.status !== "all") {
    usp.set("status", params.status)
  }

  if (params.definition) {
    usp.set("definition", params.definition)
  }

  if (params.search) {
    usp.set("search", params.search)
  }

  if (params.afterUpdatedAt && params.afterId) {
    usp.set("afterUpdatedAt", params.afterUpdatedAt.toISOString())
    usp.set("afterId", params.afterId)
  }

  const query = usp.toString()
  return query.length > 0 ? `?${query}` : ""
}

const renderRunsTableRow = (
  run: Pick<
    WorkflowRunRecord,
    "id" | "definitionName" | "status" | "currentStepKey" | "createdAt" | "updatedAt"
  >
) => {
  const href = dashboardRunPath(run.id)
  return `<tr data-href="${escapeHtml(href)}" tabindex="0">
  <td><a class="run-link" href="${href}">${escapeHtml(run.definitionName)}</a></td>
  <td><span class="badge ${statusToneByRun[run.status]}">${escapeHtml(run.status)}</span></td>
  <td>${escapeHtml(run.currentStepKey ?? "—")}</td>
  <td class="mono">${escapeHtml(run.id)}</td>
  <td class="mono">${escapeHtml(formatDateTime(run.createdAt))}</td>
  <td class="mono">${escapeHtml(formatDateTime(run.updatedAt))}</td>
</tr>`
}

export const renderRunsIndexDocument = (args: {
  runs: WorkflowRunRecord[]
  workflows: { name: string; title?: string }[]
  filters: {
    status: string
    definition: string | undefined
    search: string | undefined
  }
  nextCursor: { afterUpdatedAt: Date; afterId: string } | null
}) => {
  const { filters, runs, nextCursor, workflows } = args

  const chips = statusFilterOptions
    .map((option) => {
      const href = `/dashboard/runs${buildRunsQueryString({
        status: option.id,
        definition: filters.definition,
        search: filters.search,
      })}`
      const active = option.id === filters.status
      return `<a class="chip${active ? " chip-active" : ""}" href="${href}">${escapeHtml(option.label)}</a>`
    })
    .join("")

  const definitionOptions = [
    `<option value="">All definitions</option>`,
    ...workflows.map(
      (workflow) =>
        `<option value="${escapeHtml(workflow.name)}"${
          filters.definition === workflow.name ? " selected" : ""
        }>${escapeHtml(workflow.title ?? workflow.name)}</option>`
    ),
  ].join("")

  const tableBody = runs.length > 0
    ? runs.map(renderRunsTableRow).join("")
    : `<tr><td colspan="6" class="empty">No runs match the current filter.</td></tr>`

  const loadMoreHref = nextCursor
    ? `/dashboard/runs${buildRunsQueryString({
        status: filters.status,
        definition: filters.definition,
        search: filters.search,
        afterUpdatedAt: nextCursor.afterUpdatedAt,
        afterId: nextCursor.afterId,
      })}`
    : null

  const content = `
    <div class="page-bar">
      <div>
        <h1>Runs</h1>
        <p>Filtered view of workflow runs. Keyset-paginated; no global counts.</p>
      </div>
      <a class="btn btn-outline btn-sm" href="/metrics">Metrics</a>
    </div>
    <form class="filter-bar" method="get" action="/dashboard/runs">
      <input type="hidden" name="status" value="${escapeHtml(filters.status)}" />
      <div class="chip-group">${chips}</div>
      <select class="input" name="definition" onchange="this.form.submit()">${definitionOptions}</select>
      <input
        class="input"
        type="search"
        name="search"
        placeholder="Search id / definition / step"
        value="${escapeHtml(filters.search ?? "")}"
      />
      <button class="btn btn-outline btn-sm" type="submit">Apply</button>
    </form>
    <div class="card">
      <table class="runs-table">
        <thead>
          <tr>
            <th>Definition</th>
            <th>Status</th>
            <th>Current step</th>
            <th>Run id</th>
            <th>Created</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>${tableBody}</tbody>
      </table>
    </div>
    ${
      loadMoreHref
        ? `<div class="load-more-wrap"><a class="btn btn-outline btn-sm" href="${loadMoreHref}">Load more</a></div>`
        : ""
    }
  `

  return renderShellDocument({
    activeNav: "runs",
    content,
    title: "Runs · Hippo",
  })
}

export const renderDefinitionsIndexDocument = (args: {
  workflows: { name: string; title?: string; stepCount: number }[]
}) => {
  const cards = args.workflows
    .map(
      (workflow) => `<article class="card">
      <div class="card-header">
        <h3 class="card-title">${escapeHtml(workflow.title ?? workflow.name)}</h3>
        <p class="card-description">${escapeHtml(workflow.name)} · ${String(workflow.stepCount)} steps</p>
      </div>
      <div class="card-content row">
        <a class="link-action" href="/dashboard/definitions/${encodeURIComponent(workflow.name)}">Open definition →</a>
        <a class="link-action" href="/v1/workflows/${encodeURIComponent(workflow.name)}/render">Source</a>
      </div>
    </article>`
    )
    .join("")

  const content = `
    <div class="page-bar">
      <div>
        <h1>Definitions</h1>
        <p>Workflow definitions registered with this engine.</p>
      </div>
    </div>
    <div class="stat-grid">${
      cards || '<div class="empty">No workflows are registered.</div>'
    }</div>
  `

  return renderShellDocument({
    activeNav: "definitions",
    content,
    title: "Definitions · Hippo",
  })
}

export const renderDefinitionDetailDocument = (args: {
  workflow: { name: string; title?: string }
  mermaid: string
  nodeActions?: Record<
    string,
    { label: string; nodeText?: string; stepKey?: string; href?: string }
  >
  runs: WorkflowRunRecord[]
}) => {
  const tableBody = args.runs.length > 0
    ? args.runs.map(renderRunsTableRow).join("")
    : `<tr><td colspan="6" class="empty">No runs for this definition yet.</td></tr>`

  const content = `
    <div class="page-bar">
      <div>
        <h1>${escapeHtml(args.workflow.title ?? args.workflow.name)}</h1>
        <p>${escapeHtml(args.workflow.name)}</p>
      </div>
      <div class="row">
        <a class="btn btn-outline btn-sm" href="/dashboard/runs?definition=${encodeURIComponent(args.workflow.name)}">All runs</a>
        <a class="btn btn-outline btn-sm" href="/v1/workflows/${encodeURIComponent(args.workflow.name)}/render">Source</a>
      </div>
    </div>
    <article class="card">
      <div class="card-header">
        <h3 class="card-title">Topology</h3>
        <p class="card-description">Click a step to jump to its filtered run list.</p>
      </div>
      <div class="card-content">
        <div class="workflow-diagram">${renderMermaidMount(args.mermaid, args.nodeActions)}</div>
      </div>
    </article>
    <article class="card">
      <div class="card-header">
        <h3 class="card-title">Recent runs</h3>
        <p class="card-description">Latest ${String(args.runs.length)} runs of this definition.</p>
      </div>
      <table class="runs-table">
        <thead>
          <tr>
            <th>Definition</th>
            <th>Status</th>
            <th>Current step</th>
            <th>Run id</th>
            <th>Created</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>${tableBody}</tbody>
      </table>
    </article>
  `

  return renderShellDocument({
    activeNav: "definitions",
    content,
    title: `${args.workflow.title ?? args.workflow.name} · Hippo`,
    includeMermaid: true,
    pageStyles: `
      .workflow-diagram {
        min-height: 240px;
        padding: 0.75rem;
        border: 1px solid hsl(var(--border));
        border-radius: calc(var(--radius) - 2px);
        background: hsl(var(--muted) / 0.4);
        overflow: auto;
      }
      .mermaid { min-width: 480px; }
      .mermaid .clickable { cursor: pointer; }
      .mermaid .clickable rect,
      .mermaid .clickable path,
      .mermaid .clickable polygon { transition: filter 0.15s; }
      .mermaid .clickable:hover rect,
      .mermaid .clickable:hover path,
      .mermaid .clickable:hover polygon { filter: brightness(1.15); }
      .mermaid-fallback {
        white-space: pre-wrap;
        font-family: ui-monospace, "SFMono-Regular", monospace;
        font-size: 0.75rem;
        color: hsl(var(--muted-foreground));
      }
    `,
  })
}

export const renderRunDetailDocument = (args: {
  attempts: string
  events: string
  lastEventId: number
  lineage: string
  run: WorkflowRunRecord | null
  usage: string
  workflowMermaid: string
  workflowStepActions?: Record<
    string,
    { label: string; nodeText?: string; stepKey?: string; href?: string }
  >
}) => {
  const runDetailStyles = `
      .main {
        padding-top: 1.5rem;
        padding-bottom: 4rem;
        display: grid;
        gap: 1.5rem;
      }

      .page-header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .page-title h1 {
        font-size: 1.5rem;
        font-weight: 700;
        letter-spacing: -0.025em;
        line-height: 1.2;
      }
      .page-title p {
        font-size: 0.875rem;
        color: hsl(var(--muted-foreground));
        margin-top: 0.375rem;
      }
      .page-title .meta-id {
        display: inline-block;
        margin-top: 0.5rem;
      }

      .grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
      }

      .summary { display: grid; gap: 0.75rem; }
      .summary-row {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        flex-wrap: wrap;
        font-size: 0.875rem;
      }
      .summary-row > span:first-child { color: hsl(var(--muted-foreground)); }
      .summary-row > span:last-child {
        font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
        font-size: 0.8125rem;
      }

      .section-title {
        font-size: 0.875rem;
        font-weight: 600;
        letter-spacing: -0.01em;
        margin: 0 0 0.75rem;
        color: hsl(var(--foreground));
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
        font-size: 0.8125rem;
        padding: 0.75rem;
        background: hsl(var(--muted) / 0.5);
        border: 1px solid hsl(var(--border));
        border-radius: calc(var(--radius) - 2px);
        color: hsl(var(--foreground));
      }

      .card-list { display: grid; gap: 0.75rem; }
      .lineage-grid {
        display: grid;
        gap: 0.75rem;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }

      .entry {
        padding: 1rem;
        border: 1px solid hsl(var(--border));
        border-radius: calc(var(--radius) - 2px);
        background: hsl(var(--card));
        transition: border-color 120ms ease, box-shadow 120ms ease;
      }
      .entry-selected {
        border-color: hsl(var(--ring));
        box-shadow: 0 0 0 1px hsl(var(--ring));
      }
      .entry strong {
        display: block;
        margin-bottom: 0.375rem;
        font-size: 0.875rem;
        font-weight: 600;
      }
      .entry time {
        display: block;
        margin-bottom: 0.5rem;
        font-size: 0.75rem;
        color: hsl(var(--muted-foreground));
        font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
      }
      .entry pre { font-size: 0.75rem; }

      .diagram-shell {
        min-height: 260px;
        padding: 0.75rem;
        border: 1px solid hsl(var(--border));
        border-radius: calc(var(--radius) - 2px);
        background: hsl(var(--muted) / 0.4);
        overflow: auto;
      }

      .mermaid { min-width: 560px; }
      .mermaid .clickable { cursor: pointer; }
      .mermaid .clickable:focus { outline: none; }
      .mermaid .clickable rect,
      .mermaid .clickable path,
      .mermaid .clickable polygon { transition: filter 0.15s; }
      .mermaid .clickable:hover rect,
      .mermaid .clickable:hover path,
      .mermaid .clickable:hover polygon,
      .mermaid .clickable:focus-visible rect,
      .mermaid .clickable:focus-visible path,
      .mermaid .clickable:focus-visible polygon { filter: brightness(1.15); }
      .mermaid-fallback {
        white-space: pre-wrap;
        font-family: ui-monospace, "SFMono-Regular", monospace;
        font-size: 0.75rem;
        color: hsl(var(--muted-foreground));
      }

      .back-link {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.875rem;
        font-weight: 500;
        color: hsl(var(--muted-foreground));
      }
      .back-link:hover { color: hsl(var(--foreground)); }

      @media (max-width: 900px) {
        .grid { grid-template-columns: 1fr; }
        .mermaid { min-width: 360px; }
      }
      
      .entry-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.25rem;
      }
      .entry-actions {
        display: flex;
        gap: 0.375rem;
      }
      .btn-xs {
        height: 1.5rem;
        padding: 0 0.5rem;
        font-size: 0.75rem;
        border-radius: 0.25rem;
        line-height: 1.25rem;
      }`

  const content = `
    <div class="page-bar">
      <div>
        <h1>${escapeHtml(args.run?.definitionName ?? "Run")}</h1>
        <p>Live event tail powered by <code>GET /v1/runs/:runId/stream</code>.</p>
        <div class="meta meta-id">${escapeHtml(args.run?.id ?? "")}</div>
      </div>
      <span class="badge ${
        args.run?.status && args.run.status in statusToneByRun
          ? statusToneByRun[args.run.status as keyof typeof statusToneByRun]
          : "tone-canceled"
      }">${escapeHtml(args.run?.status ?? "missing")}</span>
    </div>
    <section class="grid">
      <article class="card">
        <div class="card-header">
          <h3 class="card-title">Run detail</h3>
          <p class="card-description">Status, context, and topology for this run.</p>
        </div>
        <div class="card-content">
          <div class="summary">
            <div class="summary-row"><span>Status</span><span>${escapeHtml(args.run?.status ?? "missing")}</span></div>
            <div class="summary-row"><span>Current step</span><span>${escapeHtml(args.run?.currentStepKey ?? "—")}</span></div>
            <div class="summary-row"><span>Created</span><span>${escapeHtml(formatDateTime(args.run?.createdAt ?? null))}</span></div>
            <div class="summary-row"><span>Updated</span><span>${escapeHtml(formatDateTime(args.run?.updatedAt ?? null))}</span></div>
            <div class="summary-row"><span>Completed</span><span>${escapeHtml(formatDateTime(args.run?.completedAt ?? null))}</span></div>
          </div>
          <h4 class="section-title" style="margin-top: 1.5rem;">Context</h4>
          <pre class="pre-json">${formatJson(args.run?.context ?? {})}</pre>
          <h4 class="section-title" style="margin-top: 1.5rem;">Workflow map</h4>
          <div class="diagram-shell">${renderMermaidMount(args.workflowMermaid, args.workflowStepActions)}</div>
        </div>
      </article>
      <article class="card">
        <div class="card-header">
          <h3 class="card-title">Attempts</h3>
          <p class="card-description">Per-step execution history.</p>
        </div>
        <div class="card-content card-list">${args.attempts}</div>
      </article>
    </section>
    <article class="card">
      <div class="card-header">
        <h3 class="card-title">Usage</h3>
        <p class="card-description">Metered resources recorded by this run.</p>
      </div>
      <div class="card-content card-list">${args.usage}</div>
    </article>
    <article class="card">
      <div class="card-header">
        <h3 class="card-title">Lineage</h3>
        <p class="card-description">Parent, continue-as-new, and rewind/fork relationships for this run.</p>
      </div>
      <div class="card-content lineage-grid">${args.lineage}</div>
    </article>
    <article class="card">
      <div class="card-header">
        <h3 class="card-title">Live events</h3>
        <p class="card-description">New events stream in via SSE.</p>
      </div>
      <div class="card-content">
        <div id="event-list" class="card-list">${args.events}</div>
      </div>
    </article>
    <script>
      (() => {
        const eventList = document.getElementById("event-list")
        const source = new EventSource("/v1/runs/${args.run?.id ?? ""}/stream?afterEventId=${String(args.lastEventId)}")
        source.onmessage = (event) => {
          const payload = JSON.parse(event.data)
          const item = document.createElement("article")
          item.className = "entry"
          const title = document.createElement("strong")
          title.textContent = payload.eventType
          const time = document.createElement("time")
          time.textContent = payload.createdAt
          const pre = document.createElement("pre")
          pre.className = "pre-json"
          pre.textContent = JSON.stringify(payload.payload, null, 2)
          item.appendChild(title)
          item.appendChild(time)
          item.appendChild(pre)
          eventList?.appendChild(item)
          if (typeof window.hippoHighlightAllJson === "function") {
            window.hippoHighlightAllJson(item)
          }
        }
        source.onerror = () => { source.close() }
      })()

      async function triggerBranch(runId, attemptId, mode) {
        if (!confirm("Are you sure you want to " + mode + " from this attempt?")) {
          return
        }
        const url = "/v1/operators/runs/" + runId + "/" + mode
        const body = mode === "rewind" ? { toAttemptId: attemptId } : { fromAttemptId: attemptId }
        
        async function sendRequest(token) {
          const headers = { "Content-Type": "application/json" }
          if (token) {
            headers["Authorization"] = "Bearer " + token
          }
          return fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
        }

        let token = localStorage.getItem("hippo_api_token")
        let res = await sendRequest(token)

        if (res.status === 401) {
          const inputToken = prompt("Enter your Hippo API Token:")
          if (inputToken !== null) {
            localStorage.setItem("hippo_api_token", inputToken)
            res = await sendRequest(inputToken)
          } else {
            return
          }
        }

        if (res.ok) {
          const data = await res.json()
          alert("Successfully initiated " + mode + "! Redirecting to new run...")
          window.location.href = "/dashboard/runs/" + data.runId
        } else {
          const errText = await res.text()
          alert("Failed to " + mode + ": " + errText)
        }
      }
    </script>
  `

  return renderShellDocument({
    activeNav: "runs",
    content,
    title: `Run ${args.run?.id ?? ""} · Hippo`,
    includeMermaid: true,
    pageStyles: runDetailStyles,
  })
}

export const renderAttemptCard = (
  attempt: Pick<
    WorkflowStepAttemptRecord,
    | "id"
    | "kind"
    | "attempt"
    | "completedAt"
    | "error"
    | "output"
    | "startedAt"
    | "status"
    | "stepKey"
  >,
  runId: string,
  isSourceRunSuperseded: boolean,
  index = 0
) => {
  const showActions = (attempt.kind === "forward" || attempt.kind === undefined) && !isSourceRunSuperseded

  return `<article class="entry" data-step-key="${escapeHtml(attempt.stepKey)}" data-step-attempt-index="${String(index)}">
  <div class="entry-header">
    <strong>${escapeHtml(attempt.stepKey)} · ${escapeHtml(attempt.kind === "compensate" ? "compensate" : "attempt")} ${String(attempt.attempt)}</strong>
    ${showActions ? `
      <div class="entry-actions">
        <button class="btn btn-outline btn-xs" onclick="triggerBranch('${runId}', '${attempt.id}', 'rewind')">Rewind</button>
        <button class="btn btn-outline btn-xs" onclick="triggerBranch('${runId}', '${attempt.id}', 'fork')">Fork</button>
      </div>
    ` : ""}
  </div>
  <time>${escapeHtml(formatDateTime(attempt.startedAt))} → ${escapeHtml(formatDateTime(attempt.completedAt))}</time>
  <pre class="pre-json">${formatJson({
    kind: attempt.kind ?? "forward",
    status: attempt.status,
    output: attempt.output,
    error: attempt.error,
  })}</pre>
</article>`
}

export const renderEventCard = (
  event: Pick<WorkflowEventRecord, "createdAt" | "eventType" | "payload">
) => `<article class="entry">
  <strong>${escapeHtml(event.eventType)}</strong>
  <time>${escapeHtml(formatDateTime(event.createdAt))}</time>
  <pre class="pre-json">${formatJson(event.payload)}</pre>
</article>`

export const renderUsageCard = (
  usage: Pick<
    WorkflowUsageRecord,
    | "amount"
    | "costUsd"
    | "dimension"
    | "recordedAt"
    | "resource"
    | "stepAttemptId"
  >
) => `<article class="entry">
  <strong>${escapeHtml(usage.resource)} · ${escapeHtml(String(usage.amount))}</strong>
  <time>${escapeHtml(formatDateTime(usage.recordedAt))}</time>
  <pre class="pre-json">${formatJson({
    resource: usage.resource,
    amount: usage.amount,
    costUsd: usage.costUsd,
    dimension: usage.dimension,
    stepAttemptId: usage.stepAttemptId,
  })}</pre>
</article>`

export const renderLineageRunCard = (
  run: Pick<
    WorkflowRunRecord,
    | "id"
    | "definitionName"
    | "status"
    | "currentStepKey"
    | "createdAt"
    | "parentRunId"
    | "continuedFromRunId"
    | "branchedFromRunId"
    | "supersededByRunId"
  >
) => `<article class="entry">
  <strong><a class="run-title" href="${dashboardRunPath(run.id)}">${escapeHtml(run.definitionName)}</a></strong>
  <time>${escapeHtml(formatDateTime(run.createdAt))}</time>
  <pre class="pre-json">${formatJson({
    id: run.id,
    status: run.status,
    currentStepKey: run.currentStepKey,
    parentRunId: run.parentRunId,
    continuedFromRunId: run.continuedFromRunId,
    branchedFromRunId: run.branchedFromRunId,
    supersededByRunId: run.supersededByRunId,
  })}</pre>
</article>`

export const createWorkflowStepActions = (
  workflow: WorkflowDefinition,
  args?: {
    hrefByStepKey?: (stepKey: string) => string
  }
) =>
  Object.fromEntries(
    Object.entries(getWorkflowMermaidNodeIds(workflow)).map(([stepKey, nodeId]) => [
      nodeId,
      {
        ...(args?.hrefByStepKey === undefined
          ? {}
          : { href: args.hrefByStepKey(stepKey) }),
        label: `Inspect ${stepKey}`,
        nodeText: workflow.steps[stepKey]?.label ?? stepKey,
        stepKey,
      },
    ])
  )
