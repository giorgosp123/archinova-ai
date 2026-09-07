"use client";

import Image from "next/image";
import { ChangeEvent, useMemo, useState } from "react";

type UploadedView = {
  id: string;
  file: File;
  preview: string;
};

type AnalysisResult = {
  id: string;
  analysis: string;
};

type FinalResult = {
  image: string;
  report?: string;
  confidence?: string;
};

const floors = ["Ground floor", "First floor", "All visible floors"];
const planStyles = ["Technical", "Clean presentation"];
const accuracyModes = [
  { value: "strict", label: "Strict evidence", hint: "Do not invent hidden rooms" },
  { value: "inferred", label: "Full inferred plan", hint: "Fill hidden areas conservatively" },
];

async function resizeImage(file: File, maxSide: number, quality: number, name: string) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / bitmap.width, maxSide / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (!context) {
    bitmap.close();
    throw new Error("Could not prepare one of the images.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });

  if (!blob) throw new Error("Could not prepare one of the images.");

  return new File([blob], name, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

async function analyzeWithConcurrency(
  views: UploadedView[],
  onProgress: (done: number, total: number) => void
) {
  const results: AnalysisResult[] = new Array(views.length);
  let cursor = 0;
  let completed = 0;
  const workers = Math.min(2, views.length);

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= views.length) return;

      const prepared = await resizeImage(
        views[index].file,
        900,
        0.8,
        `archinova-analysis-${index + 1}.jpg`
      );

      const body = new FormData();
      body.append("image", prepared);
      body.append("viewIndex", String(index + 1));
      body.append("totalViews", String(views.length));

      const response = await fetch("/api/analyze-view", {
        method: "POST",
        body,
      });
      const data = await response.json();

      if (!response.ok || !data?.analysis) {
        throw new Error(data?.error || `View ${index + 1} could not be analyzed.`);
      }

      results[index] = { id: views[index].id, analysis: data.analysis };
      completed += 1;
      onProgress(completed, views.length);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export default function Home() {
  const [views, setViews] = useState<UploadedView[]>([]);
  const [floor, setFloor] = useState("Ground floor");
  const [planStyle, setPlanStyle] = useState("Technical");
  const [accuracyMode, setAccuracyMode] = useState("strict");
  const [knownDimension, setKnownDimension] = useState("");
  const [notes, setNotes] = useState("");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<FinalResult | null>(null);

  const viewCount = views.length;
  const qualityText = useMemo(() => {
    if (viewCount === 0) return "Add 3D views to begin";
    if (viewCount === 1) return "1 view: limited geometry";
    if (viewCount <= 3) return `${viewCount} views: useful start`;
    if (viewCount <= 7) return `${viewCount} views: strong coverage`;
    return `${viewCount} views: detailed coverage`;
  }, [viewCount]);

  function addViews(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files || []).filter((file) =>
      ["image/png", "image/jpeg", "image/webp"].includes(file.type)
    );

    if (!selected.length) return;

    const additions = selected.map((file) => ({
      id: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
    }));

    setViews((current) => [...current, ...additions]);
    setResult(null);
    setError("");
    event.target.value = "";
  }

  function removeView(id: string) {
    setViews((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((item) => item.id !== id);
    });
    setResult(null);
    setError("");
  }

  function clearViews() {
    views.forEach((view) => URL.revokeObjectURL(view.preview));
    setViews([]);
    setResult(null);
    setError("");
  }

  async function generateFloorPlan() {
    if (!views.length) return;

    setGenerating(true);
    setResult(null);
    setError("");
    setProgress(`Analyzing 0 of ${views.length} views`);

    try {
      const analyses = await analyzeWithConcurrency(views, (done, total) => {
        setProgress(`Analyzing ${done} of ${total} views`);
      });

      setProgress("Combining geometry from all views");

      const finalBody = new FormData();
      finalBody.append("analyses", JSON.stringify(analyses.map((item, index) => ({
        view: index + 1,
        analysis: item.analysis,
      }))));
      finalBody.append("floor", floor);
      finalBody.append("planStyle", planStyle);
      finalBody.append("accuracyMode", accuracyMode);
      finalBody.append("knownDimension", knownDimension.trim());
      finalBody.append("notes", notes.trim());
      finalBody.append("viewCount", String(views.length));

      // The vision stage uses every uploaded image. FLUX accepts up to four visual references,
      // so the first four views are also attached to anchor the final drawing visually.
      const anchors = views.slice(0, 4);
      const preparedAnchors = await Promise.all(
        anchors.map((view, index) =>
          resizeImage(view.file, 500, 0.9, `archinova-anchor-${index + 1}.jpg`)
        )
      );
      preparedAnchors.forEach((file, index) => finalBody.append(`image_${index}`, file));

      setProgress("Drawing the floor plan");
      const response = await fetch("/api/floor-plan", {
        method: "POST",
        body: finalBody,
      });
      const data = await response.json();

      if (!response.ok || !data?.image) {
        throw new Error(data?.error || "The floor plan could not be created.");
      }

      setResult({
        image: data.image,
        report: data.report,
        confidence: data.confidence,
      });
      setProgress("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong while reconstructing the floor plan.");
      setProgress("");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#top" aria-label="ArchiNova AI home">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span className="brand-copy"><strong>ArchiNova</strong><small>AI</small></span>
          </a>
          <span className="focus-pill">3D → FLOOR PLAN</span>
        </div>
      </header>

      <section className="focused-hero" id="top">
        <div>
          <span className="eyebrow">Architectural reconstruction</span>
          <h1>3D views in. Floor plan out.</h1>
          <p>
            Built specifically to reconstruct a building plan from multiple 3D views. ArchiNova analyzes every image first, compares the visible geometry, then creates one consistent top-down plan.
          </p>
        </div>
        <div className="hero-flow" aria-hidden="true">
          <div className="flow-card"><span>01</span><strong>3D views</strong></div>
          <div className="flow-arrow">→</div>
          <div className="flow-card"><span>02</span><strong>Geometry analysis</strong></div>
          <div className="flow-arrow">→</div>
          <div className="flow-card accent-card"><span>03</span><strong>Floor plan</strong></div>
        </div>
      </section>

      <section className="reconstruction-shell">
        <div className="reconstruction-grid">
          <div className="input-card">
            <div className="card-heading">
              <div><span className="step-number">1</span><h2>Add every useful 3D view</h2></div>
              <strong>{viewCount} images</strong>
            </div>
            <p className="card-help">
              Add front, rear, both sides, angled views, interior views, drone/top views, or screenshots from the 3D model. There is no four-image slot limit in this workspace.
            </p>

            <label className="multi-upload">
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={addViews} hidden />
              <span className="upload-plus">+</span>
              <span><strong>Add 3D images</strong><small>Select several at once or keep adding more</small></span>
            </label>

            {viewCount > 0 && (
              <>
                <div className="coverage-row">
                  <span>{qualityText}</span>
                  <button type="button" onClick={clearViews}>Clear all</button>
                </div>
                <div className="view-gallery">
                  {views.map((view, index) => (
                    <article className="view-thumb" key={view.id}>
                      <div className="view-image" style={{ backgroundImage: `url(${view.preview})` }}>
                        <span>{index + 1}</span>
                        <button type="button" onClick={() => removeView(view.id)} aria-label={`Remove image ${index + 1}`}>×</button>
                      </div>
                      <small>{view.file.name}</small>
                    </article>
                  ))}
                </div>
              </>
            )}

            <div className="section-divider" />

            <div className="card-heading compact">
              <div><span className="step-number">2</span><h2>Known project facts</h2></div>
              <span className="optional-label">Optional</span>
            </div>
            <p className="card-help">Only add facts you actually know. They help scale and resolve hidden geometry without guessing.</p>

            <div className="field-grid">
              <label className="field">
                <span>Floor to reconstruct</span>
                <select value={floor} onChange={(event) => setFloor(event.target.value)}>
                  {floors.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Known dimension</span>
                <input
                  value={knownDimension}
                  onChange={(event) => setKnownDimension(event.target.value)}
                  placeholder="e.g. front wall = 12.4 m"
                />
              </label>
            </div>

            <label className="field full-field">
              <span>Architect notes</span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Example: main entrance is on the south facade, staircase is visible behind the large front window..."
                rows={4}
              />
            </label>

            <div className="section-divider" />

            <div className="card-heading compact">
              <div><span className="step-number">3</span><h2>Accuracy settings</h2></div>
            </div>

            <div className="accuracy-grid">
              {accuracyModes.map((mode) => (
                <button
                  type="button"
                  key={mode.value}
                  className={accuracyMode === mode.value ? "accuracy-option active" : "accuracy-option"}
                  onClick={() => setAccuracyMode(mode.value)}
                >
                  <strong>{mode.label}</strong>
                  <small>{mode.hint}</small>
                </button>
              ))}
            </div>

            <div className="style-row">
              <span>Drawing style</span>
              <div>
                {planStyles.map((item) => (
                  <button
                    type="button"
                    key={item}
                    className={planStyle === item ? "active" : ""}
                    onClick={() => setPlanStyle(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            {error && <div className="error-box" role="alert">{error}</div>}

            <button
              type="button"
              className="generate-floor-plan"
              onClick={generateFloorPlan}
              disabled={generating || viewCount === 0}
            >
              {generating ? <><span className="spinner" /> {progress || "Working..."}</> : <>Reconstruct floor plan <span>✦</span></>}
            </button>

            <p className="accuracy-disclaimer">
              Accuracy improves with coverage. Hidden interior walls cannot be proven from exterior-only images, so Strict evidence mode leaves unsupported geometry unresolved instead of fabricating it.
            </p>
          </div>

          <aside className="result-card focused-result">
            <div className="result-header">
              <div><span className="status-dot" /><strong>Floor plan reconstruction</strong></div>
              {result?.confidence && <span className="confidence-pill">{result.confidence}</span>}
            </div>

            {!result ? (
              <div className={generating ? "result-empty active" : "result-empty"}>
                <div className="plan-placeholder">
                  <span className="ph-wall a" /><span className="ph-wall b" /><span className="ph-wall c" /><span className="ph-wall d" />
                </div>
                <strong>{generating ? progress : "Your reconstructed plan will appear here"}</strong>
                <p>{generating ? "Every uploaded view is being checked before the plan is drawn." : "Add as many useful views as you have, then start the reconstruction."}</p>
              </div>
            ) : (
              <div className="result-content">
                <div className="floor-plan-image">
                  <Image src={result.image} alt="AI reconstructed architectural floor plan" fill unoptimized style={{ objectFit: "contain" }} />
                </div>
                <div className="result-actions">
                  <div><small>ARCHINOVA RECONSTRUCTION</small><strong>{planStyle} floor plan</strong></div>
                  <a className="download-action" href={result.image} download="archinova-reconstructed-floor-plan.png">Download</a>
                </div>
                {result.report && (
                  <div className="evidence-report">
                    <span>Geometry report</span>
                    <p>{result.report}</p>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      </section>

      <section className="capture-guide">
        <div>
          <span className="eyebrow">Best capture set</span>
          <h2>Show the building, not just the pretty angles.</h2>
        </div>
        <div className="guide-grid">
          <article><span>01</span><strong>Front + rear</strong><p>Capture the complete width and all visible openings.</p></article>
          <article><span>02</span><strong>Left + right</strong><p>Side views reveal depth, projections and setbacks.</p></article>
          <article><span>03</span><strong>Angles + top views</strong><p>Corner or elevated views connect the facades into one footprint.</p></article>
          <article><span>04</span><strong>Interior evidence</strong><p>Use interior or cutaway views when you need internal walls reconstructed.</p></article>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-inner">
          <div className="brand footer-brand"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span className="brand-copy"><strong>ArchiNova</strong><small>AI</small></span></div>
          <p>3D to floor plan reconstruction.</p>
          <span>© 2026 ArchiNova AI</span>
        </div>
      </footer>
    </main>
  );
}
