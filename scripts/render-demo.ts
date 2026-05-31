import { renderWorkflowAsMermaid } from "../src/lib/workflow-definition.js"
import { demoWorkflow } from "../src/workflows/demo.js"

process.stdout.write(`${renderWorkflowAsMermaid(demoWorkflow)}\n`)
