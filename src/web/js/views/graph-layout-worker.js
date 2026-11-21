// views/graph-layout-worker.js — Web Worker ESM pour le calcul du
// layout force-directed (Fruchterman-Reingold simplifié).
//
// Le worker reçoit un message `{gen, nodes, edges, W, H}` et poste
// `{gen, positions}` avec les positions calculées. Le `gen` est un
// compteur monotone qui permet au thread principal de détecter les
// résolutions "périmées" (un nouveau render a commencé pendant que
// celui-ci calculait).
//
// Ce worker est un miroir pur de la fonction `computeForceLayout` du
// main thread : il ne partage AUCUN état (workers ont leur propre
// contexte). La duplication est volontaire : importer graph-svg.js
// dans un worker tirerait tout le DOM, ce qu'on veut éviter.

self.onmessage = (ev) => {
  const { gen, nodes, edges, W, H, positions: warmStart } = ev.data;
  const positions = computeForceLayout(nodes, edges, W, H, warmStart || {});
  self.postMessage({ gen, positions });
};

// Calcule un layout force-directed et renvoie un map {raw: {x, y}}.
// `warmStart` est un map optionnel {raw: {x,y}} : si présent pour un
// nœud, on l'utilise comme seed au lieu du cercle (préserve les positions
// déjà calculées ou déplacées par l'utilisateur entre deux rendus).
function computeForceLayout(nodes, edges, W, H, warmStart) {
  const cx = W / 2, cy = H / 2;
  const N = nodes.length;
  const positions = {};
  if (N === 0) return positions;

  // Seed : positions existantes si dispo, sinon cercle.
  nodes.forEach((n, i) => {
    if (warmStart[n.raw]) {
      positions[n.raw] = { x: warmStart[n.raw].x, y: warmStart[n.raw].y };
    } else {
      const a = (i / N) * Math.PI * 2 - Math.PI / 2;
      const r = Math.min(W, H) / 2 - 60;
      positions[n.raw] = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    }
  });

  const degree = {};
  nodes.forEach(n => degree[n.raw] = n.incoming.length + n.outgoing.length);

  const area = W * H;
  const k = Math.sqrt(area / N) * 0.9;
  const repulsion = k * k * 1.4;
  const springLen = k * 1.1;
  const springK = 0.04;
  const gravity = 0.015;
  const iterations = 320;

  const list = nodes.map(n => n.raw);

  for (let it = 0; it < iterations; it++) {
    const disp = {};
    list.forEach(r => disp[r] = { x: 0, y: 0 });

    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = positions[list[i]], b = positions[list[j]];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        if (dist < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); dist = 1; }
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        disp[list[i]].x += fx; disp[list[i]].y += fy;
        disp[list[j]].x -= fx; disp[list[j]].y -= fy;
      }
    }

    edges.forEach(e => {
      const a = positions[e.from], b = positions[e.to];
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist - springLen) * springK;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      disp[e.from].x += fx; disp[e.from].y += fy;
      disp[e.to].x -= fx; disp[e.to].y -= fy;
    });

    list.forEach(r => {
      const p = positions[r];
      const g = gravity * (1 + Math.min(degree[r], 6) * 0.15);
      disp[r].x += (cx - p.x) * g;
      disp[r].y += (cy - p.y) * g;
    });

    const cooling = 1 - it / iterations;
    const maxStep = k * 0.5 * cooling + 1;
    list.forEach(r => {
      const d = disp[r];
      const len = Math.hypot(d.x, d.y) || 0.01;
      const step = Math.min(len, maxStep);
      positions[r].x += (d.x / len) * step;
      positions[r].y += (d.y / len) * step;
    });
  }

  // Normaliser pour centrer dans la vue (comme l'original).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  list.forEach(r => {
    minX = Math.min(minX, positions[r].x); maxX = Math.max(maxX, positions[r].x);
    minY = Math.min(minY, positions[r].y); maxY = Math.max(maxY, positions[r].y);
  });
  const bw = (maxX - minX) || 1, bh = (maxY - minY) || 1;
  const pad = 70;
  const scale = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 1.4);
  const offX = cx - ((minX + maxX) / 2) * scale;
  const offY = cy - ((minY + maxY) / 2) * scale;
  const normalized = {};
  list.forEach(r => {
    normalized[r] = { x: positions[r].x * scale + offX, y: positions[r].y * scale + offY };
  });
  return normalized;
}
