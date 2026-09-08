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
    const fill = kind.includes("parking") || kind.includes("carport") ? "#f3f3f3" : "#f7f7f7";
    return `<polygon points="${poly(zone.polygon)}" fill="${fill}" stroke="#777" stroke-width="3" stroke-dasharray="9 6"/>
      <text x="${c[0].toFixed(1)}" y="${c[1].toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#666" font-weight="700">${label}</text>`;
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
    const opacity = room.basis === "visible" ? "1" : "0.78";
    return `<text x="${c[0].toFixed(1)}" y="${c[1].toFixed(1)}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="19" fill="#333" font-weight="700" opacity="${opacity}">${label}</text>`;
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
            "You are a multi-view architectural reconstruction engine. All supplied images show the same building. Cross-match facades and geometry before answering. Return final structured geometry only, never chain-of-thought.",
        },
        { role: "user", content },
      ],
      temperature: 0,
      reasoning_effort: "low",
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
    const batchIndex = Math.max(0, Number(form.get("batchIndex") || 0));
    const batchCount = Math.max(1, Number(form.get("batchCount") || 1));
    const totalViews = Math.max(1, Number(form.get("totalViews") || 1));

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

    const schema = `{
  "footprint": [[x,y], ...],
  "attachedZones": [{"kind":"parking|carport|covered_terrace|outdoor_dining|outdoor_sitting|entry_platform|other","label":"...","polygon":[[x,y],...],"confidence":0.0}],
  "confirmedInteriorWalls": [{"a":[x,y],"b":[x,y],"confidence":0.0}],
  "inferredInteriorWalls": [{"a":[x,y],"b":[x,y],"confidence":0.0}],
  "openings": [{"kind":"door|sliding_door|window|glazing|opening","a":[x,y],"b":[x,y],"confidence":0.0}],
  "stairs": [{"polygon":[[x,y],...],"confidence":0.0}],
  "rooms": [{"label":"Kitchen|Living Area|Dining Area|Entry Lobby|WC|Stair|Other","polygon":[[x,y],...],"confidence":0.0,"basis":"visible|inferred"}],
  "unknownAreas": [{"polygon":[[x,y],...],"reason":"..."}],
  "confidence": 0.0,
  "summary": "short factual summary"
}`;

    const previousText = previousGeometry
      ? `EXISTING CANONICAL GEOMETRY FROM EARLIER BATCHES:\n${JSON.stringify(previousGeometry)}\nRefine this geometry only where the new views provide stronger evidence. Keep the same coordinate orientation and do not restart with a generic footprint.`
      : "There is no previous geometry. Establish one canonical orientation from all images in this batch.";

    const prompt = [
      `You are reconstructing ${floor} from ${totalViews} total 3D renders/screenshots of ONE real architectural project.`,
      `This request is batch ${batchIndex + 1} of ${batchCount}. The images in THIS message must be inspected TOGETHER, not independently.`,
      previousText,
      "First cross-match the views using distinctive masses, balconies, canopies, glazing, blank walls, carport, entry steps and landscaping boundaries. Identify which visible facades connect to each other.",
      "The main/front facade should face the BOTTOM of the final plan coordinate system when you can identify the entrance/driveway side. x increases left-to-right and y increases rear-to-front, all coordinates 0..100.",
      "Reconstruct the ACTUAL stepped ground-contact shell. Do not simplify an L-shaped, recessed or projecting building into a rectangle.",
      "Treat attached architectural/site spaces that materially define the plan separately: parking/carport, covered outdoor dining, outdoor sitting terraces, entry platform/steps and similar zones.",
      "Use openings as hard constraints. Large glazing usually belongs to living/dining zones; service windows/blank walls constrain kitchen/WC/service placement; main entry constrains lobby and stairs.",
      accuracyMode === "strict"
        ? "STRICT MODE: only draw interior walls/rooms directly supported by visible interior evidence. Unknown hidden zones must stay in unknownAreas."
        : "FULL RECONSTRUCTION MODE: infer a complete practical interior layout, but every inferred wall/room must respect the shell, openings, entrance, stairs, carport and outdoor-zone evidence. Do not invent an unrelated generic house plan.",
      knownDimension ? `VERIFIED DIMENSION: ${knownDimension}. Use it as the only trusted scale clue.` : "No verified dimension was supplied. Preserve proportions rather than inventing measurements.",
      notes ? `ARCHITECT NOTES: ${notes}` : "No architect notes supplied.",
      "Return ONLY one valid JSON object. No markdown, no prose outside JSON.",
      "Required schema:",
      schema,
    ].join("\n");

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
    let result = await runJointVision({ endpoint, apiToken, prompt, dataUrls, maxTokens: 2400 });

    if (!result.ok) {
      console.error("Joint multi-view request failed:", result.data);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    let geometry = normalizeGeometry(parseJsonObject(result.text) || {});

    if (!geometry) {
      const retryPrompt = [
        "Return the reconstruction again as VALID JSON ONLY.",
        "Do not describe the images. Do not return markdown.",
        "All images show the same building and must be cross-matched together.",
        previousGeometry ? `Preserve/refine this prior geometry: ${JSON.stringify(previousGeometry)}` : "Establish the shell from the supplied views.",
        accuracyMode === "strict" ? "Do not invent hidden interior geometry." : "Infer a complete layout only within the evidence-supported shell.",
        "Schema:",
        schema,
      ].join("\n");
      result = await runJointVision({ endpoint, apiToken, prompt: retryPrompt, dataUrls, maxTokens: 2000 });
      if (result.ok) geometry = normalizeGeometry(parseJsonObject(result.text) || {});
    }

    if (!geometry) {
      console.error("Joint vision returned unusable geometry:", {
        finishReason: result.data?.choices?.[0]?.finish_reason,
        preview: result.text?.slice(0, 600),
      });
      return NextResponse.json(
        { error: "The multi-view model could not produce reliable geometry from this batch. Try clearer opposite-side views." },
        { status: 422 }
      );
    }

    if (accuracyMode === "strict") {
      geometry.inferredInteriorWalls = [];
      geometry.rooms = (geometry.rooms || []).filter((room) => room.basis === "visible");
    }

    const svg = renderPlanSvg(geometry, planStyle, knownDimension, floor);
    const image = svgDataUri(svg);
    const confidencePercent = Math.round((geometry.confidence ?? 0.5) * 100);
    const report = [
      geometry.summary || "Joint multi-view geometry reconstructed.",
      `${geometry.footprint.length} shell vertices`,
      `${geometry.attachedZones?.length || 0} attached/site zones`,
      `${geometry.openings?.length || 0} supported openings`,
      `${geometry.rooms?.length || 0} room zones`,
    ].join(" · ");

    return NextResponse.json({
      geometry,
      image,
      report,
      confidence: `${confidencePercent}% geometry confidence`,
      provider: "cloudflare-qwen-multiview",
      format: "svg",
    });
  } catch (error) {
    console.error("ArchiNova joint reconstruction error:", error);
    return NextResponse.json(
      { error: "Something went wrong while reconstructing the project." },
      { status: 500 }
    );
  }
}
