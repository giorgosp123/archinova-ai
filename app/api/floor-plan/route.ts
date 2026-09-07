import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type AnyRecord = Record<string, any>;
type Point = [number, number];
type Segment = { a: Point; b: Point; confidence?: number; kind?: string };
type Opening = { a: Point; b: Point; confidence?: number; kind?: string };
type Area = { polygon: Point[]; reason?: string };
type Geometry = {
  footprint: Point[];
  confirmedInteriorWalls?: Segment[];
  probableInteriorWalls?: Segment[];
  openings?: Opening[];
  stairs?: Array<{ polygon: Point[]; confidence?: number }>;
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
  if (value && typeof value === "object") {
    return value.text || value.content || value.value || "";
  }
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
  return (
    data?.errors?.[0]?.message ||
    data?.error?.message ||
    data?.error ||
    "The floor plan geometry could not be created."
  );
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
  const result: Point[] = [];
  for (const item of value) {
    const parsed = point(item);
    if (parsed) result.push(parsed);
  }
  return result;
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
      confidence: Number.isFinite(Number(item?.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : undefined,
      kind: typeof item?.kind === "string" ? item.kind : undefined,
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
          confidence: Number.isFinite(Number(item?.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : undefined,
        }];
      })
    : [];

  const unknownAreas = Array.isArray(raw?.unknownAreas)
    ? raw.unknownAreas.flatMap((item: any) => {
        const polygon = points(item?.polygon);
        if (polygon.length < 3) return [];
        return [{ polygon, reason: typeof item?.reason === "string" ? item.reason : undefined }];
      })
    : [];

  const stairs = Array.isArray(raw?.stairs)
    ? raw.stairs.flatMap((item: any) => {
        const polygon = points(item?.polygon);
        if (polygon.length < 3) return [];
        return [{ polygon, confidence: Number.isFinite(Number(item?.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : undefined }];
      })
    : [];

  return {
    footprint,
    confirmedInteriorWalls: normalizeSegments(raw?.confirmedInteriorWalls),
    probableInteriorWalls: normalizeSegments(raw?.probableInteriorWalls),
    openings,
    stairs,
    unknownAreas,
    confidence: Number.isFinite(Number(raw?.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : undefined,
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
            "You are an architectural reconstruction engine. Return only the requested JSON. Never expose chain-of-thought. Never invent unsupported geometry in strict mode.",
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

function renderPlanSvg(geometry: Geometry, style: string, knownDimension: string, floor: string) {
  const width = 1200;
  const height = 900;
  const margin = 110;
  const footer = 100;
  const footprint = geometry.footprint;

  const xs = footprint.map((p) => p[0]);
  const ys = footprint.map((p) => p[1]);
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

  const unknown = (geometry.unknownAreas || [])
    .map((area) => `<polygon points="${poly(area.polygon)}" fill="url(#hatch)" stroke="#7a7a7a" stroke-width="2.5" stroke-dasharray="10 8"/>`)
    .join("");

  const exterior = `<polygon points="${poly(footprint)}" fill="#ffffff" stroke="#111111" stroke-width="12" stroke-linejoin="round"/>`;

  const confirmedWalls = (geometry.confirmedInteriorWalls || [])
    .map((s) => line(s, `stroke="#171717" stroke-width="8" stroke-linecap="square"`))
    .join("");

  const probableWalls = (geometry.probableInteriorWalls || [])
    .map((s) => line(s, `stroke="#777777" stroke-width="5" stroke-dasharray="10 8" stroke-linecap="square"`))
    .join("");

  const openings = (geometry.openings || []).map((o) => {
    const erase = line(o, `stroke="#ffffff" stroke-width="18" stroke-linecap="butt"`);
    const kind = (o.kind || "opening").toLowerCase();
    if (kind.includes("window")) {
      return erase + line(o, `stroke="#5e6770" stroke-width="4" stroke-linecap="butt"`);
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
    return erase + line(o, `stroke="#9a9a9a" stroke-width="2" stroke-dasharray="5 5"`);
  }).join("");

  const stairs = (geometry.stairs || []).map((item) => {
    const pts = item.polygon.map(map);
    const xs2 = pts.map((p) => p[0]);
    const ys2 = pts.map((p) => p[1]);
    const x = Math.min(...xs2);
    const y = Math.min(...ys2);
    const w = Math.max(...xs2) - x;
    const h = Math.max(...ys2) - y;
    const steps = 7;
    const stepLines = Array.from({ length: steps - 1 }, (_, i) => {
      if (w >= h) {
        const sx = x + (w / steps) * (i + 1);
        return `<line x1="${sx.toFixed(1)}" y1="${y.toFixed(1)}" x2="${sx.toFixed(1)}" y2="${(y + h).toFixed(1)}" stroke="#555" stroke-width="2"/>`;
      }
      const sy = y + (h / steps) * (i + 1);
      return `<line x1="${x.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${sy.toFixed(1)}" stroke="#555" stroke-width="2"/>`;
    }).join("");
    return `<polygon points="${pts.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ")}" fill="#f4f4f4" stroke="#555" stroke-width="3"/>${stepLines}`;
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
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${unknown}
    ${exterior}
    ${confirmedWalls}
    ${probableWalls}
    ${openings}
    ${stairs}
    <line x1="90" y1="${height - 78}" x2="${width - 90}" y2="${height - 78}" stroke="#d7d7d7" stroke-width="2"/>
    <text x="90" y="${height - 42}" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#111" font-weight="700">${esc(styleLabel)} · ${esc(floor)}</text>
    <text x="${width - 90}" y="${height - 42}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="19" fill="#666">${esc(subtitle)} · confidence ${confidence}%</text>
  </svg>`;
}

export async function POST(request: Request) {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return NextResponse.json({ error: "Cloudflare AI is not configured." }, { status: 503 });
    }

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

    if (!Array.isArray(analyses) || analyses.length === 0) {
      return NextResponse.json({ error: "No analyzed 3D views were supplied." }, { status: 400 });
    }

    const compactAnalyses = analyses.map((item) => ({
      view: item.view,
      analysis: String(item.analysis || "").trim().slice(0, 1800),
    }));

    const schema = `{
  "footprint": [[x,y], ...],
  "confirmedInteriorWalls": [{"a":[x,y],"b":[x,y],"confidence":0.0}],
  "probableInteriorWalls": [{"a":[x,y],"b":[x,y],"confidence":0.0}],
  "openings": [{"kind":"door|window|opening","a":[x,y],"b":[x,y],"confidence":0.0}],
  "stairs": [{"polygon":[[x,y],...],"confidence":0.0}],
  "unknownAreas": [{"polygon":[[x,y],...],"reason":"..."}],
  "confidence": 0.0,
  "summary": "short factual summary"
}`;

    const prompt = [
      "Convert the multi-view evidence into normalized 2D architectural plan geometry.",
      "Return ONLY one valid JSON object. No markdown and no commentary.",
      `TARGET FLOOR: ${floor}`,
      `MODE: ${accuracyMode}`,
      knownDimension ? `VERIFIED DIMENSION: ${knownDimension}` : "VERIFIED DIMENSION: none",
      notes ? `ARCHITECT NOTES: ${notes}` : "ARCHITECT NOTES: none",
      "Coordinate system: every coordinate must be a number from 0 to 100. Use x left-to-right and y front-to-back. Put the main/front facade toward the bottom of the coordinate system whenever the evidence allows.",
      "FOOTPRINT must be the exterior ground-contact boundary in clockwise order and must not repeat the first point at the end.",
      "Use the same footprint geometry implied across ALL views. Reconcile projections, recesses and setbacks instead of designing a generic house.",
      "confirmedInteriorWalls are only walls directly supported by visible cutaway/interior evidence.",
      accuracyMode === "strict"
        ? "STRICT: do not invent hidden rooms or walls. Put unsupported hidden zones in unknownAreas. probableInteriorWalls should normally be empty."
        : "INFERRED: probableInteriorWalls may contain conservative inferred partitions, but they must remain consistent with every exterior clue.",
      "Openings must lie on or very near supported wall segments. Include only openings whose location is visually supported.",
      "If stair geometry is not supported, return an empty stairs array.",
      "confidence is overall reconstruction confidence from 0 to 1.",
      "Required schema:",
      schema,
      "VIEW EVIDENCE:",
      compactAnalyses.map((item) => `VIEW ${item.view}: ${item.analysis}`).join("\n"),
    ].join("\n");

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
    let response = await requestGeometry(endpoint, apiToken, prompt, 1500);

    if (!response.ok) {
      console.error("Geometry JSON request failed:", response.data);
      return NextResponse.json({ error: response.error }, { status: response.status });
    }

    let geometry = normalizeGeometry(parseJsonObject(response.text) || {});

    if (!geometry) {
      const retryPrompt = [
        "Your previous response was not valid usable geometry. Return ONLY valid JSON now.",
        "Use normalized coordinates 0-100 and provide at least 3 ordered footprint points.",
        accuracyMode === "strict" ? "Do not invent hidden interior walls." : "Infer hidden walls only conservatively.",
        "Schema:",
        schema,
        "Evidence:",
        compactAnalyses.map((item) => `VIEW ${item.view}: ${item.analysis}`).join("\n"),
        knownDimension ? `Known dimension: ${knownDimension}` : "",
        notes ? `Architect notes: ${notes}` : "",
      ].filter(Boolean).join("\n");

      response = await requestGeometry(endpoint, apiToken, retryPrompt, 1200);
      if (response.ok) geometry = normalizeGeometry(parseJsonObject(response.text) || {});
    }

    if (!geometry) {
      console.error("Could not obtain valid structured geometry:", {
        finishReason: response.data?.choices?.[0]?.finish_reason,
        textPreview: response.text?.slice(0, 500),
      });
      return NextResponse.json(
        { error: "The views did not produce reliable plan geometry. Add clearer opposite-side or elevated views and try again." },
        { status: 422 }
      );
    }

    if (accuracyMode === "strict") {
      geometry.probableInteriorWalls = [];
    }

    const svg = renderPlanSvg(geometry, planStyle, knownDimension, floor);
    const image = svgDataUri(svg);
    const confidencePercent = Math.round((geometry.confidence ?? 0.5) * 100);
    const report = [
      geometry.summary || "Geometry reconstructed from the uploaded views.",
      `${geometry.footprint.length} exterior footprint vertices`,
      `${geometry.confirmedInteriorWalls?.length || 0} confirmed interior wall segments`,
      `${geometry.openings?.length || 0} supported openings`,
      `${geometry.unknownAreas?.length || 0} unresolved zones`,
    ].join(" · ");

    return NextResponse.json({
      image,
      report,
      confidence: `${confidencePercent}% geometry confidence`,
      provider: "cloudflare-geometry",
      format: "svg",
    });
  } catch (error) {
    console.error("ArchiNova floor plan reconstruction error:", error);
    return NextResponse.json(
      { error: "Something went wrong while reconstructing the floor plan." },
      { status: 500 }
    );
  }
}
