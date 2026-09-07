import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const allowedImageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function outputDimensions(ratio: string) {
  if (ratio === "1:1") return { width: 1024, height: 1024 };
  if (ratio === "4:3") return { width: 1024, height: 768 };
  return { width: 1024, height: 576 };
}

function cloudflareErrorMessage(data: unknown) {
  if (!data || typeof data !== "object") return "The AI render could not be created.";

  const record = data as {
    errors?: Array<{ message?: string }>;
    error?: string | { message?: string };
  };

  if (Array.isArray(record.errors) && record.errors[0]?.message) {
    return record.errors[0].message;
  }

  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object" && record.error.message) {
    return record.error.message;
  }

  return "The AI render could not be created.";
}

export async function POST(request: Request) {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return NextResponse.json(
        {
          error:
            "AI rendering is not configured yet. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in Vercel.",
        },
        { status: 503 }
      );
    }

    const incoming = await request.formData();
    const prompt = String(incoming.get("prompt") || "").trim();
    const style = String(incoming.get("style") || "Modern").trim();
    const ratio = String(incoming.get("ratio") || "16:9").trim();
    const renderType = String(incoming.get("renderType") || "Exterior").trim();
    const preserveDesign = String(incoming.get("preserveDesign") || "true") === "true";

    const references: Array<{ file: File; role: string }> = [];

    for (let index = 0; index < 4; index += 1) {
      const candidate = incoming.get(`image_${index}`);
      if (!(candidate instanceof File) || candidate.size === 0) continue;

      if (!allowedImageTypes.has(candidate.type)) {
        return NextResponse.json(
          { error: "Use PNG, JPG or WEBP images for references." },
          { status: 400 }
        );
      }

      if (candidate.size > 8 * 1024 * 1024) {
        return NextResponse.json(
          { error: "Each reference image must be smaller than 8 MB." },
          { status: 400 }
        );
      }

      references.push({
        file: candidate,
        role: String(incoming.get(`role_${index}`) || `Reference ${index + 1}`).trim(),
      });
    }

    if (references.length === 0) {
      return NextResponse.json({ error: "Upload at least one reference image." }, { status: 400 });
    }

    if (!prompt) {
      return NextResponse.json({ error: "Describe the result you want first." }, { status: 400 });
    }

    const referenceGuide = references
      .map(({ role }, index) => `Image ${index}: ${role}.`)
      .join("\n");

    const preservationInstruction = preserveDesign
      ? "Follow the primary design reference closely. Preserve recognizable geometry, massing, proportions, floor relationships, openings and main architectural intent. Do not invent a completely different building."
      : "Use the references as creative direction. You may reinterpret secondary details while keeping the overall architectural idea coherent.";

    const architecturePrompt = [
      `Create a professional photorealistic ${renderType.toLowerCase()} architectural visualization.`,
      referenceGuide,
      "Use image 0 as the primary project reference. Use the other images only as supporting information for facade, materials, mood or style according to their labels.",
      preservationInstruction,
      "Treat plans, elevations and sketches as architectural information, not as decorative texture.",
      `Architectural style: ${style}.`,
      `User direction: ${prompt}`,
      "Use realistic materials, physically believable lighting, refined landscaping and premium architectural photography quality.",
      "Do not add labels, dimensions, logos, watermarks or written text."
    ].join("\n");

    const { width, height } = outputDimensions(ratio);
    const body = new FormData();
    body.append("prompt", architecturePrompt);

    references.forEach(({ file }, index) => {
      body.append(`input_image_${index}`, file, file.name || `reference-${index + 1}.jpg`);
    });

    body.append("width", String(width));
    body.append("height", String(height));
    body.append("guidance", preserveDesign ? "5" : "4.2");

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      accountId
    )}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body,
    });

    const responseType = response.headers.get("content-type") || "";

    if (!response.ok) {
      let message = "The AI render could not be created.";

      try {
        if (responseType.includes("application/json")) {
          const errorData = await response.json();
          message = cloudflareErrorMessage(errorData);
        } else {
          const text = await response.text();
          if (text.trim()) message = text.slice(0, 500);
        }
      } catch {
        // Keep the friendly fallback error above.
      }

      console.error("Cloudflare Workers AI error:", message);
      return NextResponse.json({ error: message }, { status: response.status });
    }

    if (responseType.startsWith("image/")) {
      const bytes = Buffer.from(await response.arrayBuffer());
      const mime = responseType.split(";")[0] || "image/png";
      return NextResponse.json({
        image: `data:${mime};base64,${bytes.toString("base64")}`,
        provider: "cloudflare",
      });
    }

    const data = await response.json();
    const result = data?.result ?? data;
    const encodedImage =
      result?.image ||
      result?.b64_json ||
      result?.data?.[0]?.b64_json ||
      result?.data?.[0]?.image ||
      null;

    if (!encodedImage || typeof encodedImage !== "string") {
      console.error("Unexpected Cloudflare Workers AI response:", data);
      return NextResponse.json({ error: "The AI returned no image." }, { status: 502 });
    }

    const imageUrl = encodedImage.startsWith("data:image/")
      ? encodedImage
      : `data:image/png;base64,${encodedImage}`;

    return NextResponse.json({ image: imageUrl, provider: "cloudflare" });
  } catch (error) {
    console.error("ArchiNova render error:", error);
    return NextResponse.json(
      { error: "Something went wrong while creating the render." },
      { status: 500 }
    );
  }
}
