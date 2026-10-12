// Self-hosted inline-SVG icons: 20px grid, 1.5px round stroke, currentColor. No icon font, no CDN.
export const PATHS = Object.freeze({
  connection: "M6 8V4M14 8V4M4 8h12v3a6 6 0 0 1-12 0zM10 17v-2",
  database: "M4 5c0-1.1 2.7-2 6-2s6 .9 6 2-2.7 2-6 2-6-.9-6-2zM4 5v10c0 1.1 2.7 2 6 2s6-.9 6-2V5M4 10c0 1.1 2.7 2 6 2s6-.9 6-2",
  table: "M3 4h14v12H3zM3 8h14M8 8v8",
  key: "M12.5 3.5a4 4 0 1 1-3.2 6.4L3.5 15.7V17H6v-1.5h1.5V14l1.8-1.8M13.5 6.5h.01",
  link: "M8.5 11.5l3-3M7 9.5L5.5 11a2.5 2.5 0 0 0 3.5 3.5l1.5-1.5M13 10.5l1.5-1.5A2.5 2.5 0 0 0 11 5.5L9.5 7",
  filter: "M3 4h14l-5.5 6.5V16l-3-1.5v-4z",
  color: "M10 3s5 5.2 5 8.5a5 5 0 0 1-10 0C5 8.2 10 3 10 3z",
  size: "M4 10a6 6 0 1 0 12 0 6 6 0 1 0-12 0M7.5 10a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0",
  label: "M4.5 16L9.5 4h1l5 12M6.3 12h7.4",
  tooltip: "M4 4h12v9H9l-3 3v-3H4z",
  detail: "M4 6h12M4 10h12M4 14h8",
  shape: "M3 8a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M12 5.5h5v5h-5zM7.5 17l3-5 3 5z",
  path: "M3 15c3 0 3-10 7-10s4 10 7 10",
  angle: "M4 16h12M4 16l9-10M8.5 16a4.5 4.5 0 0 0-1.4-3.3",
  drill: "M5 4v6a3 3 0 0 0 3 3h7M12 10l3 3-3 3",
  pages: "M6 3h8v14H6zM3 5v10M17 5v10",
  sort: "M6 4v12M3 13l3 3 3-3M14 16V4M11 7l3-3 3 3",
  format: "M4 6h8M15 6h1M4 14h2M9 14h7M12 4v4M7 12v4",
  export: "M10 3v9M6 8.5l4 4 4-4M4 15v2h12v-2",
  import: "M10 13V4M6 7.5l4-4 4 4M4 15v2h12v-2",
  more: "M5 10h.01M10 10h.01M15 10h.01",
  search: "M9 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM16 16l-3.5-3.5",
  close: "M5 5l10 10M15 5L5 15",
  chevron: "M7 8l3 3 3-3",
  check: "M4 10.5l4 4 8-9",
  warning: "M10 3l8 14H2zM10 8v4M10 14.5h.01",
  error: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM7.5 7.5l5 5M12.5 7.5l-5 5",
  info: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 9v5M10 6.5h.01",
  refresh: "M16 10a6 6 0 1 1-1.8-4.3M16 4v3.5h-3.5",
  edit: "M4 16l1-4 8-8 3 3-8 8zM11.5 5.5l3 3",
  power: "M10 3v6M6.2 5.4a5.2 5.2 0 1 0 7.6 0",
  plus: "M10 4v12M4 10h12",
  dot: "M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  "type-number": "M7.5 4L6 16M14 4l-1.5 12M4 8h13M3.5 12h13",
  "type-text": "M5 5h10M10 5v11",
  "type-date": "M4 5h12v11H4zM4 8.5h12M7 3v3M13 3v3",
  "type-bool": "M3 10a4 4 0 0 1 4-4h6a4 4 0 0 1 0 8H7a4 4 0 0 1-4-4zM13 10h.01",
  "type-other": "M5 10h10",
});
export const ICON_NAMES = Object.freeze(Object.keys(PATHS));
const NS = "http://www.w3.org/2000/svg";
export function icon(name, { size = 16, label } = {}) {
  const d = PATHS[name];
  if (!d) throw new Error(`Unknown icon: ${name}`);
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 20 20", width: size, height: size, fill: "none", stroke: "currentColor",
    "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" })) svg.setAttribute(k, String(v));
  svg.classList.add("icon");
  if (label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label); } else svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d);
  svg.append(p);
  return svg;
}
