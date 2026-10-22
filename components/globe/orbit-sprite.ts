// Soft white radial sprite used for the orbit particle heads (tinted per-billboard via `color`).

const SPRITE_SIZE_PX = 80

export function createOrbitParticleSprite(): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = SPRITE_SIZE_PX
  canvas.height = SPRITE_SIZE_PX
  const ctx = canvas.getContext("2d")
  if (!ctx) return canvas

  const center = canvas.width / 2
  const gradOuter = ctx.createRadialGradient(center, center, 0, center, center, center)
  gradOuter.addColorStop(0, "rgba(255,255,255,1)")
  gradOuter.addColorStop(0.22, "rgba(255,255,255,0.95)")
  gradOuter.addColorStop(0.52, "rgba(255,255,255,0.42)")
  gradOuter.addColorStop(1, "rgba(255,255,255,0)")

  ctx.fillStyle = gradOuter
  ctx.beginPath()
  ctx.arc(center, center, center, 0, Math.PI * 2)
  ctx.fill()

  const gradCore = ctx.createRadialGradient(center, center, 0, center, center, center * 0.34)
  gradCore.addColorStop(0, "rgba(255,255,255,1)")
  gradCore.addColorStop(1, "rgba(255,255,255,0)")

  ctx.fillStyle = gradCore
  ctx.beginPath()
  ctx.arc(center, center, center * 0.36, 0, Math.PI * 2)
  ctx.fill()

  return canvas
}
