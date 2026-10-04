const paths = {
  home:'<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  device:'<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6M9 18h6M12 14v.01"/>',
  activity:'<path d="M3 12h4l2.5-7 5 14 2.5-7H21"/>',
  wrench:'<path d="M14.7 6.3a4 4 0 0 0-5-5L7 4l3 3-6.5 6.5a2.1 2.1 0 0 0 3 3L13 10l3 3 2.7-2.7a4 4 0 0 0-4-4Z"/><path d="m18 16 3 3-2 2-3-3"/>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
  bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  baby:'<circle cx="12" cy="8" r="4"/><path d="M7 20c0-4 2-7 5-7s5 3 5 7"/><path d="M9 6c1-2 5-2 6 0"/>',
  alert:'<path d="M10.3 3.6 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  sparkles:'<path d="m12 3-1 3-3 1 3 1 1 3 1-3 3-1-3-1-1-3Z"/><path d="m19 13-.7 2.3L16 16l2.3.7L19 19l.7-2.3L22 16l-2.3-.7L19 13Z"/><path d="m5 14-.7 2.3L2 17l2.3.7L5 20l.7-2.3L8 17l-2.3-.7L5 14Z"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  play:'<path d="m8 5 11 7-11 7V5Z"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
  'arrow-up':'<path d="m6 15 6-6 6 6"/>',
  'arrow-down':'<path d="m6 9 6 6 6-6"/>',
  'arrow-left':'<path d="m15 18-6-6 6-6"/>',
  'arrow-right':'<path d="m9 18 6-6-6-6"/>',
  square:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  camera:'<path d="M14.5 4 16 6h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l1.5-2h5Z"/><circle cx="12" cy="13" r="4"/>',
  volume:'<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>',
  fan:'<circle cx="12" cy="12" r="2"/><path d="M12 10c-2-5 1-7 4-6 2 1 2 4-1 7M14 12c5-2 7 1 6 4-1 2-4 2-7-1M12 14c2 5-1 7-4 6-2-1-2-4 1-7M10 12c-5 2-7-1-6-4 1-2 4-2 7 1"/>',
  refresh:'<path d="M20 7h-5V2"/><path d="M20 7a9 9 0 1 0 2 8"/>',
  power:'<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  x:'<path d="M6 6l12 12M18 6 6 18"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  doctor:'<path d="M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"/><path d="M4 21a8 8 0 0 1 16 0M18 16v5M15.5 18.5h5"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  thermometer:'<path d="M14 14.8V5a4 4 0 0 0-8 0v9.8a6 6 0 1 0 8 0Z"/><path d="M10 7v9"/>',
  ruler:'<path d="m4 18 14-14 3 3L7 21l-3-3Z"/><path d="m14 8 2 2M11 11l2 2M8 14l2 2"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41"/>',
  wifi:'<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01"/>',
  droplet:'<path d="M12 2s7 7 7 12a7 7 0 0 1-14 0c0-5 7-12 7-12Z"/>',
  trash:'<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
  edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z"/>',
  swap:'<path d="m7 7 4-4 4 4M11 3v14M17 17l-4 4-4-4M13 21V7"/>',
};

export function icon(name, className = "") {
  const body = paths[name] || paths.info;
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(node => {
    const name = node.dataset.icon;
    node.innerHTML = icon(name);
  });
}
