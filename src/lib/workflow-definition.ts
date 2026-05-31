import type {
  EndStepDefinition,
  TaskStepDefinition,
  WaitStepDefinition,
  WorkflowDefinition,
} from "../types/workflow.js"

export const taskStep = (definition: TaskStepDefinition): TaskStepDefinition =>
  definition

export const waitStep = (definition: WaitStepDefinition): WaitStepDefinition =>
  definition

export const endStep = (definition: Omit<EndStepDefinition, "kind"> = {}): EndStepDefinition => ({
  kind: "end",
  ...definition,
})

export const defineWorkflow = (definition: WorkflowDefinition): WorkflowDefinition =>
  definition

const formatLabel = (workflow: WorkflowDefinition, stepKey: string) => {
  const step = workflow.steps[stepKey]
  if (!step) {
    return stepKey
  }

  return step.label ?? `${stepKey}\\n(${step.kind})`
}

const getEdges = (workflow: WorkflowDefinition) =>
  Object.entries(workflow.steps).flatMap(([stepKey, step]) => {
    if (step.kind === "end" || !step.next) {
      return []
    }

    return [{ from: stepKey, to: step.next }]
  })

export const renderWorkflowAsMermaid = (workflow: WorkflowDefinition) => {
  const lines = ["flowchart TD"]

  for (const [stepKey, step] of Object.entries(workflow.steps)) {
    const label = formatLabel(workflow, stepKey)

    if (step.kind === "end") {
      lines.push(`  ${stepKey}(["${label}"])`)
      continue
    }

    if (step.kind === "wait") {
      lines.push(`  ${stepKey}{{"${label}"}}`)
      continue
    }

    lines.push(`  ${stepKey}["${label}"]`)
  }

  for (const edge of getEdges(workflow)) {
    lines.push(`  ${edge.from} --> ${edge.to}`)
  }

  return lines.join("\n")
}
