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
  return data?.errors?.[0]?.message || data?.error?.message || data?.error || "The 3D view could not be analyzed.";
}

async function runVisionRequest(params: {
  endpoint: string;
  apiToken: string;
  prompt: string;
  dataUrl: string;
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
            "You are an architectural reconstruction surveyor. Extract only plan-relevant visual evidence. Give the final evidence summary directly, with no chain-of-thought. Distinguish observed facts from weak inference.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: params.prompt },
            { type: "image_url", image_url: { url: params.dataUrl } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: params.maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  let data: AnyRecord = {};
  try {
    data = await response.json();
  } catch {
    return { ok: false, status: response.status || 502, error: "Cloudflare returned an unreadable vision response.", data: {}, analysis: "" };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: String(cloudflareErrorMessage(data)), data, analysis: "" };
  }

  return { ok: true, status: response.status, error: "", data, analysis: extractAssistantText(data).trim() };
}

export async function POST(request: Request) {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return NextResponse.json({ error: "Cloudflare AI is not configured." }, { status: 503 });
    }

    const form = await request.formData();
    const image = form.get("image");
    const viewIndex = String(form.get("viewIndex") || "1");
    const totalViews = String(form.get("totalViews") || "1");

    if (!(image instanceof File)) return NextResponse.json({ error: "Missing image." }, { status: 400 });
    if (!allowedImageTypes.has(image.type)) return NextResponse.json({ error: "Use PNG, JPG or WEBP images." }, { status: 400 });
    if (image.size > 5 * 1024 * 1024) return NextResponse.json({ error: "Prepared image is too large." }, { status: 400 });

    const bytes = Buffer.from(await image.arrayBuffer());
    const dataUrl = `data:${image.type};base64,${bytes.toString("base64")}`;

    const prompt = [
      `3D architectural view ${viewIndex} of ${totalViews}. Every uploaded image shows the same project.`,
      "Goal: reconstruct a real ground-floor architectural plan, not a generic house diagram.",
      "Read the image like a surveyor. Do not invent hidden rooms.",
      "Describe facade segments from LEFT TO RIGHT as seen in this view and use approximate relative widths such as 20% / 35% / 45% when useful.",
      "Treat attached outdoor program as plan geometry too: carports/parking bays, covered terraces, outdoor dining, outdoor sitting, entry platforms, steps, ramps and recessed patios.",
      "Use these headings exactly and stay under 260 words:",
      "VIEWPOINT: front/rear/left/right/corner/elevated/unknown and camera direction if inferable.",
      "GROUND CONTACT: visible built footprint edges, projections, recesses, setbacks, attached wings and where each mass meets the ground.",
      "FACADE SEQUENCE: left-to-right sequence of solid walls, glazing, doors, carport openings, recesses and projections with rough relative widths.",
      "OPENINGS: doors/windows/sliding glazing and approximate position along the visible facade.",
      "OUTDOOR PLAN: carport/parking, covered or open terraces, outdoor dining/sitting, steps, platforms, planters or walls that belong to the ground-floor plan composition.",
      "VERTICAL CORE: stairs, tall stair volume, double-height clues or upper-floor stacking cues.",
      "FUNCTIONAL CUES: only weak functional clues supported by architecture, e.g. largest glazing may indicate living; service-sized openings may indicate kitchen/WC. Mark these as probable, never certain.",
      "INTERIOR VISIBLE: only interior walls/spaces directly visible through glazing, open sides or cutaways.",
      "SIDE CONNECTIONS: how this facade appears to turn/connect to adjacent sides, including depth clues.",
      "UNKNOWN: geometry and rooms not visible in this view.",
      "CONFIDENCE: high/medium/low and one short reason.",
    ].join("\n");

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;

    let result = await runVisionRequest({ endpoint, apiToken, prompt, dataUrl, maxTokens: 620 });

    if (!result.ok) {
      console.error("Cloudflare vision analysis error:", result.data);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    if (!result.analysis) {
      const retryPrompt = [
        `View ${viewIndex}/${totalViews} of the same building.`,
        "Reply immediately with 8 short lines. No reasoning.",
        "1 VIEWPOINT: orientation.",
        "2 GROUND: footprint/recesses/projections.",
        "3 FACADE: left-to-right segment sequence and rough ratios.",
        "4 OPENINGS: doors/windows/glazing positions.",
        "5 OUTDOOR: carport/parking/terrace/steps/platforms.",
        "6 CORE: stairs or tall core clues.",
        "7 FUNCTION: probable living/kitchen/service clues only if visible.",
        "8 UNKNOWN + CONFIDENCE.",
      ].join("\n");
      result = await runVisionRequest({ endpoint, apiToken, prompt: retryPrompt, dataUrl, maxTokens: 360 });
    }

    if (!result.ok) {
      console.error("Cloudflare vision retry error:", result.data);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    if (!result.analysis) {
      return NextResponse.json({ error: "This view could not be analyzed. Try the reconstruction again." }, { status: 502 });
    }

    return NextResponse.json({ analysis: result.analysis });
  } catch (error) {
    console.error("ArchiNova view analysis error:", error);
    return NextResponse.json({ error: "Something went wrong while analyzing the 3D view." }, { status: 500 });
  }
}
