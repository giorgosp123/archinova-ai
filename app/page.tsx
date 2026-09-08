"use client";

import Image from "next/image";
import { ChangeEvent, useMemo, useState } from "react";

type UploadedView = {
  id: string;
  file: File;
  preview: string;
};

type FinalResult = {
  image: string;
  report?: string;
  confidence?: string;
};

const floors = ["Ground floor", "First floor", "All visible floors"];
const planStyles = ["Technical", "Clean presentation"];
const accuracyModes = [
  { value: "inferred", label: "Full reconstruction", hint: "Infer the complete plan from all visible evidence" },
  { value: "strict", label: "Evidence only", hint: "Leave hidden areas unresolved" },
];

const sideOptions = [
  ["unknown", "Unknown / let AI decide"],
  ["front", "Front"],
  ["left", "Left"],
  ["right", "Right"],
  ["rear", "Rear / garden"],
] as const;

const yesNoOptions = [
  ["unknown", "Unknown / let AI decide"],
  ["yes", "Yes"],
  ["no", "No"],
] as const;

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

export default function Home() {
  const [views, setViews] = useState<UploadedView[]>([]);
  const [floor, setFloor] = useState("Ground floor");
  const [planStyle, setPlanStyle] = useState("Technical");
  const [accuracyMode, setAccuracyMode] = useState("inferred");
  const [knownDimension, setKnownDimension] = useState("");
  const [notes, setNotes] = useState("");
  const [architectFacts, setArchitectFacts] = useState<Record<string, string>>({
    mainEntranceSide: "unknown",
    parking: "unknown",
    staircase: "unknown",
    groundFloorWC: "unknown",
    kitchenSide: "unknown",
    livingSide: "unknown",
    outdoorDining: "unknown",
    outdoorSitting: "unknown",
    livingDiningPlan: "unknown",
  });
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<FinalResult | null>(null);

  const viewCount = views.length;
  const qualityText = useMemo(() => {
    if (viewCount === 0) return "Add 3D views to begin";
    if (viewCount === 1) return "1 view: limited geometry";
    if (viewCount <= 3) return `${viewCount} views: useful start`;
    if (viewCount <= 7) return `${viewCount} views: strong multi-view coverage`;
    return `${viewCount} views: detailed multi-view coverage`;
  }, [viewCount]);

  function updateFact(key: string, value: string) {
    setArchitectFacts((current) => ({ ...current, [key]: value }));
    setResult(null);
  }

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

    try {
      const batchSize = 6;
      const batchCount = Math.ceil(views.length / batchSize);
      let previousGeometry: Record<string, unknown> | null = null;
      let finalData: any = null;

      for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
        const start = batchIndex * batchSize;
        const batch = views.slice(start, start + batchSize);
        const end = start + batch.length;

        setProgress(
          batchCount === 1
            ? `Reading all ${views.length} views together`
            : `Reading views ${start + 1}–${end} of ${views.length} together`
        );

        const prepared = await Promise.all(
          batch.map((view, index) =>
            resizeImage(
              view.file,
              720,
              0.72,
              `archinova-multiview-${start + index + 1}.jpg`
            )
          )
        );

        const body = new FormData();
        prepared.forEach((file, index) => body.append(`image_${index}`, file));
        body.append("floor", floor);
        body.append("planStyle", planStyle);
        body.append("accuracyMode", accuracyMode);
        body.append("knownDimension", knownDimension.trim());
        body.append("notes", notes.trim());
        body.append("architectFacts", JSON.stringify(architectFacts));
        body.append("totalViews", String(views.length));
        body.append("batchIndex", String(batchIndex));
        body.append("batchCount", String(batchCount));
        if (previousGeometry) {
          body.append("previousGeometry", JSON.stringify(previousGeometry));
        }

        const response = await fetch("/api/reconstruct-project", {
          method: "POST",
          body,
        });
        const data = await response.json();

        if (!response.ok || !data?.image || !data?.geometry) {
          throw new Error(data?.error || "The building geometry could not be reconstructed.");
        }

        previousGeometry = data.geometry;
        finalData = data;
      }

      if (!finalData?.image) {
        throw new Error("The floor plan could not be created.");
      }

      setProgress("Drawing the final technical plan");
      setResult({
        image: finalData.image,
        report: finalData.report,
        confidence: finalData.confidence,
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
          <span className="eyebrow">Smart architectural reconstruction</span>
          <h1>3D views in. Architect-aware floor plan out.</h1>
          <p>
            ArchiNova reads several views together, locks the real shell first, then reconstructs circulation and spaces using openings, parking, entry, terraces and optional facts from the architect.
          </p>
        </div>
        <div className="hero-flow" aria-hidden="true">
          <div className="flow-card"><span>01</span><strong>3D views</strong></div>
          <div className="flow-arrow">→</div>
          <div className="flow-card"><span>02</span><strong>Shell + spaces</strong></div>
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
              Add front, rear, both sides, angled views, interior views, drone/top views, or screenshots from the 3D model. Views are read together in multi-view groups, not as unrelated photos.
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
            <p className="card-help">Only add facts you actually know. One real dimension is especially useful for keeping the proportions grounded.</p>

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
                placeholder="Example: driveway and main entrance are on the front facade, parking is on the left, large glazing opens to the rear garden..."
                rows={4}
              />
            </label>

            <div className="section-divider" />

            <div className="card-heading compact">
              <div><span className="step-number">3</span><h2>Smart architect facts</h2></div>
              <span className="optional-label">Optional</span>
            </div>
            <p className="card-help">Set only what you know. Leave anything else on “Unknown” and ArchiNova will infer it from the views.</p>

            <div className="field-grid">
              <label className="field">
                <span>Main entrance side</span>
                <select value={architectFacts.mainEntranceSide} onChange={(event) => updateFact("mainEntranceSide", event.target.value)}>
                  {sideOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Parking / carport</span>
                <select value={architectFacts.parking} onChange={(event) => updateFact("parking", event.target.value)}>
                  <option value="unknown">Unknown / let AI decide</option>
                  <option value="none">None</option>
                  <option value="1_car">1 car</option>
                  <option value="2_cars">2 cars</option>
                  <option value="3_plus_cars">3+ cars</option>
                </select>
              </label>

              <label className="field">
                <span>Staircase on this floor</span>
                <select value={architectFacts.staircase} onChange={(event) => updateFact("staircase", event.target.value)}>
                  {yesNoOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Ground-floor WC</span>
                <select value={architectFacts.groundFloorWC} onChange={(event) => updateFact("groundFloorWC", event.target.value)}>
                  {yesNoOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Kitchen side</span>
                <select value={architectFacts.kitchenSide} onChange={(event) => updateFact("kitchenSide", event.target.value)}>
                  {sideOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Main living side</span>
                <select value={architectFacts.livingSide} onChange={(event) => updateFact("livingSide", event.target.value)}>
                  {sideOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Outdoor dining</span>
                <select value={architectFacts.outdoorDining} onChange={(event) => updateFact("outdoorDining", event.target.value)}>
                  {yesNoOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Outdoor sitting</span>
                <select value={architectFacts.outdoorSitting} onChange={(event) => updateFact("outdoorSitting", event.target.value)}>
                  {yesNoOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Living / dining layout</span>
                <select value={architectFacts.livingDiningPlan} onChange={(event) => updateFact("livingDiningPlan", event.target.value)}>
                  <option value="unknown">Unknown / let AI decide</option>
                  <option value="open_plan">Open plan</option>
                  <option value="separated">Separated</option>
                </select>
              </label>
            </div>

            <div className="section-divider" />

            <div className="card-heading compact">
              <div><span className="step-number">4</span><h2>Reconstruction mode</h2></div>
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
              ArchiNova now reconstructs the shell first and locks it before inferring rooms. User-confirmed facts override architectural guesses.
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
                <p>{generating ? "The building shell and spaces are being reconstructed in separate passes." : "Add several views of the same project, then start the reconstruction."}</p>
              </div>
            ) : (
              <div className="result-content">
                <div className="floor-plan-image">
                  <Image src={result.image} alt="AI reconstructed architectural floor plan" fill unoptimized style={{ objectFit: "contain" }} />
                </div>
                <div className="result-actions">
                  <div><small>ARCHINOVA SMART ARCHITECT</small><strong>{planStyle} floor plan</strong></div>
                  <a className="download-action" href={result.image} download="archinova-reconstructed-floor-plan.svg">Download</a>
                </div>
                {result.report && (
                  <div className="evidence-report">
                    <span>Architecture report</span>
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
          <h2>Give ArchiNova enough evidence to think like an architect.</h2>
        </div>
        <div className="guide-grid">
          <article><span>01</span><strong>Front + rear</strong><p>Capture the complete width, entry, driveway and main openings.</p></article>
          <article><span>02</span><strong>Left + right</strong><p>Side views reveal depth, carports, projections and service zones.</p></article>
          <article><span>03</span><strong>Corner + elevated</strong><p>These connect every facade into one stepped shell.</p></article>
          <article><span>04</span><strong>Interior / cutaway</strong><p>These sharply improve kitchen, WC, stair and partition accuracy.</p></article>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-inner">
          <div className="brand footer-brand"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span className="brand-copy"><strong>ArchiNova</strong><small>AI</small></span></div>
          <p>Smart multi-view architectural reconstruction.</p>
          <span>© 2026 ArchiNova AI</span>
        </div>
      </footer>
    </main>
  );
}
