import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

type Workflow = "plan-to-render" | "render-to-plan";
type Operation = "generate" | "edit";

function outputDimensions(ratio: string) {
  if (ratio === "1:1") return { width: 1024, height: 1024 };
  if (ratio === "4:3") return { width: 1024, height: 768 };
  return { width: 1024, height: 576 };
}

function cloudflareErrorMessage(data: unknown) {
  if (!data || typeof data !== "object") return "The AI image could not be created.";

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

  return "The AI image could not be created.";
}

function validateImage(file: File) {
  if (!allowedImageTypes.has(file.type)) return "Use PNG, JPG or WEBP images.";
  if (file.size > 8 * 1024 * 1024) return "Each image must be smaller than 8 MB.";
  return null;
}

function buildPlanToRenderPrompt(params: {
  operation: Operation;
  referenceGuide: string;
  prompt: string;
  revisionPrompt: string;
  style: string;
  renderType: string;
  preserveDesign: boolean;
}) {
  const { operation, referenceGuide, prompt, revisionPrompt, style, renderType, preserveDesign } = params;

  if (operation === "edit") {
    return [
      `Revise the current ${renderType.toLowerCase()} architectural render using the requested correction.`,
      "Image 0 is the current render and must be treated as the main visual to edit.",
      referenceGuide,
      "The remaining images are original project references and should be used to keep the revision grounded in the same building.",
      preserveDesign
        ? "Preserve the same building identity, massing, proportions, main openings, floor relationships and camera angle. Change only what the user requests unless a small supporting adjustment is necessary."
        : "Keep the building recognizable, but allow broader visual interpretation where the requested change requires it.",
      `Architectural style: ${style}.`,
      `Original design direction: ${prompt}`,
      `Requested correction: ${revisionPrompt}`,
      "Maintain realistic materials, believable lighting, coherent landscaping and professional architectural photography quality.",
      "Do not add labels, dimensions, logos, watermarks or written text."
    ].join("\n");
  }

  return [
    `Create a professional photorealistic ${renderType.toLowerCase()} architectural visualization.`,
    referenceGuide,
    "Use image 0 as the primary project reference. Use supporting images only for facade, materials, mood or design information according to their labels.",
    preserveDesign
      ? "Follow the primary architectural reference closely. Preserve recognizable geometry, massing, proportions, floor relationships, openings and main design intent. Do not invent a completely different building."
      : "Use the references as creative direction while keeping the overall architectural idea coherent.",
    "Treat floor plans, elevations and sketches as architectural information, not decorative texture.",
    `Architectural style: ${style}.`,
    `User direction: ${prompt}`,
    "Use realistic architectural materials, physically believable lighting, refined landscaping and premium architectural photography quality.",
    "Do not add labels, dimensions, logos, watermarks or written text."
  ].join("\n");
}

function buildRenderToPlanPrompt(params: {
  operation: Operation;
  referenceGuide: string;
  prompt: string;
  revisionPrompt: string;
  planStyle: string;
  planScope: string;
  preserveDesign: boolean;
}) {
  const { operation, referenceGuide, prompt, revisionPrompt, planStyle, planScope, preserveDesign } = params;

  const styleInstruction = planStyle === "Technical"
    ? "Use a clean technical architectural floor-plan style: crisp dark wall lines on a white background, orthographic top-down view, clear doors and window openings, restrained furniture symbols, no perspective and no decorative rendering."
    : "Use a polished conceptual floor-plan style: clean top-down orthographic layout, readable room zoning, subtle furniture and presentation-quality architectural graphics.";

  const scopeInstruction = planScope === "All floors"
    ? "If multiple floors are clearly implied, show separate floor plans in one image with clear spacing between them. Do not merge different floors into one layout."
    : `Focus on the ${planScope.toLowerCase()} only.`;

  if (operation === "edit") {
    return [
      "Revise the current architectural floor plan according to the requested correction.",
      "Image 0 is the current generated floor plan and is the main image to edit.",
      referenceGuide,
      "The remaining images are original 3D views of the same building and should be used only to keep the plan consistent with visible exterior or interior clues.",
      preserveDesign
        ? "Preserve the existing footprint, circulation logic, wall positions and unaffected rooms as much as possible. Apply only the requested layout changes."
        : "Keep the plan plausible but allow broader reorganization when needed to satisfy the requested revision.",
      styleInstruction,
      scopeInstruction,
      `Original layout direction: ${prompt}`,
      `Requested correction: ${revisionPrompt}`,
      "Keep the result as a true top-down 2D floor plan. Do not turn it into an isometric or perspective image.",
      "Avoid written room labels, dimensions, legends, logos and watermarks because text accuracy cannot be guaranteed."
    ].join("\n");
  }

  return [
    "Infer and generate a plausible architectural floor plan from the supplied 3D images of the same building.",
    referenceGuide,
    "Treat all supplied views as evidence of one building. Reconcile visible facade width, openings, entrances, room glimpses and circulation clues before inferring hidden spaces.",
    preserveDesign
      ? "Use conservative inference. Do not invent unnecessary rooms, corridors or extensions that are not supported by the images. Keep the inferred footprint close to the visible building mass."
      : "You may make reasonable architectural assumptions for hidden spaces while keeping the overall footprint and circulation believable.",
    styleInstruction,
    scopeInstruction,
    `User layout direction: ${prompt}`,
    "Create a coherent residential or architectural layout with believable wall thicknesses, doors, window openings and circulation.",
    "This is a conceptual reconstruction, not a measured CAD drawing. Do not imply exact dimensions that cannot be seen.",
    "Avoid written room labels, dimensions, legends, logos and watermarks because text accuracy cannot be guaranteed."
  ].join("\n");
}

export async function POST(request: Request) {
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return NextResponse.json(
        { error: "AI rendering is not configured yet. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in Vercel." },
        { status: 503 }
      );
    }

    const incoming = await request.formData();
    const operation = (String(incoming.get("operation") || "generate") === "edit" ? "edit" : "generate") as Operation;
    const workflow = (String(incoming.get("workflow") || "plan-to-render") === "render-to-plan" ? "render-to-plan" : "plan-to-render") as Workflow;
    const prompt = String(incoming.get("prompt") || "").trim();
    const revisionPrompt = String(incoming.get("revisionPrompt") || "").trim();
    const style = String(incoming.get("style") || "Modern").trim();
    const ratio = String(incoming.get("ratio") || (workflow === "render-to-plan" ? "4:3" : "16:9")).trim();
    const renderType = String(incoming.get("renderType") || "Exterior").trim();
    const planStyle = String(incoming.get("planStyle") || "Technical").trim();
    const planScope = String(incoming.get("planScope") || "Ground floor").trim();
    const preserveDesign = String(incoming.get("preserveDesign") || "true") === "true";

    const references: Array<{ file: File; role: string }> = [];

    for (let index = 0; index < 4; index += 1) {
      const candidate = incoming.get(`image_${index}`);
      if (!(candidate instanceof File) || candidate.size === 0) continue;

      const validation = validateImage(candidate);
      if (validation) return NextResponse.json({ error: validation }, { status: 400 });

      references.push({
        file: candidate,
        role: String(incoming.get(`role_${index}`) || `Reference ${index + 1}`).trim(),
      });
    }

    const currentResultCandidate = incoming.get("currentResult");
    const currentResult = currentResultCandidate instanceof File && currentResultCandidate.size > 0
      ? currentResultCandidate
      : null;

    if (currentResult) {
      const validation = validateImage(currentResult);
      if (validation) return NextResponse.json({ error: validation }, { status: 400 });
    }

    if (operation === "generate" && references.length === 0) {
      return NextResponse.json({ error: workflow === "render-to-plan" ? "Upload at least one 3D view." : "Upload at least one reference image." }, { status: 400 });
    }

    if (operation === "edit" && !currentResult) {
      return NextResponse.json({ error: "No current result was provided for editing." }, { status: 400 });
    }

    if (!prompt) {
      return NextResponse.json({ error: workflow === "render-to-plan" ? "Describe the layout you want first." : "Describe the result you want first." }, { status: 400 });
    }

    if (operation === "edit" && !revisionPrompt) {
      return NextResponse.json({ error: "Describe the correction you want first." }, { status: 400 });
    }

    const referenceGuide = references
      .slice(0, operation === "edit" ? 3 : 4)
      .map(({ role }, index) => `Supporting image ${operation === "edit" ? index + 1 : index}: ${role}.`)
      .join("\n");

    const aiPrompt = workflow === "render-to-plan"
      ? buildRenderToPlanPrompt({ operation, referenceGuide, prompt, revisionPrompt, planStyle, planScope, preserveDesign })
      : buildPlanToRenderPrompt({ operation, referenceGuide, prompt, revisionPrompt, style, renderType, preserveDesign });

    const { width, height } = outputDimensions(ratio);
    const body = new FormData();
    body.append("prompt", aiPrompt);

    let inputIndex = 0;

    if (operation === "edit" && currentResult) {
      body.append(`input_image_${inputIndex}`, currentResult, currentResult.name || "current-result.jpg");
      inputIndex += 1;
    }

    references.slice(0, 4 - inputIndex).forEach(({ file }) => {
      body.append(`input_image_${inputIndex}`, file, file.name || `reference-${inputIndex + 1}.jpg`);
      inputIndex += 1;
    });

    body.append("width", String(width));
    body.append("height", String(height));

    const guidance = workflow === "render-to-plan"
      ? preserveDesign ? "5.4" : "4.6"
      : preserveDesign ? "5" : "4.2";
    body.append("guidance", guidance);

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body,
    });

    const responseType = response.headers.get("content-type") || "";

    if (!response.ok) {
      let message = "The AI image could not be created.";

      try {
        if (responseType.includes("application/json")) {
          const errorData = await response.json();
          message = cloudflareErrorMessage(errorData);
        } else {
          const text = await response.text();
          if (text.trim()) message = text.slice(0, 500);
        }
      } catch {
        // Keep friendly fallback.
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
        workflow,
        operation,
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

    return NextResponse.json({ image: imageUrl, provider: "cloudflare", workflow, operation });
  } catch (error) {
    console.error("ArchiNova render error:", error);
    return NextResponse.json({ error: "Something went wrong while creating the AI image." }, { status: 500 });
  }
}
