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
        if (item && typeof item === "object") {
          return item.text || item.content || item.value || "";
        }
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
    "The 3D view could not be analyzed."
  );
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
            "You are an architectural reconstruction assistant. Give the final evidence summary directly. Do not expose chain-of-thought. Accuracy and uncertainty matter more than completeness.",
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
      error: "Cloudflare returned an unreadable vision response.",
      data: {},
      analysis: "",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: String(cloudflareErrorMessage(data)),
      data,
      analysis: "",
    };
  }

  return {
    ok: true,
    status: response.status,
    error: "",
    data,
    analysis: extractAssistantText(data).trim(),
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
    const image = form.get("image");
    const viewIndex = String(form.get("viewIndex") || "1");
    const totalViews = String(form.get("totalViews") || "1");

    if (!(image instanceof File)) {
      return NextResponse.json({ error: "Missing image." }, { status: 400 });
    }

    if (!allowedImageTypes.has(image.type)) {
      return NextResponse.json({ error: "Use PNG, JPG or WEBP images." }, { status: 400 });
    }

    if (image.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "Prepared image is too large." }, { status: 400 });
    }

    const bytes = Buffer.from(await image.arrayBuffer());
    const dataUrl = `data:${image.type};base64,${bytes.toString("base64")}`;

    const prompt = [
      `Architectural 3D view ${viewIndex} of ${totalViews}, all showing the same building.`,
      "Extract evidence for reconstructing a top-down floor plan.",
      "Do NOT design a new building. Do NOT invent hidden rooms.",
      "Return only a concise evidence summary, maximum 180 words.",
      "Use these headings exactly:",
      "VIEWPOINT: likely front/rear/left/right/corner/elevated/unknown.",
      "FOOTPRINT: visible building edges, depth/width relationships, projections, recesses and ground-contact geometry.",
      "OPENINGS: visible entrances, doors, windows and their approximate positions along the facade.",
      "CIRCULATION: visible stairs, ramps, terraces, balconies or carports that affect plan geometry.",
      "INTERIOR: only interior walls/spaces directly visible through glazing, cutaways or open sides.",
      "CONNECTIONS: clues for how this facade connects to neighboring sides.",
      "UNCERTAINTY: facts that cannot be determined from this image.",
      "CONFIDENCE: high, medium or low with one short reason.",
    ].join("\n");

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      accountId
    )}/ai/v1/chat/completions`;

    let result = await runVisionRequest({
      endpoint,
      apiToken,
      prompt,
      dataUrl,
      maxTokens: 420,
    });

    if (!result.ok) {
      console.error("Cloudflare vision analysis error:", result.data);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Some model/runtime combinations can still spend the whole budget before emitting
    // final content. Retry once with an even shorter direct-answer prompt.
    if (!result.analysis) {
      const finishReason = result.data?.choices?.[0]?.finish_reason;
      console.warn("Empty vision response, retrying:", {
        finishReason,
        usage: result.data?.usage,
        messageKeys: Object.keys(result.data?.choices?.[0]?.message || {}),
      });

      const retryPrompt = [
        `View ${viewIndex}/${totalViews} of one building.`,
        "Reply immediately with 6 short lines only. No reasoning, preamble or explanation.",
        "1 VIEWPOINT: facade/orientation guess.",
        "2 FOOTPRINT: visible outer geometry and setbacks.",
        "3 OPENINGS: entrance/windows/doors positions.",
        "4 CIRCULATION: stairs/terraces/carport if visible.",
        "5 UNKNOWN: hidden geometry that cannot be proven.",
        "6 CONFIDENCE: high/medium/low.",
      ].join("\n");

      result = await runVisionRequest({
        endpoint,
        apiToken,
        prompt: retryPrompt,
        dataUrl,
        maxTokens: 260,
      });
    }

    if (!result.ok) {
      console.error("Cloudflare vision retry error:", result.data);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    if (!result.analysis) {
      console.error("Vision response remained empty after retry:", {
        finishReason: result.data?.choices?.[0]?.finish_reason,
        usage: result.data?.usage,
        messageKeys: Object.keys(result.data?.choices?.[0]?.message || {}),
      });
      return NextResponse.json(
        { error: "This view could not be analyzed. Try the reconstruction again." },
        { status: 502 }
      );
    }

    return NextResponse.json({ analysis: result.analysis });
  } catch (error) {
    console.error("ArchiNova view analysis error:", error);
    return NextResponse.json(
      { error: "Something went wrong while analyzing the 3D view." },
      { status: 500 }
    );
  }
}
