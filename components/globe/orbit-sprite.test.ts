// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createOrbitParticleSprite } from "./orbit-sprite"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("createOrbitParticleSprite", () => {
  it("returns an 80px canvas and paints two soft radial gradients", () => {
    const gradient = { addColorStop: vi.fn() }
    const ctx = {
      createRadialGradient: vi.fn(() => gradient),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillStyle: "",
    }
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never)
    const canvas = createOrbitParticleSprite()
    expect([canvas.width, canvas.height]).toEqual([80, 80])
    expect(ctx.createRadialGradient).toHaveBeenCalledTimes(2)
    expect(ctx.fill).toHaveBeenCalledTimes(2)
    expect(gradient.addColorStop).toHaveBeenCalledWith(1, "rgba(255,255,255,0)")
  })

  it("returns the blank canvas when 2D context is unavailable", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
    const canvas = createOrbitParticleSprite()
    expect(canvas.width).toBe(80)
  })
})
