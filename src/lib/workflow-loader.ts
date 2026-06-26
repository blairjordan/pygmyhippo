import { watch } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { WorkflowDefinition } from "../types/workflow.js"
import type { WorkflowEngine } from "./workflow-engine.js"

type WorkflowWatcher = {
  close: () => void
}

type WorkflowModule = {
  workflows?: unknown
}

const asWorkflowDefinitions = (value: unknown, modulePath: URL) => {
  if (!Array.isArray(value)) {
    throw new Error(
      `Workflow module "${fileURLToPath(modulePath)}" must export a "workflows" array`
    )
  }

  return value as WorkflowDefinition[]
}

export const loadWorkflowDefinitions = async (modulePath: URL) => {
  const nextUrl = new URL(modulePath)
  nextUrl.searchParams.set("t", String(Date.now()))
  const module = (await import(nextUrl.href)) as WorkflowModule

  return asWorkflowDefinitions(module.workflows, modulePath)
}

export const startWorkflowDevReloader = async (args: {
  engine: WorkflowEngine
  debounceMs?: number
  loadDefinitions?: (modulePath: URL) => Promise<WorkflowDefinition[]>
  logger: {
    error: (payload: unknown, message?: string) => void
    info: (payload: unknown, message?: string) => void
  }
  modulePath: URL
  watchImpl?: (
    path: string,
    listener: () => void
  ) => WorkflowWatcher
}) => {
  const workflowDirectory = path.dirname(fileURLToPath(args.modulePath))
  let active = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let reloading = false
  const debounceMs = args.debounceMs ?? 100
  const loadDefinitions = args.loadDefinitions ?? loadWorkflowDefinitions

  const reload = async () => {
    if (!active || reloading) {
      return
    }

    reloading = true

    try {
      const nextDefinitions = await loadDefinitions(args.modulePath)
      const latestDefinitions = args.engine.replaceDefinitions(nextDefinitions)

      args.logger.info(
        {
          workflowCount: latestDefinitions.length,
          workflowNames: latestDefinitions.map((definition) => definition.name),
        },
        "Reloaded workflow definitions"
      )
    } catch (error) {
      args.logger.error(
        {
          error,
          modulePath: fileURLToPath(args.modulePath),
        },
        "Failed to hot-reload workflow definitions"
      )
    } finally {
      reloading = false
    }
  }

  const scheduleReload = () => {
    if (!active) {
      return
    }

    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => {
      timer = null
      void reload()
    }, debounceMs)
  }

  const watcher = (args.watchImpl ?? ((watchPath, listener) => watch(watchPath, listener)))(
    workflowDirectory,
    () => {
    scheduleReload()
    }
  )

  return async () => {
    active = false

    if (timer) {
      clearTimeout(timer)
      timer = null
    }

    watcher.close()
  }
}

export const workflowModulePath = () =>
  pathToFileURL(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      `../workflows/index${path.extname(fileURLToPath(import.meta.url))}`
    )
  )
