import type { WorkflowDefinition } from "../../types/workflow.js"

export type DefinitionRegistry = {
  byVersion: Map<string, WorkflowDefinition>
  latestByName: Map<string, WorkflowDefinition>
}

export const getDefinitionVersionKey = (name: string, version: number) =>
  `${name}@${String(version)}`

export const createDefinitionRegistry = (definitions: WorkflowDefinition[]): DefinitionRegistry => {
  const byVersion = new Map<string, WorkflowDefinition>()
  const latestByName = new Map<string, WorkflowDefinition>()

  for (const definition of definitions) {
    const versionKey = getDefinitionVersionKey(definition.name, definition.version)

    if (byVersion.has(versionKey)) {
      throw new Error(
        `Duplicate workflow definition registered for "${definition.name}" version ${String(definition.version)}`
      )
    }

    byVersion.set(versionKey, definition)

    const latest = latestByName.get(definition.name)

    if (!latest || definition.version > latest.version) {
      latestByName.set(definition.name, definition)
    }
  }

  return {
    byVersion,
    latestByName,
  }
}

export const listDefinitions = (registry: DefinitionRegistry) => [...registry.byVersion.values()]

export const replaceDefinitionRegistry = (
  current: DefinitionRegistry,
  nextDefinitions: WorkflowDefinition[]
) => {
  const nextByVersion = new Map(current.byVersion)

  for (const definition of nextDefinitions) {
    const versionKey = getDefinitionVersionKey(definition.name, definition.version)

    if (!nextByVersion.has(versionKey)) {
      nextByVersion.set(versionKey, definition)
    }
  }

  const latestByName = new Map<string, WorkflowDefinition>()

  for (const definition of nextDefinitions) {
    const pinnedDefinition = nextByVersion.get(
      getDefinitionVersionKey(definition.name, definition.version)
    )

    if (!pinnedDefinition) {
      throw new Error(
        `Workflow definition "${definition.name}" version ${String(definition.version)} is not registered`
      )
    }

    const latest = latestByName.get(definition.name)

    if (!latest || pinnedDefinition.version > latest.version) {
      latestByName.set(definition.name, pinnedDefinition)
    }
  }

  return {
    byVersion: nextByVersion,
    latestByName,
  }
}

export const getDefinition = (
  registry: DefinitionRegistry,
  name: string,
  version?: number
) => {
  if (version !== undefined) {
    return registry.byVersion.get(getDefinitionVersionKey(name, version)) ?? null
  }

  return registry.latestByName.get(name) ?? null
}

export const requireDefinition = (
  registry: DefinitionRegistry,
  name: string,
  version?: number
) => {
  const definition = getDefinition(registry, name, version)

  if (!definition) {
    throw new Error(
      version === undefined
        ? `Workflow definition "${name}" is not registered`
        : `Workflow definition "${name}" version ${String(version)} is not registered`
    )
  }

  return definition
}

export const getStep = (definition: WorkflowDefinition, stepKey: string) => {
  const step = definition.steps[stepKey]

  if (!step) {
    throw new Error(
      `Workflow "${definition.name}" is missing step "${stepKey}"`
    )
  }

  return step
}
