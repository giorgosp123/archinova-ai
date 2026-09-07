import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

type AnyRecord = Record<string, any>;

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
    message?.reasoning_content,
    message?.reasoning,
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
    "The floor plan could not be created."
  );
}

async function synthesizeGeometry(params: {
  endpoint: string;
  apiToken: string;
  prompt: string;
  maxTokens: number;
}) {
  const response = await fetch(params.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "@cf/google/gemma-4-26b-a4b-it",
      messages: [
        {
          role: "system",
          content:
            "You are a senior architectural reconstruction specialist. Output the final geometry brief directly. Do not expose chain-of-thought. Accuracy and uncertainty reporting are more important than completeness.",
        },
        { role: "user", content: params.prompt },
      ],
      temperature: 0,
      max_tokens: params.maxTokens,
      chat_template_kwargs: {
        enable_thinking: false,
      },
    }),
  });

  let data: AnyRecord = {};
  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status || 502,
      error: "Cloudflare returned an unreadable geometry response.",
      data: {},
      text: "",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: String(cloudflareErrorMessage(data)),
      data,
      text: "",
    };
  }

  return {
    ok: true,
    status: response.status,
    error: "",
    data,
    text: extractAssistantText(data).trim(),
  };
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
    const viewCount = Number(form.get("viewCount") || 0);

    let analyses: Array<{ view: number; analysis: string }> = [];
    try {
      analyses = JSON.parse(analysesRaw);
    } catch {
      return NextResponse.json({ error: "Invalid analysis data." }, { status: 400 });
    }

    if (!Array.isArray(analyses) || analyses.length === 0) {
      return NextResponse.json({ error: "No analyzed 3D views were supplied." }, { status: 400 });
    }

    // Cap text per view to keep the synthesis deterministic and prevent a single noisy
    // analysis from dominating the combined reconstruction.
    const compactAnalyses = analyses.map((item) => ({
      view: item.view,
      analysis: String(item.analysis || "").trim().slice(0, 2200),
    }));

    const synthesisPrompt = [
      "Reconstruct ONE building from multiple 3D-view evidence summaries.",
      "Return the final geometry brief directly. No chain-of-thought, preamble or design suggestions.",
      "Accuracy is more important than completeness. Never silently invent geometry.",
      `TARGET FLOOR: ${floor}`,
      `ACCURACY MODE: ${accuracyMode}`,
      knownDimension ? `VERIFIED DIMENSION: ${knownDimension}` : "VERIFIED DIMENSION: none supplied",
      notes ? `ARCHITECT NOTES: ${notes}` : "ARCHITECT NOTES: none supplied",
      "Cross-check the same visible edges and openings across different views. Resolve camera-view contradictions conservatively.",
      accuracyMode === "strict"
        ? "STRICT EVIDENCE: unsupported hidden interior walls and rooms must stay UNKNOWN. Preserve only evidence-supported footprint and interior geometry."
        : "INFERRED MODE: fill hidden areas minimally and conservatively while respecting every visible exterior clue.",
      "Use these headings exactly and keep the entire answer under 500 words:",
      "FOOTPRINT:",
      "EXTERIOR OPENINGS:",
      "VERTICAL CIRCULATION:",
      "INTERIOR EVIDENCE:",
      "UNKNOWN AREAS:",
      "CONTRADICTIONS:",
      "CONFIDENCE:",
      "\nVIEW EVIDENCE:\n" + compactAnalyses.map((item) => `VIEW ${item.view}:\n${item.analysis}`).join("\n\n"),
    ].join("\n");

    const chatEndpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      accountId
    )}/ai/v1/chat/completions`;

    let synthesis = await synthesizeGeometry({
      endpoint: chatEndpoint,
      apiToken,
      prompt: synthesisPrompt,
      maxTokens: 850,
    });

    if (!synthesis.ok) {
      console.error("Cloudflare synthesis error:", synthesis.data);
      return NextResponse.json({ error: synthesis.error }, { status: synthesis.status });
    }

    if (!synthesis.text) {
      console.warn("Empty geometry synthesis, retrying:", {
        finishReason: synthesis.data?.choices?.[0]?.finish_reason,
        usage: synthesis.data?.usage,
        messageKeys: Object.keys(synthesis.data?.choices?.[0]?.message || {}),
      });

      const fallbackPrompt = [
        `Combine ${compactAnalyses.length} architectural view summaries into one conservative ${floor} plan brief.`,
        knownDimension ? `Known scale: ${knownDimension}.` : "No known scale.",
        notes ? `Architect notes: ${notes}` : "",
        accuracyMode === "strict"
          ? "Do not invent hidden rooms. Mark unsupported areas UNKNOWN."
          : "Infer hidden areas minimally.",
        "Reply immediately under 300 words with: FOOTPRINT, OPENINGS, CIRCULATION, INTERIOR, UNKNOWN, CONFIDENCE.",
        compactAnalyses.map((item) => `VIEW ${item.view}: ${item.analysis}`).join("\n"),
      ]
        .filter(Boolean)
        .join("\n");

      synthesis = await synthesizeGeometry({
        endpoint: chatEndpoint,
        apiToken,
        prompt: fallbackPrompt,
        maxTokens: 520,
      });
    }

    if (!synthesis.ok) {
      console.error("Cloudflare synthesis retry error:", synthesis.data);
      return NextResponse.json({ error: synthesis.error }, { status: synthesis.status });
    }

    const reconstructionBrief = synthesis.text.trim();
    if (!reconstructionBrief) {
      console.error("Geometry synthesis remained empty:", {
        finishReason: synthesis.data?.choices?.[0]?.finish_reason,
        usage: synthesis.data?.usage,
        messageKeys: Object.keys(synthesis.data?.choices?.[0]?.message || {}),
      });
      return NextResponse.json(
        { error: "The geometry could not be synthesized. Please try again." },
        { status: 502 }
      );
    }

    const anchors: File[] = [];
    for (let index = 0; index < 4; index += 1) {
      const candidate = form.get(`image_${index}`);
      if (!(candidate instanceof File) || candidate.size === 0) continue;
      if (!allowedImageTypes.has(candidate.type)) {
        return NextResponse.json({ error: "Use PNG, JPG or WEBP anchor images." }, { status: 400 });
      }
      anchors.push(candidate);
    }

    const drawingPrompt = [
      "Create an orthographic top-down architectural floor plan reconstruction of the SAME building shown in the reference images.",
      "This is reconstruction, not architectural redesign. The geometry brief is the source of truth.",
      "Match the exterior footprint, projections, recesses, entrances, visible openings and circulation as closely as the evidence allows.",
      accuracyMode === "strict"
        ? "Unsupported hidden interior zones must remain blank, unresolved or lightly hatched. Do NOT invent bedrooms, bathrooms, corridors or walls to make the drawing complete."
        : "Hidden areas may be minimally inferred only when compatible with all evidence.",
      "Use true plan view only. No perspective, axonometric view, 3D rendering or exterior elevation.",
      planStyle === "Technical"
        ? "Technical drawing: pure white background, crisp black/dark-gray walls, readable openings, restrained line weights, minimal furniture, no landscaping."
        : "Clean presentation plan: white background, precise dark walls, subtle gray fills and only minimal supported furniture.",
      knownDimension
        ? `Scale clue: ${knownDimension}. Use it only as stated and do not invent other measurements.`
        : "Do not print invented measurements.",
      `Target floor: ${floor}.`,
      `Evidence came from ${viewCount || compactAnalyses.length} uploaded views.`,
      "No title block, logo, watermark or explanatory text inside the drawing.",
      "GEOMETRY BRIEF:",
      reconstructionBrief,
    ].join("\n");

    const imageBody = new FormData();
    imageBody.append("prompt", drawingPrompt);
    anchors.forEach((file, index) => {
      imageBody.append(`input_image_${index}`, file, file.name || `anchor-${index + 1}.jpg`);
    });
    imageBody.append("width", "1024");
    imageBody.append("height", "768");
    imageBody.append("guidance", accuracyMode === "strict" ? "6" : "5.2");

    const imageEndpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      accountId
    )}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`;

    const imageResponse = await fetch(imageEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: imageBody,
    });

    const contentType = imageResponse.headers.get("content-type") || "";
    if (!imageResponse.ok) {
      let message = "The floor plan could not be created.";
      try {
        if (contentType.includes("application/json")) {
          message = String(cloudflareErrorMessage(await imageResponse.json()));
        } else {
          const text = await imageResponse.text();
          if (text.trim()) message = text.slice(0, 500);
        }
      } catch {
        // Keep fallback.
      }
      console.error("Cloudflare floor plan generation error:", message);
      return NextResponse.json({ error: message }, { status: imageResponse.status });
    }

    let image = "";
    if (contentType.startsWith("image/")) {
      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      const mime = contentType.split(";")[0] || "image/png";
      image = `data:${mime};base64,${bytes.toString("base64")}`;
    } else {
      const data = await imageResponse.json();
      const result = data?.result ?? data;
      const encoded =
        result?.image ||
        result?.b64_json ||
        result?.data?.[0]?.b64_json ||
        result?.data?.[0]?.image ||
        null;
      if (typeof encoded === "string") {
        image = encoded.startsWith("data:image/") ? encoded : `data:image/png;base64,${encoded}`;
      }
    }

    if (!image) {
      return NextResponse.json({ error: "The image model returned no floor plan." }, { status: 502 });
    }

    const confidenceMatch = reconstructionBrief.match(/CONFIDENCE\s*:?\s*([^\n]+)/i);
    const confidence = confidenceMatch?.[1]?.trim()?.slice(0, 100) || undefined;
    const compactReport = reconstructionBrief.replace(/\s+/g, " ").trim().slice(0, 1200);

    return NextResponse.json({
      image,
      report: compactReport,
      confidence,
      provider: "cloudflare",
    });
  } catch (error) {
    console.error("ArchiNova floor plan reconstruction error:", error);
    return NextResponse.json(
      { error: "Something went wrong while reconstructing the floor plan." },
      { status: 500 }
    );
  }
}
