// One colour per account, the same on every chart: the order is the sorted ids, not the series a
// chart happens to show. Past the palette an id gets grey; a cycled colour would make two accounts
// look the same.
export const OTHER = "#8b8b93";

export function colorMap(ids: readonly string[], palette: readonly string[]): Record<string, string> {
  const sorted = [...new Set(ids)].sort();
  return Object.fromEntries(sorted.map((id, i) => [id, palette[i] ?? OTHER]));
}

// The categorical palette checked for colour-blind readers (the dataviz reference order). Dark mode
// has its own steps for the dark surface.
export const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] as const;
export const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] as const;
