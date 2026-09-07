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
      `This is architectural 3D view ${viewIndex} of ${totalViews}.`,
      "Analyze it as evidence for reconstructing an accurate top-down floor plan of the SAME building.",
      "Do not design a new building and do not guess hidden rooms.",
      "Describe only what can be supported by this view and clearly mark uncertain items as uncertain.",
      "Focus on: likely viewpoint/orientation, visible facade length relationships, building footprint shape, projections/recesses, number of storeys, entrances, doors, windows, terraces, stairs, carports, courtyards, roof/overhang clues, ground-contact edges, and any interior geometry that is actually visible.",
      "Also note which side of the building this view likely represents and how it could connect to adjacent facades.",
      "Use concise architectural language. Finish with a short confidence statement."
    ].join("\n");

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/chat/completions`;
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
              "You are an architectural reconstruction and photogrammetry assistant. Accuracy and uncertainty reporting matter more than completeness.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.1,
        max_completion_tokens: 700,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const message =
        data?.errors?.[0]?.message ||
        data?.error?.message ||
        data?.error ||
        "The 3D view could not be analyzed.";
      console.error("Cloudflare vision analysis error:", data);
      return NextResponse.json({ error: String(message) }, { status: response.status });
    }

    const analysis = extractAssistantText(data).trim();
    if (!analysis) {
      console.error("Unexpected vision response:", data);
      return NextResponse.json({ error: "The vision model returned no analysis." }, { status: 502 });
    }

    return NextResponse.json({ analysis });
  } catch (error) {
    console.error("ArchiNova view analysis error:", error);
    return NextResponse.json({ error: "Something went wrong while analyzing the 3D view." }, { status: 500 });
  }
}
