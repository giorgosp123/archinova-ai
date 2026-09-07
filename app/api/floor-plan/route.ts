import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type AnyRecord = Record<string, any>;
type Point = [number, number];
type Segment = { a: Point; b: Point; confidence?: number; kind?: string };
type Opening = { a: Point; b: Point; confidence?: number; kind?: string };
type Area = { polygon: Point[]; reason?: string };
type Zone = { polygon: Point[]; label?: string; kind?: string; confidence?: number; evidence?: string };
type Stair = { polygon: Point[]; confidence?: number };
type Geometry = {
  footprint: Point[];
  exteriorZones?: Zone[];
  parkingZones?: Zone[];
  roomZones?: Zone[];
  confirmedInteriorWalls?: Segment[];
  probableInteriorWalls?: Segment[];
  openings?: Opening[];
  stairs?: Stair[];
  unknownAreas?: Area[];
  confidence?: number;
  summary?: string;
};

function textFromValue(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return item.text || item.content || item.value || "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") return value.text || value.content || value.value || "";
  return "";
}

function extractAssistantText(data: AnyRecord) {
  const message = data?.choices?.[0]?.message;
  const candidates = [
    message?.content,
    message?.text,
    message?.response,
    data?.choices?.[0]?.text,
    data?.result?.response,
    data?.result?.text,
    data?.response,
    typeof data?.result === "string" ? data.result : "",
  ];
  for (const candidate of candidates) {
    const text = textFromValue(candidate).trim();
    if (text) return text;
  }
  return "";
}

function cloudflareErrorMessage(data: AnyRecord) {
  return data?.errors?.[0]?.message || data?.error?.message || data?.error || "The floor plan geometry could not be created.";
}

function parseJsonObject(text: string): AnyRecord | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    return null;
  }
}

function point(value: any): Point | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.max(0, Math.min(100, x)), Math.max(0, Math.min(100, y))];
}

function points(value: any): Point[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = point(item);
    return parsed ? [parsed] : [];
  });
}

function confidenceValue(value: any) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;
}

function normalizeSegments(value: any): Segment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const a = point(item?.a);
    const b = point(item?.b);
    if (!a || !b) return [];
    return [{
      a,
      b,
      confidence: confidenceValue(item?.confidence),
      kind: typeof item?.kind === "string" ? item.kind : undefined,
    }];
  });
}

function normalizeOpenings(value: any): Opening[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const a = point(item?.a);
    const b = point(item?.b);
    if (!a || !b) return [];
    return [{
      a,
      b,
      kind: typeof item?.kind === "string" ? item.kind.toLowerCase() : "opening",
      confidence: confidenceValue(item?.confidence),
    }];
  });
}

function normalizeZones(value: any): Zone[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const polygon = points(item?.polygon);
    if (polygon.length < 3) return [];
    return [{
      polygon,
      label: typeof item?.label === "string" ? item.label.trim().slice(0, 60) : undefined,
      kind: typeof item?.kind === "string" ? item.kind.trim().toLowerCase().slice(0, 40) : undefined,
      confidence: confidenceValue(item?.confidence),
      evidence: typeof item?.evidence === "string" ? item.evidence.trim().slice(0, 120) : undefined,
    }];
  });
}

function normalizeAreas(value: any): Area[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const polygon = points(item?.polygon);
    if (polygon.length < 3) return [];
    return [{ polygon, reason: typeof item?.reason === "string" ? item.reason.trim().slice(0, 120) : undefined }];
  });
}

function normalizeStairs(value: any): Stair[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const polygon = points(item?.polygon);
    if (polygon.length < 3) return [];
    return [{ polygon, confidence: confidenceValue(item?.confidence) }];
  });
}

function normalizeShell(raw: AnyRecord): Geometry | null {
  const footprint = points(raw?.footprint);
  if (footprint.length < 3) return null;
  return {
    footprint,
    exteriorZones: normalizeZones(raw?.exteriorZones),
    parkingZones: normalizeZones(raw?.parkingZones),
    openings: normalizeOpenings(raw?.openings),
    stairs: normalizeStairs(raw?.stairs),
    unknownAreas: normalizeAreas(raw?.unknownAreas),
    confidence: confidenceValue(raw?.confidence),
    summary: typeof raw?.summary === "string" ? raw.summary.trim().slice(0, 700) : undefined,
  };
}

function normalizeInterior(raw: AnyRecord) {
  return {
    confirmedInteriorWalls: normalizeSegments(raw?.confirmedInteriorWalls),
    probableInteriorWalls: normalizeSegments(raw?.probableInteriorWalls),
    roomZones: normalizeZones(raw?.roomZones),
    unknownAreas: normalizeAreas(raw?.unknownAreas),
    confidence: confidenceValue(raw?.confidence),
    summary: typeof raw?.summary === "string" ? raw.summary.trim().slice(0, 700) : undefined,
  };
}

async function requestGeometry(endpoint: string, apiToken: string, prompt: string, maxTokens: number) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "@cf/google/gemma-4-26b-a4b-it",
      messages: [
        {
          role: "system",
          content:
            "You are an architectural reconstruction engine. Return only the requested JSON. Never expose chain-of-thought. Treat the supplied shell geometry as fixed when asked to infer interiors.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  let data: AnyRecord = {};
  try {
    data = await response.json();
  } catch {
    return { ok: false, status: response.status || 502, error: "Unreadable geometry response.", text: "", data: {} };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: String(cloudflareErrorMessage(data)), text: "", data };
  }
  return { ok: true, status: response.status, error: "", text: extractAssistantText(data), data };
}

function esc(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function svgDataUri(svg: string) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function centroid(polygon: Point[]): Point {
  const total = polygon.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as Point, [0, 0] as Point);
  return [total[0] / polygon.length, total[1] / polygon.length];
}

function renderPlanSvg(geometry: Geometry, style: string, knownDimension: string, floor: string) {
  const width = 1200;
  const height = 900;
  const margin = 85;
  const footer = 90;

  const allPoints: Point[] = [
    ...geometry.footprint,
    ...(geometry.exteriorZones || []).flatMap((z) => z.polygon),
    ...(geometry.parkingZones || []).flatMap((z) => z.polygon),
    ...(geometry.roomZones || []).flatMap((z) => z.polygon),
    ...(geometry.unknownAreas || []).flatMap((z) => z.polygon),
    ...(geometry.stairs || []).flatMap((z) => z.polygon),
  ];

  const xs = allPoints.map((p) => p[0]);
  const ys = allPoints.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2 - footer) / spanY);
  const drawW = spanX * scale;
  const drawH = spanY * scale;
  const offsetX = (width - drawW) / 2;
  const offsetY = margin + ((height - margin * 2 - footer) - drawH) / 2;

  const map = (p: Point): Point => [offsetX + (p[0] - minX) * scale, offsetY + (p[1] - minY) * scale];
  const poly = (ps: Point[]) => ps.map((p) => map(p).map((n) => n.toFixed(1)).join(",")).join(" ");
  const line = (s: Segment | Opening, attrs: string) => {
    const a = map(s.a);
    const b = map(s.b);
    return `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" ${attrs}/>`;
  };
  const zoneLabel = (zone: Zone, fontSize = 17) => {
    if (!zone.label) return "";
    const c = map(centroid(zone.polygon));
    return `<text x="${c[0].toFixed(1)}" y="${c[1].toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" fill="#3a3a3a" font-weight="700">${esc(zone.label.toUpperCase())}</text>`;
  };

  const exteriorZones = (geometry.exteriorZones || []).map((zone) => {
    const kind = zone.kind || "outdoor";
    const dashed = kind.includes("terrace") || kind.includes("outdoor") || kind.includes("patio") ? "stroke-dasharray=\"8 6\"" : "";
    return `<polygon points="${poly(zone.polygon)}" fill="#f7f7f4" stroke="#8d8d87" stroke-width="3" ${dashed}/>${zoneLabel(zone, 15)}`;
  }).join("");

  const parkingZones = (geometry.parkingZones || []).map((zone) => {
    return `<polygon points="${poly(zone.polygon)}" fill="url(#parkingHatch)" stroke="#656565" stroke-width="3"/>${zoneLabel(zone, 15)}`;
  }).join("");

  const unknown = (geometry.unknownAreas || [])
    .map((area) => `<polygon points="${poly(area.polygon)}" fill="url(#hatch)" stroke="#9a9a9a" stroke-width="2" stroke-dasharray="9 7"/>`)
    .join("");

  const footprintFill = `<polygon points="${poly(geometry.footprint)}" fill="#ffffff" stroke="none"/>`;
  const roomZones = (geometry.roomZones || []).map((zone) => {
    const c = confidenceValue(zone.confidence) ?? 0.5;
    const dash = c < 0.65 ? "stroke-dasharray=\"7 6\"" : "";
    return `<polygon points="${poly(zone.polygon)}" fill="#fbfbfb" stroke="#d2d2d2" stroke-width="1.5" ${dash}/>${zoneLabel(zone, 17)}`;
  }).join("");

  const confirmedWalls = (geometry.confirmedInteriorWalls || [])
    .map((s) => line(s, `stroke="#171717" stroke-width="7" stroke-linecap="square"`))
    .join("");
  const probableWalls = (geometry.probableInteriorWalls || [])
    .map((s) => line(s, `stroke="#777777" stroke-width="4.5" stroke-dasharray="9 7" stroke-linecap="square"`))
    .join("");

  const exterior = `<polygon points="${poly(geometry.footprint)}" fill="none" stroke="#111111" stroke-width="11" stroke-linejoin="round"/>`;

  const openings = (geometry.openings || []).map((o) => {
    const erase = line(o, `stroke="#ffffff" stroke-width="17" stroke-linecap="butt"`);
    const kind = (o.kind || "opening").toLowerCase();
    if (kind.includes("window") || kind.includes("glaz")) {
      return erase + line(o, `stroke="#59646b" stroke-width="4" stroke-linecap="butt"`);
    }
    if (kind.includes("door")) {
      const a = map(o.a);
      const b = map(o.b);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const leafX = a[0] + dx * 0.72 - dy * 0.28;
      const leafY = a[1] + dy * 0.72 + dx * 0.28;
      return `${erase}<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${leafX.toFixed(1)}" y2="${leafY.toFixed(1)}" stroke="#333" stroke-width="3"/>`;
    }
    return erase + line(o, `stroke="#8a8a8a" stroke-width="2" stroke-dasharray="5 5"`);
  }).join("");

  const stairs = (geometry.stairs || []).map((item) => {
    const pts = item.polygon.map(map);
    const xs2 = pts.map((p) => p[0]);
    const ys2 = pts.map((p) => p[1]);
    const x = Math.min(...xs2);
    const y = Math.min(...ys2);
    const w = Math.max(...xs2) - x;
    const h = Math.max(...ys2) - y;
    const steps = 8;
    const stepLines = Array.from({ length: steps - 1 }, (_, i) => {
      if (w >= h) {
        const sx = x + (w / steps) * (i + 1);
        return `<line x1="${sx.toFixed(1)}" y1="${y.toFixed(1)}" x2="${sx.toFixed(1)}" y2="${(y + h).toFixed(1)}" stroke="#555" stroke-width="2"/>`;
      }
      const sy = y + (h / steps) * (i + 1);
      return `<line x1="${x.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${sy.toFixed(1)}" stroke="#555" stroke-width="2"/>`;
    }).join("");
    return `<polygon points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}" fill="#f1f1f1" stroke="#555" stroke-width="3"/>${stepLines}`;
  }).join("");

  const confidence = Math.round((geometry.confidence ?? 0.5) * 100);
  const subtitle = knownDimension ? `Reference scale: ${esc(knownDimension)}` : "No verified scale supplied";
  const styleLabel = style === "Clean presentation" ? "Clean presentation" : "Technical reconstruction";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <pattern id="hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="12" stroke="#dedede" stroke-width="3"/></pattern>
      <pattern id="parkingHatch" width="14" height="14" patternUnits="userSpaceOnUse"><path d="M0 0H14 M0 7H14" stroke="#e1e1de" stroke-width="2"/></pattern>
    </defs>
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${exteriorZones}
    ${parkingZones}
    ${unknown}
    ${footprintFill}
    ${roomZones}
    ${confirmedWalls}
    ${probableWalls}
    ${exterior}
    ${openings}
    ${stairs}
    <line x1="80" y1="${height - 72}" x2="${width - 80}" y2="${height - 72}" stroke="#d7d7d7" stroke-width="2"/>
    <text x="80" y="${height - 38}" font-family="Arial,Helvetica,sans-serif" font-size="21" fill="#111" font-weight="700">${esc(styleLabel)} · ${esc(floor)}</text>
    <text x="${width - 80}" y="${height - 38}" text-anchor="end" font-family="Arial,Helvetica,sans-serif" font-size="18" fill="#666">${esc(subtitle)} · confidence ${confidence}%</text>
  </svg>`;
}

export async function POST(request: Request) {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) return NextResponse.json({ error: "Cloudflare AI is not configured." }, { status: 503 });

    const form = await request.formData();
    const analysesRaw = String(form.get("analyses") || "[]");
    const floor = String(form.get("floor") || "Ground floor");
    const planStyle = String(form.get("planStyle") || "Technical");
    const accuracyMode = String(form.get("accuracyMode") || "strict");
    const knownDimension = String(form.get("knownDimension") || "").trim();
    const notes = String(form.get("notes") || "").trim();

    let analyses: Array<{ view: number; analysis: string }> = [];
    try {
      analyses = JSON.parse(analysesRaw);
    } catch {
      return NextResponse.json({ error: "Invalid analysis data." }, { status: 400 });
    }
    if (!Array.isArray(analyses) || analyses.length === 0) return NextResponse.json({ error: "No analyzed 3D views were supplied." }, { status: 400 });

    const compactAnalyses = analyses.map((item) => ({ view: item.view, analysis: String(item.analysis || "").trim().slice(0, 2600) }));
    const evidence = compactAnalyses.map((item) => `VIEW ${item.view}:\n${item.analysis}`).join("\n\n");
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;

    const shellSchema = `{
  "footprint": [[x,y], ...],
  "exteriorZones": [{"polygon":[[x,y],...],"label":"OUTDOOR DINING|OUTDOOR SITTING|TERRACE|ENTRY|OTHER","kind":"outdoor_dining|outdoor_sitting|terrace|entry_platform|other","confidence":0.0}],
  "parkingZones": [{"polygon":[[x,y],...],"label":"PARKING / CARPORT","kind":"parking|carport","confidence":0.0}],
  "openings": [{"kind":"door|window|sliding_glazing|opening","a":[x,y],"b":[x,y],"confidence":0.0}],
  "stairs": [{"polygon":[[x,y],...],"confidence":0.0}],
  "unknownAreas": [{"polygon":[[x,y],...],"reason":"..."}],
  "confidence": 0.0,
  "summary": "short shell/site summary"
}`;

    const shellPrompt = [
      "PASS 1 OF 2: reconstruct the fixed ground-floor shell and attached outdoor plan geometry from the multi-view evidence.",
      "Return ONLY valid JSON. No markdown.",
      `TARGET FLOOR: ${floor}`,
      knownDimension ? `VERIFIED DIMENSION: ${knownDimension}` : "VERIFIED DIMENSION: none",
      notes ? `ARCHITECT NOTES: ${notes}` : "ARCHITECT NOTES: none",
      "Coordinates are normalized 0-100, x left-to-right, y front-to-back. Put the main/front facade toward the bottom whenever evidence allows.",
      "footprint = ONLY the enclosed built ground-contact boundary, clockwise, without repeating the first point.",
      "Do not simplify stepped/L-shaped footprints into rectangles. Preserve wings, recesses, projections and narrow connectors when multiple views support them.",
      "IMPORTANT: the desired architectural ground-floor plan also includes attached exterior program. Put carports/parking in parkingZones. Put outdoor dining, outdoor sitting, terraces, entrance platforms and similar attached ground-floor spaces in exteriorZones.",
      "Use facade sequences and relative widths from the view analyses to align corners and opening positions across opposite views.",
      "A visible tall stair/core mass may locate stairs even when the stair itself is partly hidden, but lower confidence if inferred.",
      "Do NOT create interior room partitions in this pass.",
      "Schema:",
      shellSchema,
      "EVIDENCE:",
      evidence,
    ].join("\n");

    let shellResponse = await requestGeometry(endpoint, apiToken, shellPrompt, 1800);
    if (!shellResponse.ok) return NextResponse.json({ error: shellResponse.error }, { status: shellResponse.status });
    let shell = normalizeShell(parseJsonObject(shellResponse.text) || {});

    if (!shell) {
      const retry = [
        "Return valid JSON only. Reconstruct the enclosed ground-floor footprint plus visible carport/parking, terraces/outdoor areas, supported openings and stairs.",
        "Keep the actual stepped geometry; do not make a generic rectangle.",
        shellSchema,
        knownDimension ? `Known dimension: ${knownDimension}` : "",
        notes ? `Notes: ${notes}` : "",
        evidence,
      ].filter(Boolean).join("\n");
      shellResponse = await requestGeometry(endpoint, apiToken, retry, 1500);
      if (shellResponse.ok) shell = normalizeShell(parseJsonObject(shellResponse.text) || {});
    }

    if (!shell) {
      return NextResponse.json({ error: "The 3D views did not produce a reliable building shell. Add clearer opposite-side views and try again." }, { status: 422 });
    }

    const interiorSchema = `{
  "confirmedInteriorWalls": [{"a":[x,y],"b":[x,y],"confidence":0.0,"kind":"wall"}],
  "probableInteriorWalls": [{"a":[x,y],"b":[x,y],"confidence":0.0,"kind":"wall"}],
  "roomZones": [{"polygon":[[x,y],...],"label":"LIVING AREA|DINING AREA|KITCHEN|ENTRY LOBBY|WC|UTILITY|OTHER","kind":"living|dining|kitchen|entry|wc|utility|other","confidence":0.0,"evidence":"visible|probable"}],
  "unknownAreas": [{"polygon":[[x,y],...],"reason":"..."}],
  "confidence": 0.0,
  "summary": "short interior summary"
}`;

    const interiorPrompt = [
      "PASS 2 OF 2: infer the ground-floor interior while treating the supplied shell JSON as FIXED geometry. Never alter the footprint, parking, terraces, exterior zones, supported openings or stair polygon.",
      "Return ONLY valid JSON. No markdown.",
      `MODE: ${accuracyMode}`,
      "All coordinates use the same 0-100 system as the shell.",
      "Use direct interior visibility first. Then use consistent architectural cues from all facades.",
      "Weak residential priors may be used ONLY when supported by the shell/evidence: the largest ground-floor glazing often serves living/dining; a kitchen often connects to outdoor dining/service-side openings; the entry usually connects to the stair/core; a small WC/service room may sit near the entry/core; carport access often connects to entry/service circulation.",
      "Do not force these priors if the evidence contradicts them.",
      accuracyMode === "strict"
        ? "STRICT MODE: confirmedInteriorWalls require direct evidence. probableInteriorWalls are allowed only where several independent exterior/core cues agree; keep them dashed by giving confidence below 0.75. Unsupported zones must remain unknown."
        : "INFERRED MODE: complete a practical residential arrangement conservatively, but keep low-confidence partitions marked probable.",
      "roomZones may be probable and should summarize the most likely function, but must stay inside the fixed footprint.",
      "Do not place rooms inside parking or exterior zones.",
      "FIXED SHELL JSON:",
      JSON.stringify(shell),
      "Schema:",
      interiorSchema,
      "ORIGINAL VIEW EVIDENCE:",
      evidence,
      notes ? `ARCHITECT NOTES: ${notes}` : "",
    ].filter(Boolean).join("\n");

    let interiorResponse = await requestGeometry(endpoint, apiToken, interiorPrompt, 1800);
    let interior = interiorResponse.ok ? normalizeInterior(parseJsonObject(interiorResponse.text) || {}) : normalizeInterior({});

    if (interiorResponse.ok && interior.confirmedInteriorWalls.length === 0 && interior.probableInteriorWalls.length === 0 && interior.roomZones.length === 0) {
      const retry = [
        "Return valid JSON only for interior zones and partitions. Keep the shell fixed.",
        accuracyMode === "strict" ? "Use dashed probable walls only when multiple cues agree; unknown elsewhere." : "Infer conservatively.",
        "Fixed shell:",
        JSON.stringify(shell),
        "Schema:",
        interiorSchema,
        evidence,
      ].join("\n");
      interiorResponse = await requestGeometry(endpoint, apiToken, retry, 1400);
      if (interiorResponse.ok) interior = normalizeInterior(parseJsonObject(interiorResponse.text) || {});
    }

    const shellConfidence = shell.confidence ?? 0.55;
    const interiorConfidence = interior.confidence ?? 0.35;
    const geometry: Geometry = {
      ...shell,
      confirmedInteriorWalls: interior.confirmedInteriorWalls,
      probableInteriorWalls: interior.probableInteriorWalls,
      roomZones: interior.roomZones,
      unknownAreas: [...(shell.unknownAreas || []), ...interior.unknownAreas],
      confidence: shellConfidence * 0.7 + interiorConfidence * 0.3,
      summary: [shell.summary, interior.summary].filter(Boolean).join(" ").slice(0, 900),
    };

    const svg = renderPlanSvg(geometry, planStyle, knownDimension, floor);
    const image = svgDataUri(svg);
    const confidencePercent = Math.round((geometry.confidence ?? 0.5) * 100);
    const report = [
      geometry.summary || "Two-pass geometry reconstruction from uploaded 3D views.",
      `${geometry.footprint.length} footprint vertices`,
      `${geometry.exteriorZones?.length || 0} attached outdoor zones`,
      `${geometry.parkingZones?.length || 0} parking/carport zones`,
      `${geometry.roomZones?.length || 0} room/function zones`,
      `${geometry.confirmedInteriorWalls?.length || 0} confirmed walls`,
      `${geometry.probableInteriorWalls?.length || 0} probable walls`,
      `${geometry.openings?.length || 0} supported openings`,
    ].join(" · ");

    return NextResponse.json({
      image,
      report,
      confidence: `${confidencePercent}% geometry confidence`,
      provider: "cloudflare-two-pass-geometry",
      format: "svg",
    });
  } catch (error) {
    console.error("ArchiNova floor plan reconstruction error:", error);
    return NextResponse.json({ error: "Something went wrong while reconstructing the floor plan." }, { status: 500 });
  }
}
