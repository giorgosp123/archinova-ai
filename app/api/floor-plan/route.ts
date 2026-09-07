import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

function extractAssistantText(data: any) {
  return (
    data?.choices?.[0]?.message?.content ||
    data?.result?.response ||
    data?.result?.text ||
    data?.response ||
    (typeof data?.result === "string" ? data.result : "") ||
    ""
  );
}

function cloudflareErrorMessage(data: any) {
  return (
    data?.errors?.[0]?.message ||
    data?.error?.message ||
    data?.error ||
    "The floor plan could not be created."
  );
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

    const synthesisPrompt = [
      "You are reconstructing ONE building from multiple architectural 3D views that were analyzed separately.",
      "Your job is to reconcile the views into one consistent top-down geometry brief for a floor plan.",
      "Accuracy is more important than completeness. Never silently invent geometry that is not supported.",
      `Target floor: ${floor}.`,
      `Accuracy mode: ${accuracyMode}.`,
      knownDimension ? `Known project dimension: ${knownDimension}.` : "No verified physical dimension was supplied.",
      notes ? `Architect notes: ${notes}` : "No additional architect notes were supplied.",
      "Cross-check facade relationships, visible setbacks, projections, entrances, stairs, windows, terraces and ground-contact edges between views.",
      "Resolve contradictions explicitly. Distinguish CONFIRMED, PROBABLE and UNKNOWN geometry.",
      accuracyMode === "strict"
        ? "STRICT MODE: hidden interior walls and rooms that cannot be supported must remain UNKNOWN. Do not fill them just to make the plan look complete."
        : "INFERRED MODE: hidden areas may be filled conservatively, but clearly separate strong evidence from inference.",
      "Return a concise reconstruction brief with these headings: FOOTPRINT, EXTERIOR OPENINGS, VERTICAL CIRCULATION, INTERIOR EVIDENCE, UNKNOWN AREAS, CONTRADICTIONS, CONFIDENCE.",
      "Do not output markdown tables.",
      "\nVIEW ANALYSES:\n" + analyses.map((item) => `VIEW ${item.view}:\n${item.analysis}`).join("\n\n"),
    ].join("\n");

    const chatEndpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
    const synthesisResponse = await fetch(chatEndpoint, {
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
              "You are a senior architectural reconstruction specialist. You combine multi-view evidence into conservative geometry without hallucinating hidden spaces.",
          },
          { role: "user", content: synthesisPrompt },
        ],
        temperature: 0.1,
        max_completion_tokens: 1200,
      }),
    });

    const synthesisData = await synthesisResponse.json();
    if (!synthesisResponse.ok) {
      console.error("Cloudflare synthesis error:", synthesisData);
      return NextResponse.json(
        { error: String(cloudflareErrorMessage(synthesisData)) },
        { status: synthesisResponse.status }
      );
    }

    const reconstructionBrief = extractAssistantText(synthesisData).trim();
    if (!reconstructionBrief) {
      return NextResponse.json({ error: "The geometry synthesis returned no result." }, { status: 502 });
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
      "Create a clean orthographic top-down architectural floor plan reconstruction of the SAME building shown in the reference images.",
      "This is not a new design exercise. Follow the reconstruction brief below as the source of truth.",
      "Prioritize the exterior footprint, projections, recesses, entrances, visible openings and vertical circulation exactly as supported by the evidence.",
      accuracyMode === "strict"
        ? "For unsupported hidden interior areas: leave them open, blank, lightly hatched or unresolved. Do NOT invent bedrooms, bathrooms, corridors or walls simply to complete the drawing."
        : "For hidden areas, infer only a minimal plausible layout consistent with all exterior evidence and architect notes.",
      "Use a true plan view with no perspective and no 3D rendering.",
      planStyle === "Technical"
        ? "Technical drafting style: white background, crisp black and dark gray wall lines, clean door swings, window openings, restrained line weights, minimal or no furniture, no decorative landscaping."
        : "Clean presentation plan style: white background, precise dark wall lines, subtle light-gray fills, minimal furniture only where supported, still orthographic and technically readable.",
      knownDimension
        ? `Use this known scale clue where possible: ${knownDimension}. Do not invent other dimensions.`
        : "Do not print invented measurements or dimensions.",
      `Target floor: ${floor}.`,
      `The system analyzed ${viewCount || analyses.length} views before drawing this plan.`,
      "Do not add a title block, logo, watermark or explanatory text inside the drawing.",
      "RECONSTRUCTION BRIEF:",
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
    const confidence = confidenceMatch?.[1]?.trim()?.slice(0, 80) || undefined;
    const compactReport = reconstructionBrief.replace(/\s+/g, " ").trim().slice(0, 900);

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
