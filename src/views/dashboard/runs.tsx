import { h } from "./jsx-runtime.js"
import type {
  WorkflowEventRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepAttemptRecord,
  WorkflowUsageRecord,
} from "../../types/workflow.js"
import {
  escapeHtml,
  formatDateTime,
  formatJson,
  statusToneByRun,
  renderShellDocument,
} from "./shell.js"
import { renderMermaidMount, renderMermaidBootstrap } from "./mermaid.js"

export const dashboardRunPath = (runId: string) => `/dashboard/runs/${runId}`

export const statusFilterOptions: { label: string; statuses: WorkflowRunStatus[]; id: string }[] = [
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

export const buildRunsQueryString = (params: {
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

export const renderRunsTableRow = (
  run: Pick<
    WorkflowRunRecord,
    "id" | "definitionName" | "status" | "currentStepKey" | "createdAt" | "updatedAt"
  >
) => {
  const href = dashboardRunPath(run.id)
  return (
    <tr data-href={href} tabindex="0">
      <td><a class="run-link" href={href}>{run.definitionName}</a></td>
      <td><span class={`badge ${statusToneByRun[run.status]}`}>{run.status}</span></td>
      <td>{run.currentStepKey ?? "—"}</td>
      <td class="mono">{run.id}</td>
      <td class="mono">{formatDateTime(run.createdAt)}</td>
      <td class="mono">{formatDateTime(run.updatedAt)}</td>
    </tr>
  )
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
    ? runs.map(r => String(renderRunsTableRow(r))).join("")
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

export const renderTraceTimeline = (
  attempts: WorkflowStepAttemptRecord[] | undefined,
  run: WorkflowRunRecord | null,
  lineage: WorkflowRunRecord[] | undefined
): string => {
  if (!attempts || attempts.length === 0 || !run) {
    return `
      <article class="card trace-card">
        <div class="card-header">
          <h3 class="card-title">Trace Timeline</h3>
          <p class="card-description">No timeline data available for this run yet.</p>
        </div>
      </article>
    `
  }

  // Filter child runs of this run
  const childRuns = lineage ? lineage.filter(r => r.parentRunId === run.id) : []

  const timelineStart = run.createdAt.getTime()
  // Determine overall start/end boundary including child runs
  const timelineEnd = run.completedAt
    ? run.completedAt.getTime()
    : Math.max(
        new Date().getTime(),
        ...attempts.map((a) => (a.completedAt || new Date()).getTime()),
        ...childRuns.map((c) => (c.completedAt || new Date()).getTime())
      )

  const totalDuration = Math.max(1, timelineEnd - timelineStart)

  const rowsHtmlList: string[] = []

  for (const attempt of attempts) {
    const startMs = attempt.startedAt.getTime()
    const endMs = (attempt.completedAt || new Date()).getTime()
    const duration = Math.max(0, endMs - startMs)
    
    const startOffset = Math.max(0, Math.min(100, ((startMs - timelineStart) / totalDuration) * 100))
    let width = Math.max(0.5, (duration / totalDuration) * 100)
    if (startOffset + width > 100) {
      width = 100 - startOffset
    }

    let statusClass = "trace-bar-queued"
    if (attempt.status === "completed") {
      statusClass = "trace-bar-completed"
    } else if (attempt.status === "failed") {
      statusClass = "trace-bar-failed"
    } else if (attempt.status === "started") {
      statusClass = "trace-bar-running"
    }

    const durationText = duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(2)}s`
    const startedStr = formatDateTime(attempt.startedAt)
    const endedStr = attempt.completedAt ? formatDateTime(attempt.completedAt) : "Running..."
    const tooltip = escapeHtml(
      `Step: ${attempt.stepKey}\nStatus: ${attempt.status}\nDuration: ${durationText}\nStarted: ${startedStr}\nEnded: ${endedStr}`
    )

    // Find children spawned by this specific step
    const stepChildren = childRuns.filter(c => c.parentStepKey === attempt.stepKey)
    const hasChildren = stepChildren.length > 0

    const toggleHtml = hasChildren
      ? `<button class="trace-toggle-btn" onclick="toggleTraceChildren(this, '${escapeHtml(attempt.stepKey)}')">▼</button>`
      : `<span class="trace-toggle-spacer"></span>`

    // Parent row
    rowsHtmlList.push(`
      <div class="trace-row">
        <div class="trace-label" title="${escapeHtml(attempt.stepKey)}">
          ${toggleHtml}
          ${escapeHtml(attempt.stepKey)} <span style="color: hsl(var(--muted-foreground)); font-size: 0.72rem;">(att ${attempt.attempt})</span>
        </div>
        <div class="trace-track">
          <div class="trace-bar ${statusClass}" 
               style="left: ${startOffset.toFixed(2)}%; width: ${width.toFixed(2)}%;"
               title="${tooltip}">
            <span class="trace-bar-text">${escapeHtml(durationText)}</span>
          </div>
        </div>
      </div>
    `)

    // Render child rows right below the parent row
    for (const child of stepChildren) {
      const cStartMs = child.createdAt.getTime()
      const cEndMs = (child.completedAt || new Date()).getTime()
      const cDuration = Math.max(0, cEndMs - cStartMs)
      
      const cStartOffset = Math.max(0, Math.min(100, ((cStartMs - timelineStart) / totalDuration) * 100))
      let cWidth = Math.max(0.5, (cDuration / totalDuration) * 100)
      if (cStartOffset + cWidth > 100) {
        cWidth = 100 - cStartOffset
      }

      let cStatusClass = "trace-bar-queued"
      if (child.status === "completed") {
        cStatusClass = "trace-bar-completed"
      } else if (child.status === "failed") {
        cStatusClass = "trace-bar-failed"
      } else if (child.status === "running") {
        cStatusClass = "trace-bar-running"
      }

      const cDurationText = cDuration < 1000 ? `${cDuration}ms` : `${(cDuration / 1000).toFixed(2)}s`
      const cStartedStr = formatDateTime(child.createdAt)
      const cEndedStr = child.completedAt ? formatDateTime(child.completedAt) : "Running..."
      const cTooltip = escapeHtml(
        `Child Run: ${child.definitionName}\nStatus: ${child.status}\nDuration: ${cDurationText}\nStarted: ${cStartedStr}\nEnded: ${cEndedStr}`
      )

      rowsHtmlList.push(`
        <div class="trace-row trace-child-row trace-child-of-${escapeHtml(attempt.stepKey)}">
          <div class="trace-label" style="padding-left: 0.5rem;" title="${escapeHtml(child.definitionName)}">
            <span class="trace-tree-branch">├─</span>
            <a class="trace-child-link" href="/dashboard/runs/${child.id}">${escapeHtml(child.definitionName)}</a>
          </div>
          <div class="trace-track">
            <div class="trace-bar ${cStatusClass}" 
                 style="left: ${cStartOffset.toFixed(2)}%; width: ${cWidth.toFixed(2)}%;"
                 title="${cTooltip}">
              <span class="trace-bar-text">${escapeHtml(cDurationText)}</span>
            </div>
          </div>
        </div>
      `)
    }
  }

  const rowsHtml = rowsHtmlList.join("")

  const totalDurationText =
    totalDuration < 1000 ? `${totalDuration}ms` : `${(totalDuration / 1000).toFixed(2)}s`

  return `
    <article class="card trace-card">
      <div class="card-header" style="flex-direction: row; justify-content: space-between; align-items: center; padding-bottom: 0.75rem;">
        <div>
          <h3 class="card-title">Trace Timeline</h3>
          <p class="card-description">Chronological execution flow and step durations.</p>
        </div>
        <div style="font-family: ui-monospace, monospace; font-size: 0.8125rem; font-weight: 600; color: hsl(var(--foreground));">
          Total: ${escapeHtml(totalDurationText)}
        </div>
      </div>
      <div class="card-content" style="padding: 0 1.5rem 1.5rem;">
        <div class="trace-chart">
          ${rowsHtml}
        </div>
        <div class="trace-time-scale">
          <span>0s</span>
          <span>${escapeHtml(totalDurationText)}</span>
        </div>
      </div>
    </article>
  `
}

export const renderRunDetailDocument = (args: {
  attempts: string
  attemptsList?: WorkflowStepAttemptRecord[]
  lineageList?: WorkflowRunRecord[]
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
      }

      /* Trace Timeline Custom Styles */
      .trace-card {
        margin-bottom: 1.5rem;
        width: 100%;
      }
      .trace-chart {
        display: flex;
        flex-direction: column;
        gap: 0.625rem;
        padding: 0.5rem 0;
      }
      .trace-row {
        display: flex;
        align-items: center;
        gap: 1rem;
        font-size: 0.8125rem;
        border-bottom: 1px solid hsl(var(--border) / 0.3);
        padding-bottom: 0.625rem;
      }
      .trace-row:last-child {
        border-bottom: none;
        padding-bottom: 0;
      }
      .trace-label {
        width: 180px;
        flex-shrink: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
        font-weight: 500;
        color: hsl(var(--foreground));
      }
      .trace-track {
        flex-grow: 1;
        height: 1.75rem;
        position: relative;
        background: hsl(var(--muted) / 0.4);
        border-radius: calc(var(--radius) - 2px);
        overflow: hidden;
        border: 1px solid hsl(var(--border) / 0.5);
      }
      .trace-bar {
        position: absolute;
        top: 0.125rem;
        height: 1.5rem;
        border-radius: calc(var(--radius) - 4px);
        display: flex;
        align-items: center;
        padding: 0 0.625rem;
        color: white;
        font-size: 0.72rem;
        font-weight: 600;
        min-width: 48px;
        box-sizing: border-box;
        transition: transform 0.15s ease, filter 0.15s ease;
        cursor: pointer;
      }
      .trace-bar:hover {
        filter: brightness(1.1);
        transform: scaleY(1.05);
      }
      .trace-bar-text {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .trace-bar-completed {
        background: hsl(var(--success));
      }
      .trace-bar-failed {
        background: hsl(var(--destructive));
      }
      .trace-bar-running {
        background: hsl(var(--info));
        animation: trace-pulse 2s infinite ease-in-out;
      }
      .trace-bar-queued {
        background: hsl(var(--muted-foreground));
      }
      @keyframes trace-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.65; }
      }
      .trace-time-scale {
        display: flex;
        justify-content: space-between;
        margin-top: 0.625rem;
        font-size: 0.75rem;
        color: hsl(var(--muted-foreground));
        font-family: ui-monospace, "SFMono-Regular", "Menlo", monospace;
        border-top: 1px dashed hsl(var(--border));
        padding-top: 0.625rem;
      }
      .trace-toggle-btn {
        background: none;
        border: none;
        color: hsl(var(--muted-foreground));
        cursor: pointer;
        padding: 0;
        font-size: 0.65rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.1rem;
        height: 1.1rem;
        border-radius: 2px;
        transition: background 0.1s, color 0.1s;
        margin-right: 0.25rem;
        vertical-align: middle;
      }
      .trace-toggle-btn:hover {
        background: hsl(var(--muted));
        color: hsl(var(--foreground));
      }
      .trace-toggle-spacer {
        display: inline-block;
        width: 1.35rem;
      }
      .trace-tree-branch {
        color: hsl(var(--muted-foreground) / 0.6);
        font-family: ui-monospace, monospace;
        margin-right: 0.25rem;
        margin-left: 0.25rem;
      }
      .trace-child-link {
        color: hsl(var(--primary));
        text-decoration: none;
        font-weight: 500;
      }
      .trace-child-link:hover {
        text-decoration: underline;
      }
      }
      .trace-child-row {
        background: hsl(var(--muted) / 0.08);
        margin-left: 1.25rem;
        border-left: 2px solid hsl(var(--border) / 0.4);
      }
    `

  const statusTone = args.run?.status && args.run.status in statusToneByRun
    ? statusToneByRun[args.run.status as keyof typeof statusToneByRun]
    : "tone-canceled"

  const content = `
    <div class="page-bar">
      <div>
        <h1>${escapeHtml(args.run?.definitionName ?? "Run")}</h1>
        <p>Live event tail powered by <code>GET /v1/runs/:runId/stream</code>.</p>
        <div class="meta meta-id">${escapeHtml(args.run?.id ?? "")}</div>
      </div>
      <span class="badge ${statusTone}">${escapeHtml(args.run?.status ?? "missing")}</span>
    </div>
    ${renderTraceTimeline(args.attemptsList, args.run, args.lineageList)}
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
          
          // Append to event log
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

          // Hot-reload components when important updates happen
          if (
            payload.eventType === "run.completed" ||
            payload.eventType === "run.canceled" ||
            payload.eventType === "step.completed" ||
            payload.eventType === "step.failed" ||
            payload.eventType === "compensation.completed" ||
            payload.eventType === "compensation.failed"
          ) {
            setTimeout(() => { window.location.reload() }, 300)
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

      window.toggleTraceChildren = (btn, stepKey) => {
        const isCollapsed = btn.classList.toggle("collapsed");
        btn.textContent = isCollapsed ? "▶" : "▼";
        document.querySelectorAll(".trace-child-of-" + stepKey).forEach(row => {
          row.style.display = isCollapsed ? "none" : "flex";
        });
      }
    </script>
  `

  return renderShellDocument({
    activeNav: "runs",
    content,
    title: `Run ${args.run?.id ?? ""} · Hippo`,
    includeMermaidBootstrap: renderMermaidBootstrap(),
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

  const actionBlock = showActions ? (
    <div class="entry-actions">
      <button class="btn btn-outline btn-xs" onclick={`triggerBranch('${runId}', '${attempt.id}', 'rewind')`}>Rewind</button>
      <button class="btn btn-outline btn-xs" onclick={`triggerBranch('${runId}', '${attempt.id}', 'fork')`}>Fork</button>
    </div>
  ) : null

  const attemptCardHtml = (
    <article class="entry" data-step-key={attempt.stepKey} data-step-attempt-index={String(index)}>
      <div class="entry-header">
        <strong>{attempt.stepKey} · {attempt.kind === "compensate" ? "compensate" : "attempt"} {String(attempt.attempt)}</strong>
        {actionBlock}
      </div>
      <time>{formatDateTime(attempt.startedAt)} → {formatDateTime(attempt.completedAt)}</time>
      <pre class="pre-json" unsafe-json-content-placeholder-do-not-remove-or-change="true">
        {/* Placeholder for JSON string */}
      </pre>
    </article>
  )

  const jsonStr = formatJson({
    kind: attempt.kind ?? "forward",
    status: attempt.status,
    output: attempt.output,
    error: attempt.error,
  })

  return String(attemptCardHtml).replace('unsafe-json-content-placeholder-do-not-remove-or-change="true">', ">" + jsonStr)
}

export const renderEventCard = (
  event: Pick<WorkflowEventRecord, "createdAt" | "eventType" | "payload">
) => {
  const cardHtml = (
    <article class="entry">
      <strong>{event.eventType}</strong>
      <time>{formatDateTime(event.createdAt)}</time>
      <pre class="pre-json" unsafe-json-content-placeholder-do-not-remove-or-change="true">
        {/* Placeholder */}
      </pre>
    </article>
  )

  const jsonStr = formatJson(event.payload)
  return String(cardHtml).replace('unsafe-json-content-placeholder-do-not-remove-or-change="true">', ">" + jsonStr)
}

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
) => {
  const cardHtml = (
    <article class="entry">
      <strong>{usage.resource} · {String(usage.amount)}</strong>
      <time>{formatDateTime(usage.recordedAt)}</time>
      <pre class="pre-json" unsafe-json-content-placeholder-do-not-remove-or-change="true">
        {/* Placeholder */}
      </pre>
    </article>
  )

  const jsonStr = formatJson({
    resource: usage.resource,
    amount: usage.amount,
    costUsd: usage.costUsd,
    dimension: usage.dimension,
    stepAttemptId: usage.stepAttemptId,
  })

  return String(cardHtml).replace('unsafe-json-content-placeholder-do-not-remove-or-change="true">', ">" + jsonStr)
}

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
) => {
  const cardHtml = (
    <article class="entry">
      <strong><a class="run-title" href={dashboardRunPath(run.id)}>{run.definitionName}</a></strong>
      <time>{formatDateTime(run.createdAt)}</time>
      <pre class="pre-json" unsafe-json-content-placeholder-do-not-remove-or-change="true">
        {/* Placeholder */}
      </pre>
    </article>
  )

  const jsonStr = formatJson({
    id: run.id,
    status: run.status,
    currentStepKey: run.currentStepKey,
    parentRunId: run.parentRunId,
    continuedFromRunId: run.continuedFromRunId,
    branchedFromRunId: run.branchedFromRunId,
    supersededByRunId: run.supersededByRunId,
  })

  return String(cardHtml).replace('unsafe-json-content-placeholder-do-not-remove-or-change="true">', ">" + jsonStr)
}
