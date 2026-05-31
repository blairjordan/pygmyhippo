import { describe, expect, it } from "vitest"

import { renderWorkflowAsMermaid } from "./workflow-definition.js"
import { demoWorkflow } from "../workflows/demo.js"

describe("workflow rendering", () => {
  it("renders mermaid output", () => {
    const output = renderWorkflowAsMermaid(demoWorkflow)

    expect(output).toContain("flowchart TD")
    expect(output).toContain("classify-recipient")
    expect(output).toContain("delivery-confirmation")
  })
})
