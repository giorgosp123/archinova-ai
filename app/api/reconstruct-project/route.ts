import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

type AnyRecord = Record<string, any>;
type Point = [number, number];
type Segment = { a: Point; b: Point; confidence?: number; kind?: string };
type Opening = { a: Point; b: Point; confidence?: number; kind?: string };
type PolygonItem = { polygon: Point[]; confidence?: number; kind?: string; label?: string; basis?: string; reason?: string };
type Geometry = {
  footprint: Point[];
  attachedZones?: PolygonItem[];
  confirmedInteriorWalls?: Segment[];
  inferredInteriorWalls?: Segment[];
  openings?: Opening[];
  stairs?: PolygonItem[];
  rooms?: PolygonItem[];
  unknownAreas?: PolygonItem[];
  confidence?: number;
  spaceConfidence?: Record<string, number>;
  summary?: string;
};

function clamp(value: number) {
  return Math.max(0, Math.min(100, value));
}

function point(value: any): Point | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [clamp(x), clamp(y)];
}

function points(value: any): Point[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = point(item);
    return parsed ? [parsed] : [];
  });
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
      confidence: Number.isFinite(Number(item?.confidence)) ? clamp(Number(item.confidence) * 100) / 100 : undefined,
      kind: typeof item?.kind === "string" ? item.kind.toLowerCase() : undefined,
    }];
  });
}

function normalizePolygons(value: any): PolygonItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const polygon = points(item?.polygon);
    if (polygon.length < 3) return [];
    return [{
      polygon,
      confidence: Number.isFinite(Number(item?.confidence)) ? clamp(Number(item.confidence) * 100) / 100 : undefined,
      kind: typeof item?.kind === "string" ? item.kind.toLowerCase() : undefined,
      label: typeof item?.label === "string" ? item.label.slice(0, 80) : undefined,
      basis: typeof item?.basis === "string" ? item.basis.toLowerCase() : undefined,
      reason: typeof item?.reason === "string" ? item.reason.slice(0, 180) : undefined,
    }];
  });
}

function normalizeConfidenceMap(value: any): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const number = Number(raw);
    if (!Number.isFinite(number)) continue;
    result[key.toLowerCase()] = Math.max(0, Math.min(1, number));
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeGeometry(raw: AnyRecord): Geometry | null {
  const footprint = points(raw?.footprint);
  if (footprint.length < 3) return null;

  const openings = Array.isArray(raw?.openings)
    ? raw.openings.flatMap((item: any) => {
        const a = point(item?.a);
        const b = point(item?.b);
        if (!a || !b) return [];
        return [{
          a,
          b,
          kind: typeof item?.kind === "string" ? item.kind.toLowerCase() : "opening",
          confidence: Number.isFinite(Number(item?.confidence)) ? clamp(Number(item.confidence) * 100) / 100 : undefined,
        }];
      })
    : [];

  return {
    footprint,
    attachedZones: normalizePolygons(raw?.attachedZones),
    confirmedInteriorWalls: normalizeSegments(raw?.confirmedInteriorWalls),
    inferredInteriorWalls: normalizeSegments(raw?.inferredInteriorWalls),
    openings,
    stairs: normalizePolygons(raw?.stairs),
    rooms: normalizePolygons(raw?.rooms),
    unknownAreas: normalizePolygons(raw?.unknownAreas),
    confidence: Number.isFinite(Number(raw?.confidence)) ? clamp(Number(raw.confidence) * 100) / 100 : undefined,
    spaceConfidence: normalizeConfidenceMap(raw?.spaceConfidence),
    summary: typeof raw?.summary === "string" ? raw.summary.trim().slice(0, 900) : undefined,
  };
}

function textFromValue(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") return item.text || item.content || item.value || "";
      return "";
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") return value.text || value.content || value.value || "";
  return "";
}

function extractAssistantText(data: AnyRecord) {
  const message = data?.choices?.[0]?.message;
  const candidates = [
    message?.content,
    message?.text,
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

function esc(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function svgDataUri(svg: string) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function centroid(polygon: Point[]): Point {
  const sum = polygon.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]] as Point, [0, 0] as Point);
  return [sum[0] / polygon.length, sum[1] / polygon.length];
}

function flipPointY(p: Point): Point {
  return [p[0], 100 - p[1]];
}

function orientFrontToBottom(geometry: Geometry): Geometry {
  const frontWords = ["parking", "carport", "driveway", "entry_platform", "entry steps", "front entry", "main entry", "entrance"];
  const rearWords = ["rear", "outdoor_dining", "outdoor dining", "outdoor_sitting", "outdoor sitting", "garden terrace"];

  const frontYs: number[] = [];
  const rearYs: number[] = [];
  for (const zone of geometry.attachedZones || []) {
    const text = `${zone.kind || ""} ${zone.label || ""}`.toLowerCase();
    const y = centroid(zone.polygon)[1];
    if (frontWords.some((word) => text.includes(word))) frontYs.push(y);
    if (rearWords.some((word) => text.includes(word))) rearYs.push(y);
  }

  const entryRooms = (geometry.rooms || []).filter((room) => {
    const text = `${room.kind || ""} ${room.label || ""}`.toLowerCase();
    return text.includes("entry") || text.includes("lobby");
  });
  entryRooms.forEach((room) => frontYs.push(centroid(room.polygon)[1]));

  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const shouldFlip =
    frontYs.length > 0 &&
    ((rearYs.length > 0 && avg(frontYs) < avg(rearYs)) || (rearYs.length === 0 && avg(frontYs) < 42));

  if (!shouldFlip) return geometry;

  const flipPolygon = (item: PolygonItem): PolygonItem => ({ ...item, polygon: item.polygon.map(flipPointY) });
  const flipSegment = (item: Segment): Segment => ({ ...item, a: flipPointY(item.a), b: flipPointY(item.b) });
  const flipOpening = (item: Opening): Opening => ({ ...item, a: flipPointY(item.a), b: flipPointY(item.b) });

  return {
    ...geometry,
    footprint: geometry.footprint.map(flipPointY),
    attachedZones: (geometry.attachedZones || []).map(flipPolygon),
    confirmedInteriorWalls: (geometry.confirmedInteriorWalls || []).map(flipSegment),
    inferredInteriorWalls: (geometry.inferredInteriorWalls || []).map(flipSegment),
    openings: (geometry.openings || []).map(flipOpening),
    stairs: (geometry.stairs || []).map(flipPolygon),
    rooms: (geometry.rooms || []).map(flipPolygon),
    unknownAreas: (geometry.unknownAreas || []).map(flipPolygon),
  };
}

function renderPlanSvg(geometry: Geometry, style: string, knownDimension: string, floor: string) {
  const width = 1300;
  const height = 980;
  const margin = 115;
  const footer = 105;
  const footprint = geometry.footprint;
  const allPoints = [
    ...footprint,
    ...(geometry.attachedZones || []).flatMap((z) => z.polygon),
    ...(geometry.unknownAreas || []).flatMap((z) => z.polygon),
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

  const attached = (geometry.attachedZones || []).map((zone) => {
    const c = map(centroid(zone.polygon));
    const label = esc(zone.label || zone.kind || "attached zone").toUpperCase();
    const kind = (zone.kind || "").toLowerCase();
    const fill = kind.includes("parking") || kind.includes("carport") || kind.includes("driveway") ? "#f0f0f0" : "#f7f7f7";
    return `<polygon points="${poly(zone.polygon)}" fill="${fill}" stroke="#777" stroke-width="3" stroke-dasharray="9 6"/>
      <text x="${c[0].toFixed(1)}" y="${c[1].toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="#666" font-weight="700">${label}</text>`;
  }).join("");

  const unknown = (geometry.unknownAreas || []).map((area) =>
    `<polygon points="${poly(area.polygon)}" fill="url(#hatch)" stroke="#8a8a8a" stroke-width="2.5" stroke-dasharray="10 8"/>`
  ).join("");

  const exterior = `<polygon points="${poly(footprint)}" fill="#ffffff" stroke="#101010" stroke-width="12" stroke-linejoin="round"/>`;

  const confirmedWalls = (geometry.confirmedInteriorWalls || []).map((s) =>
    line(s, `stroke="#171717" stroke-width="8" stroke-linecap="square"`)
  ).join("");

  const inferredWalls = (geometry.inferredInteriorWalls || []).map((s) =>
    line(s, `stroke="#555" stroke-width="6" stroke-linecap="square"`)
  ).join("");

  const openings = (geometry.openings || []).map((o) => {
    const erase = line(o, `stroke="#fff" stroke-width="18" stroke-linecap="butt"`);
    const kind = (o.kind || "opening").toLowerCase();
    if (kind.includes("window") || kind.includes("glazing")) {
      return erase + line(o, `stroke="#66727b" stroke-width="4" stroke-linecap="butt"`);
    }
    if (kind.includes("door")) {
      const a = map(o.a);
      const b = map(o.b);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const leafX = a[0] + dx * 0.72 - dy * 0.27;
      const leafY = a[1] + dy * 0.72 + dx * 0.27;
      return `${erase}<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${leafX.toFixed(1)}" y2="${leafY.toFixed(1)}" stroke="#333" stroke-width="3"/>`;
    }
    return erase + line(o, `stroke="#999" stroke-width="3" stroke-dasharray="5 5"`);
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
        return `<line x1="${sx.toFixed(1)}" y1="${y.toFixed(1)}" x2="${sx.toFixed(1)}" y2="${(y + h).toFixed(1)}" stroke="#666" stroke-width="2"/>`;
      }
      const sy = y + (h / steps) * (i + 1);
      return `<line x1="${x.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${sy.toFixed(1)}" stroke="#666" stroke-width="2"/>`;
    }).join("");
    return `<polygon points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}" fill="#f3f3f3" stroke="#555" stroke-width="3"/>${stepLines}`;
  }).join("");

  const roomLabels = (geometry.rooms || []).map((room) => {
    const c = map(centroid(room.polygon));
    const label = esc(room.label || room.kind || "SPACE").toUpperCase();
    const opacity = room.basis === "visible" || room.basis === "fact" ? "1" : "0.78";
    return `<text x="${c[0].toFixed(1)}" y="${c[1].toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#333" font-weight="700" opacity="${opacity}">${label}</text>`;
  }).join("");

  const confidence = Math.round((geometry.confidence ?? 0.5) * 100);
  const subtitle = knownDimension ? `Reference scale: ${esc(knownDimension)}` : "No verified scale supplied";
  const styleLabel = style === "Clean presentation" ? "Clean presentation" : "Technical reconstruction";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <pattern id="hatch" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="12" stroke="#d5d5d5" stroke-width="3"/>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="#fff"/>
    ${attached}
    ${unknown}
    ${exterior}
    ${confirmedWalls}
    ${inferredWalls}
    ${openings}
    ${stairs}
    ${roomLabels}
    <line x1="90" y1="${height - 78}" x2="${width - 90}" y2="${height - 78}" stroke="#d7d7d7" stroke-width="2"/>
    <text x="90" y="${height - 42}" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#111" font-weight="700">${esc(styleLabel)} · ${esc(floor)}</text>
    <text x="${width - 90}" y="${height - 42}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="19" fill="#666">${esc(subtitle)} · confidence ${confidence}%</text>
  </svg>`;
}

async function runJointVision(params: {
  endpoint: string;
  apiToken: string;
  prompt: string;
  dataUrls: string[];
  maxTokens: number;
}) {
  const content: AnyRecord[] = [{ type: "text", text: params.prompt }];
  params.dataUrls.forEach((url, index) => {
    content.push({ type: "text", text: `IMAGE ${index + 1}` });
    content.push({ type: "image_url", image_url: { url } });
  });

  const response = await fetch(params.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "@cf/qwen/qwen3.8-27b",
      messages: [
        {
          role: "system",
          content:
            "You are a senior architect and multi-view reconstruction engine. All supplied images show one project. Cross-match masses, openings, entry, parking and outdoor spaces before answering. Distinguish visible evidence, user-confirmed facts and architectural inference. Return structured geometry only, never chain-of-thought.",
        },
        { role: "user", content },
      ],
      temperature: 0,
      reasoning_effort: "medium",
      max_completion_tokens: params.maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  let data: AnyRecord = {};
  try {
    data = await response.json();
  } catch {
    return { ok: false, status: response.status || 502, error: "Unreadable multi-view response.", text: "", data: {} };
  }

  if (!response.ok) {
    const error = data?.errors?.[0]?.message || data?.error?.message || data?.error || "Multi-view analysis failed.";
    return { ok: false, status: response.status, error: String(error), text: "", data };
  }

  return { ok: true, status: response.status, error: "", text: extractAssistantText(data), data };
}

function verifiedFactsText(facts: Record<string, string>) {
  const entries = Object.entries(facts).filter(([, value]) => value && value !== "unknown");
  if (!entries.length) return "No extra user-confirmed architect facts supplied.";
  return `USER-CONFIRMED ARCHITECT FACTS (treat these as hard constraints unless physically impossible):\n${entries
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}`;
}

export async function POST(request: Request) {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) {
      return NextResponse.json({ error: "Cloudflare AI is not configured." }, { status: 503 });
    }

    const form = await request.formData();
    const floor = String(form.get("floor") || "Ground floor");
    const planStyle = String(form.get("planStyle") || "Technical");
    const accuracyMode = String(form.get("accuracyMode") || "inferred");
    const knownDimension = String(form.get("knownDimension") || "").trim();
    const notes = String(form.get("notes") || "").trim();
    const previousGeometryRaw = String(form.get("previousGeometry") || "").trim();
    const architectFactsRaw = String(form.get("architectFacts") || "{}").trim();
    const batchIndex = Math.max(0, Number(form.get("batchIndex") || 0));
    const batchCount = Math.max(1, Number(form.get("batchCount") || 1));
    const totalViews = Math.max(1, Number(form.get("totalViews") || 1));

    let architectFacts: Record<string, string> = {};
    try {
      const parsed = JSON.parse(architectFactsRaw || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        architectFacts = Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [key, String(value || "unknown").toLowerCase()])
        );
      }
    } catch {
      architectFacts = {};
    }

    const images: File[] = [];
    for (let index = 0; index < 8; index += 1) {
      const file = form.get(`image_${index}`);
      if (!(file instanceof File) || file.size === 0) continue;
      if (!allowedImageTypes.has(file.type)) {
        return NextResponse.json({ error: "Use PNG, JPG or WEBP images." }, { status: 400 });
      }
      if (file.size > 2 * 1024 * 1024) {
        return NextResponse.json({ error: "One prepared image is too large." }, { status: 400 });
      }
      images.push(file);
    }

    if (images.length === 0) {
      return NextResponse.json({ error: "Add at least one 3D view." }, { status: 400 });
    }

    const dataUrls = await Promise.all(images.map(async (file) => {
      const bytes = Buffer.from(await file.arrayBuffer());
      return `data:${file.type};base64,${bytes.toString("base64")}`;
    }));

    let previousGeometry: AnyRecord | null = null;
    if (previousGeometryRaw) {
      try {
        previousGeometry = JSON.parse(previousGeometryRaw);
      } catch {
        previousGeometry = null;
      }
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
    const factsText = verifiedFactsText(architectFacts);
    const previousText = previousGeometry
      ? `CANONICAL GEOMETRY FROM EARLIER IMAGE BATCHES:\n${JSON.stringify(previousGeometry)}\nRefine it only when these new views provide stronger evidence. Keep the same coordinate orientation.`
      : "No previous batch geometry exists. Establish one canonical orientation now.";

    const shellSchema = `{
  "footprint": [[x,y], ...],
  "attachedZones": [{"kind":"parking|carport|driveway|covered_terrace|outdoor_dining|outdoor_sitting|entry_platform|entry_steps|other","label":"...","polygon":[[x,y],...],"confidence":0.0}],
  "openings": [{"kind":"door|sliding_door|window|glazing|opening","a":[x,y],"b":[x,y],"confidence":0.0}],
  "stairs": [{"polygon":[[x,y],...],"confidence":0.0}],
  "confidence": 0.0,
  "summary": "short shell summary"
}`;

    const shellPrompt = [
      `PASS 1 OF 2: reconstruct ONLY the architectural shell/site relationship for ${floor}.`,
      `This is batch ${batchIndex + 1} of ${batchCount}; ${totalViews} total project views exist. Inspect all images in THIS message together as one building.`,
      previousText,
      factsText,
      "Do not infer room names yet. First solve the outside geometry correctly.",
      "Cross-match facades using unique balconies, canopies, blank walls, glazing bands, vertical volumes, parapets, planting boundaries and level changes.",
      "Identify the road/driveway/main-entry side as FRONT. In final coordinates FRONT MUST be toward y=100 (the bottom of the drawing); REAR/GARDEN toward y=0 (top).",
      "Reconstruct the exact stepped ground-contact footprint: recesses, projections, narrow links and wings matter. Never simplify an irregular building to a rectangle.",
      "Separate attached spaces that are not enclosed interior floor area: parking/carport/driveway, covered outdoor dining, outdoor sitting terrace, entry platform/steps and similar zones.",
      "Map visible doors, sliding doors, windows and large glazing onto the correct facade. Openings are hard constraints for the later interior pass.",
      "If a stair/vertical core is actually visible or strongly identified by a user fact, include its approximate polygon. Otherwise omit it here.",
      knownDimension ? `VERIFIED SCALE CLUE: ${knownDimension}. Do not invent any other dimensions.` : "No verified scale clue. Preserve relative proportions only.",
      notes ? `ARCHITECT NOTES: ${notes}` : "No free-text architect notes supplied.",
      "Coordinates must be 0..100, x left-to-right, y rear-to-front. Return JSON only.",
      "SCHEMA:",
      shellSchema,
    ].join("\n");

    let shellResult = await runJointVision({ endpoint, apiToken, prompt: shellPrompt, dataUrls, maxTokens: 1900 });
    if (!shellResult.ok) {
      console.error("Shell pass failed:", shellResult.data);
      return NextResponse.json({ error: shellResult.error }, { status: shellResult.status });
    }

    let shellRaw = parseJsonObject(shellResult.text);
    let shellGeometry = normalizeGeometry(shellRaw || {});
    if (!shellGeometry) {
      const shellRetry = [
        "Return VALID JSON ONLY for the shell. No prose.",
        "Use all supplied images together. Front/driveway/main-entry side must map toward y=100.",
        previousGeometry ? `Refine this existing geometry instead of restarting: ${JSON.stringify(previousGeometry)}` : "Establish the real stepped shell.",
        factsText,
        "Schema:", shellSchema,
      ].join("\n");
      shellResult = await runJointVision({ endpoint, apiToken, prompt: shellRetry, dataUrls, maxTokens: 1600 });
      shellRaw = shellResult.ok ? parseJsonObject(shellResult.text) : null;
      shellGeometry = normalizeGeometry(shellRaw || {});
    }

    if (!shellGeometry || !shellRaw) {
      return NextResponse.json(
        { error: "The AI could not establish a reliable building shell from these views." },
        { status: 422 }
      );
    }

    const interiorSchema = `{
  "confirmedInteriorWalls": [{"a":[x,y],"b":[x,y],"confidence":0.0}],
  "inferredInteriorWalls": [{"a":[x,y],"b":[x,y],"confidence":0.0}],
  "rooms": [{"kind":"kitchen|living|dining|entry_lobby|wc|stair|service|storage|other","label":"Kitchen|Living Area|Dining Area|Entry Lobby|WC|Stair|...","polygon":[[x,y],...],"confidence":0.0,"basis":"visible|fact|inferred"}],
  "unknownAreas": [{"polygon":[[x,y],...],"reason":"..."}],
  "spaceConfidence": {"parking":0.0,"entry":0.0,"stairs":0.0,"kitchen":0.0,"living":0.0,"dining":0.0,"wc":0.0,"outdoor":0.0},
  "confidence": 0.0,
  "summary": "short interior reasoning result"
}`;

    const lockedShell = {
      footprint: shellGeometry.footprint,
      attachedZones: shellGeometry.attachedZones || [],
      openings: shellGeometry.openings || [],
      stairs: shellGeometry.stairs || [],
    };

    const interiorPrompt = [
      `PASS 2 OF 2: reconstruct the interior of ${floor} INSIDE A LOCKED SHELL.`,
      "The shell below is canonical. Do not rotate it, replace it, rectangularize it or move its exterior openings.",
      `LOCKED SHELL: ${JSON.stringify(lockedShell)}`,
      factsText,
      notes ? `ARCHITECT NOTES: ${notes}` : "No free-text architect notes supplied.",
      accuracyMode === "strict"
        ? "EVIDENCE ONLY: add only interior walls/spaces supported by visible interior/cutaway evidence or explicit user-confirmed facts. Put the rest in unknownAreas."
        : "FULL RECONSTRUCTION: infer the most plausible complete ground-floor arrangement from architecture, but do not create a generic plan. Every space must be explained by the actual shell, openings, entry, stair clues, parking and outdoor zones.",
      "ARCHITECTURAL ADJACENCY RULES (soft rules, never stronger than visible evidence or user facts):",
      "- Main entry should lead into entry lobby/circulation, usually near the stair/vertical core when that core is evident.",
      "- Parking/carport should have a plausible pedestrian connection toward entry or a service/kitchen side, not through the middle of living furniture.",
      "- Kitchen should relate logically to dining and, when an outdoor dining terrace exists, should preferably connect or sit adjacent to it.",
      "- Living/dining zones are usually aligned with the largest garden-facing glazing and outdoor sitting terraces.",
      "- A ground-floor WC, if confirmed or strongly inferred, should be compact and accessible from circulation, not placed inside living/dining/kitchen.",
      "- Open-plan facts mean avoid unnecessary partitions between kitchen/living/dining; closed-plan facts mean use real separating walls.",
      "- Stair position is a circulation anchor. Do not move it merely to make rooms look neat.",
      "- Room polygons must stay inside the footprint, avoid impossible overlaps, and align walls with each other where practical.",
      "Use basis=visible for directly seen evidence, basis=fact for user-confirmed facts, basis=inferred for architectural inference.",
      "Return JSON only, coordinates in the SAME 0..100 system as the locked shell.",
      "SCHEMA:",
      interiorSchema,
    ].join("\n");

    let interiorResult = await runJointVision({ endpoint, apiToken, prompt: interiorPrompt, dataUrls, maxTokens: 2300 });
    if (!interiorResult.ok) {
      console.error("Interior pass failed:", interiorResult.data);
      return NextResponse.json({ error: interiorResult.error }, { status: interiorResult.status });
    }

    let interiorRaw = parseJsonObject(interiorResult.text);
    if (!interiorRaw) {
      const interiorRetry = [
        "Return VALID JSON ONLY for the interior. No markdown or explanation.",
        `LOCKED SHELL: ${JSON.stringify(lockedShell)}`,
        factsText,
        accuracyMode === "strict" ? "Do not invent hidden spaces." : "Infer a complete plausible plan constrained by the locked shell.",
        "Schema:", interiorSchema,
      ].join("\n");
      interiorResult = await runJointVision({ endpoint, apiToken, prompt: interiorRetry, dataUrls, maxTokens: 1900 });
      interiorRaw = interiorResult.ok ? parseJsonObject(interiorResult.text) : null;
    }

    if (!interiorRaw) {
      return NextResponse.json(
        { error: "The AI established the shell but could not reconstruct the interior reliably." },
        { status: 422 }
      );
    }

    const combinedRaw: AnyRecord = {
      ...shellRaw,
      ...interiorRaw,
      footprint: shellGeometry.footprint,
      attachedZones: shellGeometry.attachedZones || [],
      openings: shellGeometry.openings || [],
      stairs: (interiorRaw?.stairs && Array.isArray(interiorRaw.stairs) ? interiorRaw.stairs : shellGeometry.stairs) || [],
    };

    let geometry = normalizeGeometry(combinedRaw);
    if (!geometry) {
      return NextResponse.json({ error: "The reconstructed geometry was incomplete." }, { status: 422 });
    }

    if (accuracyMode === "strict") {
      geometry.inferredInteriorWalls = [];
      geometry.rooms = (geometry.rooms || []).filter((room) => room.basis === "visible" || room.basis === "fact");
    }

    geometry = orientFrontToBottom(geometry);

    const svg = renderPlanSvg(geometry, planStyle, knownDimension, floor);
    const image = svgDataUri(svg);
    const confidencePercent = Math.round((geometry.confidence ?? shellGeometry.confidence ?? 0.5) * 100);

    const confidenceHighlights = Object.entries(geometry.spaceConfidence || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([key, value]) => `${key} ${Math.round(value * 100)}%`)
      .join(", ");

    const report = [
      geometry.summary || shellGeometry.summary || "Smart two-pass architectural reconstruction completed.",
      `${geometry.footprint.length} shell vertices`,
      `${geometry.attachedZones?.length || 0} attached/site zones`,
      `${geometry.openings?.length || 0} supported openings`,
      `${geometry.rooms?.length || 0} reconstructed spaces`,
      confidenceHighlights ? `space confidence: ${confidenceHighlights}` : "",
    ].filter(Boolean).join(" · ");

    return NextResponse.json({
      geometry,
      image,
      report,
      confidence: `${confidencePercent}% geometry confidence`,
      provider: "cloudflare-qwen-smart-architect",
      format: "svg",
    });
  } catch (error) {
    console.error("ArchiNova smart reconstruction error:", error);
    return NextResponse.json(
      { error: "Something went wrong while reconstructing the project." },
      { status: 500 }
    );
  }
}
