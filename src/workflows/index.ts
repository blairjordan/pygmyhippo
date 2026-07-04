import {
  agentDevPipelineWorkflow,
  agentSpecialistWorkflow,
  demoWorkflow,
  demoChildWorkflow,
  demoParentWorkflow,
} from "./demo.js"

export const workflows = [
  demoWorkflow,
  demoChildWorkflow,
  demoParentWorkflow,
  agentSpecialistWorkflow,
  agentDevPipelineWorkflow,
]
