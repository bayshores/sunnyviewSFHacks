import { describe, expect, it } from "vitest"
import { autoOutlineStatus, clipStatusDetail, overlayLines } from "./draw"

describe("overlayLines", () => {
  it("formats panel count, DC kW, scale and orientation", () => {
    expect(overlayLines(12, 400, 0.15, 182.6)).toEqual({
      panels: "Panels: 12",
      dc: "DC: 4.8 kW",
      scale: "Scale: 1.50e-1 m/px",
      orient: "Orient: 183°",
    })
  })

  it("shows a dash when scale is unknown", () => {
    expect(overlayLines(0, 400, null, 0).scale).toBe("Scale: —")
  })
})

describe("autoOutlineStatus", () => {
  it("prioritises busy, then error, then hint", () => {
    expect(autoOutlineStatus(true, "boom", "hint")).toEqual({ title: "Detecting roof…", tone: "info" })
    expect(autoOutlineStatus(false, "boom", "hint")).toEqual({
      title: "Auto-outline failed",
      tone: "error",
      detail: "boom",
    })
    expect(autoOutlineStatus(false, null, "Pick an option")).toEqual({ title: "Pick an option", tone: "hint" })
    expect(autoOutlineStatus(false, null, null)).toBeNull()
  })
})

describe("clipStatusDetail", () => {
  it("clips long messages to 41 chars plus ellipsis", () => {
    expect(clipStatusDetail("x".repeat(44))).toBe("x".repeat(44))
    expect(clipStatusDetail("x".repeat(45))).toBe(`${"x".repeat(41)}…`)
  })
})
