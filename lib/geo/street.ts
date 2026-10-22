const STREET_ABBREVIATIONS: Record<string, string> = {
  st: "street",
  rd: "road",
  dr: "drive",
  ave: "avenue",
  blvd: "boulevard",
  hwy: "highway",
  pkwy: "parkway",
  ln: "lane",
  ct: "court",
  pl: "place",
  trl: "trail",
  cir: "circle",
}

/** Lowercases, strips non letter/number characters (Unicode-aware) and collapses whitespace. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
}

/** `norm` plus expansion of common US street suffix abbreviations (st -> street, ...). */
export function normStreet(s: string): string {
  const tokens = norm(s).split(" ")
  const expanded = tokens.map((t) =>
    Object.prototype.hasOwnProperty.call(STREET_ABBREVIATIONS, t) ? STREET_ABBREVIATIONS[t] : t
  )
  return expanded.join(" ").trim()
}
