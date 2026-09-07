"use client";

import Image from "next/image";
import { ChangeEvent, useMemo, useState } from "react";

type Workflow = "plan-to-render" | "render-to-plan";
type Version = { id: string; image: string; label: string; note: string };

const styles = ["Modern", "Minimal", "Mediterranean", "Luxury", "Industrial", "Scandinavian"];
const ratios = ["16:9", "4:3", "1:1"];
const renderTypes = ["Exterior", "Interior", "Concept"];
const planStyles = ["Technical", "Concept"];
const planScopes = ["Ground floor", "First floor", "All floors"];

const referenceSlots: Record<Workflow, Array<{ label: string; hint: string; required: boolean }>> = {
  "plan-to-render": [
    { label: "Main design", hint: "Floor plan, elevation or sketch", required: true },
    { label: "Facade", hint: "Elevation or exterior reference", required: false },
    { label: "Style", hint: "Materials, mood or inspiration", required: false },
    { label: "Extra", hint: "Any useful project reference", required: false },
  ],
  "render-to-plan": [
    { label: "Main 3D view", hint: "Main exterior or interior image", required: true },
    { label: "Second view", hint: "Another angle of the same building", required: false },
    { label: "Side / interior", hint: "A view that reveals more layout", required: false },
    { label: "Extra", hint: "Any useful additional angle", required: false },
  ],
};

const promptExamples: Record<Workflow, string[]> = {
  "plan-to-render": [
    "Modern villa with natural stone, warm wood, large glass openings and soft sunset light.",
    "Minimal white residence with a calm garden, pool, clean concrete details and bright daylight.",
    "Luxury Mediterranean home with textured stone, warm plaster, arches and refined landscaping.",
  ],
  "render-to-plan": [
    "Infer a practical residential layout from these views. Keep circulation simple and room proportions believable.",
    "Create a clean floor plan that follows the visible building shape, openings and entrance position as closely as possible.",
    "Use the supplied 3D views as one building. Infer only plausible hidden spaces and avoid unnecessary rooms.",
  ],
};

const revisionPresets: Record<Workflow, string[]> = {
  "plan-to-render": [
    "Use warmer materials",
    "Make the facade more minimal",
    "Increase the glass openings",
    "Reduce the landscaping",
    "Change lighting to daylight",
    "Add refined luxury details",
  ],
  "render-to-plan": [
    "Make the living area larger",
    "Use a more open-plan kitchen",
    "Simplify the circulation",
    "Reduce unnecessary rooms",
    "Improve the entrance layout",
    "Keep the exterior footprint unchanged",
  ],
};

async function prepareReferenceImage(file: File, index: number) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 500;
  const scale = Math.min(1, maxSide / bitmap.width, maxSide / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Could not prepare the reference image.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.92);
  });

  if (!blob) throw new Error("Could not prepare the reference image.");

  return new File([blob], `archinova-reference-${index + 1}.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

async function prepareGeneratedImage(dataUrl: string) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const file = new File([blob], "archinova-current-result.png", {
    type: blob.type || "image/png",
    lastModified: Date.now(),
  });
  return prepareReferenceImage(file, 9);
}

export default function Home() {
  const [workflow, setWorkflow] = useState<Workflow>("plan-to-render");
  const [files, setFiles] = useState<Array<File | null>>([null, null, null, null]);
  const [previews, setPreviews] = useState<string[]>(["", "", "", ""]);
  const [prompt, setPrompt] = useState(promptExamples["plan-to-render"][0]);
  const [style, setStyle] = useState("Modern");
  const [ratio, setRatio] = useState("16:9");
  const [renderType, setRenderType] = useState("Exterior");
  const [planStyle, setPlanStyle] = useState("Technical");
  const [planScope, setPlanScope] = useState("Ground floor");
  const [preserveDesign, setPreserveDesign] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [resultUrl, setResultUrl] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [revisionPrompt, setRevisionPrompt] = useState("");
  const [error, setError] = useState("");

  const promptCount = useMemo(() => prompt.trim().length, [prompt]);
  const referenceCount = files.filter(Boolean).length;
  const slots = referenceSlots[workflow];
  const examples = promptExamples[workflow];
  const isPlanMode = workflow === "render-to-plan";

  function clearProjectState() {
    setResultUrl("");
    setVersions([]);
    setSelectedVersionId(null);
    setRevisionPrompt("");
    setError("");
  }

  function changeWorkflow(next: Workflow) {
    if (next === workflow) return;

    previews.forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });

    setWorkflow(next);
    setFiles([null, null, null, null]);
    setPreviews(["", "", "", ""]);
    setPrompt(promptExamples[next][0]);
    setRatio(next === "render-to-plan" ? "4:3" : "16:9");
    clearProjectState();
  }

  function handleReference(index: number, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setFiles((current) => {
      const next = [...current];
      next[index] = file;
      return next;
    });

    setPreviews((current) => {
      const next = [...current];
      if (next[index]) URL.revokeObjectURL(next[index]);
      next[index] = URL.createObjectURL(file);
      return next;
    });

    clearProjectState();
  }

  function removeReference(index: number) {
    setFiles((current) => {
      const next = [...current];
      next[index] = null;
      return next;
    });

    setPreviews((current) => {
      const next = [...current];
      if (next[index]) URL.revokeObjectURL(next[index]);
      next[index] = "";
      return next;
    });

    clearProjectState();
  }

  async function appendPreparedReferences(body: FormData) {
    const chosen = files
      .map((file, slotIndex) => ({ file, slotIndex }))
      .filter((item): item is { file: File; slotIndex: number } => item.file instanceof File);

    const prepared = await Promise.all(
      chosen.map(({ file }, index) => prepareReferenceImage(file, index))
    );

    prepared.forEach((file, index) => {
      const slotIndex = chosen[index].slotIndex;
      body.append(`image_${index}`, file);
      body.append(`role_${index}`, slots[slotIndex].label);
    });
  }

  function addVersion(image: string, note: string) {
    const versionNumber = versions.length + 1;
    const version: Version = {
      id: crypto.randomUUID(),
      image,
      label: `V${versionNumber}`,
      note,
    };

    setVersions((current) => [...current, version]);
    setSelectedVersionId(version.id);
    setResultUrl(image);
  }

  async function generateProject() {
    if (!files[0] || !prompt.trim()) return;

    setGenerating(true);
    setError("");

    try {
      const body = new FormData();
      await appendPreparedReferences(body);

      body.append("operation", "generate");
      body.append("workflow", workflow);
      body.append("prompt", prompt.trim());
      body.append("style", style);
      body.append("ratio", ratio);
      body.append("renderType", renderType);
      body.append("planStyle", planStyle);
      body.append("planScope", planScope);
      body.append("preserveDesign", String(preserveDesign));

      const response = await fetch("/api/render", { method: "POST", body });
      const data = await response.json();

      if (!response.ok || !data?.image) {
        throw new Error(data?.error || "The image could not be created.");
      }

      addVersion(
        data.image,
        versions.length === 0
          ? isPlanMode ? "Initial floor plan" : "Initial render"
          : "New alternative"
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong while creating the image.");
    } finally {
      setGenerating(false);
    }
  }

  async function applyRevision() {
    if (!resultUrl || !revisionPrompt.trim()) return;

    setEditing(true);
    setError("");

    try {
      const body = new FormData();
      const currentResult = await prepareGeneratedImage(resultUrl);
      body.append("currentResult", currentResult);
      await appendPreparedReferences(body);

      body.append("operation", "edit");
      body.append("workflow", workflow);
      body.append("prompt", prompt.trim());
      body.append("revisionPrompt", revisionPrompt.trim());
      body.append("style", style);
      body.append("ratio", ratio);
      body.append("renderType", renderType);
      body.append("planStyle", planStyle);
      body.append("planScope", planScope);
      body.append("preserveDesign", String(preserveDesign));

      const response = await fetch("/api/render", { method: "POST", body });
      const data = await response.json();

      if (!response.ok || !data?.image) {
        throw new Error(data?.error || "The revision could not be created.");
      }

      addVersion(data.image, revisionPrompt.trim());
      setRevisionPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong while applying the revision.");
    } finally {
      setEditing(false);
    }
  }

  function selectVersion(version: Version) {
    setSelectedVersionId(version.id);
    setResultUrl(version.image);
    setRevisionPrompt("");
  }

  const outputTitle = isPlanMode ? `${planStyle} floor plan` : `${style} ${renderType.toLowerCase()}`;
  const downloadName = isPlanMode
    ? `archinova-${planStyle.toLowerCase()}-floor-plan.png`
    : `archinova-${style.toLowerCase()}-${renderType.toLowerCase()}.png`;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#top" aria-label="ArchiNova AI home">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span className="brand-copy"><strong>ArchiNova</strong><small>AI</small></span>
          </a>
          <a className="topbar-action" href="#studio">Open Studio</a>
        </div>
      </header>

      <section className="intro" id="top">
        <div className="intro-copy">
          <span className="eyebrow">AI architectural workspace</span>
          <h1>Design in both directions.</h1>
          <p>Turn plans into architectural visuals, or turn 3D views into a clean conceptual floor plan. Then refine the result version by version.</p>
          <div className="intro-actions">
            <a className="primary-action" href="#studio">Start a project</a>
            <span className="intro-note">Plan ↔ Render</span>
          </div>
        </div>
        <div className="intro-card" aria-hidden="true">
          <div className="intro-grid" />
          <div className="intro-plan"><span className="plan-line line-a" /><span className="plan-line line-b" /><span className="plan-line line-c" /><span className="plan-line line-d" /></div>
          <div className="intro-arrow">↔</div>
          <div className="intro-building"><span className="building-window bw-a" /><span className="building-window bw-b" /></div>
          <span className="intro-badge">Plan ↔ Render ↔ Refine</span>
        </div>
      </section>

      <section className="studio" id="studio">
        <div className="studio-head">
          <div>
            <span className="eyebrow light">ArchiNova Studio V4</span>
            <h2>Your architectural workspace</h2>
          </div>
          <p>Choose the direction first. The controls change automatically to keep the workflow simple.</p>
        </div>

        <div className="workflow-switch" aria-label="Choose ArchiNova workflow">
          <button type="button" className={workflow === "plan-to-render" ? "active" : ""} onClick={() => changeWorkflow("plan-to-render")}>
            <span className="workflow-icon">▦</span>
            <span><strong>Plan → Render</strong><small>Turn a plan or sketch into a visual</small></span>
          </button>
          <button type="button" className={workflow === "render-to-plan" ? "active" : ""} onClick={() => changeWorkflow("render-to-plan")}>
            <span className="workflow-icon">⌂</span>
            <span><strong>Render → Plan</strong><small>Infer a floor plan from 3D views</small></span>
          </button>
        </div>

        {isPlanMode && (
          <div className="accuracy-note">
            <strong>Conceptual reconstruction</strong>
            <span>3D images do not reveal every hidden wall or exact measurement. For better results, add 2–4 views of the same building.</span>
          </div>
        )}

        <div className="workspace">
          <div className="controls-card">
            <section className="control-section">
              <div className="section-row">
                <div><span className="step-pill">1</span><h3>{isPlanMode ? "Add 3D views" : "Add references"}</h3></div>
                <span className="section-meta">{referenceCount}/4 added</span>
              </div>
              <p className="section-help">
                {isPlanMode
                  ? "Use different angles of the same building so ArchiNova can infer the layout more reliably."
                  : "Start with the main plan, elevation or sketch. Add supporting references only when useful."}
              </p>

              <div className="reference-grid">
                {slots.map((slot, index) => (
                  <div className={`reference-slot ${files[index] ? "filled" : ""}`} key={slot.label}>
                    <label className="reference-upload">
                      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleReference(index, event)} hidden />
                      {previews[index] ? (
                        <span className="reference-preview" style={{ backgroundImage: `url(${previews[index]})` }} />
                      ) : (
                        <span className="reference-plus">+</span>
                      )}
                      <span className="reference-copy">
                        <strong>{slot.label}{slot.required ? " *" : ""}</strong>
                        <small>{files[index]?.name || slot.hint}</small>
                      </span>
                    </label>
                    {files[index] && (
                      <button className="remove-reference" type="button" onClick={() => removeReference(index)} aria-label={`Remove ${slot.label}`}>×</button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="control-section">
              <div className="section-row">
                <div><span className="step-pill">2</span><h3>{isPlanMode ? "Describe the layout" : "Describe the result"}</h3></div>
                <span className="section-meta">{promptCount} chars</span>
              </div>

              <textarea
                className="prompt-box"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={isPlanMode ? "Example: open-plan kitchen, 3 bedrooms, simple circulation..." : "Materials, atmosphere, lighting, landscape..."}
                rows={5}
              />

              <div className="example-row">
                {examples.map((example, index) => (
                  <button key={example} type="button" onClick={() => setPrompt(example)}>Example {index + 1}</button>
                ))}
              </div>
            </section>

            <section className="control-section compact-section">
              <div className="section-row"><div><span className="step-pill">3</span><h3>{isPlanMode ? "Choose the plan output" : "Choose the look"}</h3></div></div>

              {isPlanMode ? (
                <>
                  <label className="field-label">Floor plan style</label>
                  <div className="segmented-row">
                    {planStyles.map((item) => (
                      <button type="button" key={item} className={planStyle === item ? "active" : ""} onClick={() => setPlanStyle(item)}>{item}</button>
                    ))}
                  </div>

                  <label className="field-label">Plan scope</label>
                  <div className="segmented-row three plan-scope-row">
                    {planScopes.map((item) => (
                      <button type="button" key={item} className={planScope === item ? "active" : ""} onClick={() => setPlanScope(item)}>{item}</button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <label className="field-label">Render type</label>
                  <div className="segmented-row three">
                    {renderTypes.map((item) => (
                      <button type="button" key={item} className={renderType === item ? "active" : ""} onClick={() => setRenderType(item)}>{item}</button>
                    ))}
                  </div>

                  <label className="field-label">Style</label>
                  <div className="style-grid">
                    {styles.map((item) => (
                      <button type="button" key={item} className={style === item ? "active" : ""} onClick={() => setStyle(item)}>{item}</button>
                    ))}
                  </div>
                </>
              )}

              <div className="settings-row">
                <div className="setting-block">
                  <label className="field-label">Format</label>
                  <div className="segmented-row">
                    {ratios.map((item) => (
                      <button type="button" key={item} className={ratio === item ? "active" : ""} onClick={() => setRatio(item)}>{item}</button>
                    ))}
                  </div>
                </div>

                <label className="preserve-toggle">
                  <span>
                    <strong>{isPlanMode ? "Conservative inference" : "Preserve design"}</strong>
                    <small>{isPlanMode ? "Avoid inventing unnecessary spaces" : "Keep geometry and identity closer"}</small>
                  </span>
                  <input type="checkbox" checked={preserveDesign} onChange={(event) => setPreserveDesign(event.target.checked)} />
                  <i aria-hidden="true" />
                </label>
              </div>
            </section>

            {error && <div className="error-box" role="alert">{error}</div>}

            <button type="button" className="generate-button" onClick={generateProject} disabled={generating || editing || !files[0] || !prompt.trim()}>
              {generating ? <><span className="spinner" /> {isPlanMode ? "Building floor plan..." : "Creating your render..."}</> : <>{isPlanMode ? "Generate floor plan" : "Generate render"} <span>✦</span></>}
            </button>
            {!files[0] && <p className="button-hint">Add your main {isPlanMode ? "3D view" : "design reference"} to start.</p>}
          </div>

          <div className="result-card professional-result">
            <div className="result-bar">
              <div><span className="status-dot" /><strong>{isPlanMode ? "Plan review" : "Design review"}</strong></div>
              <span>{ratio} · {isPlanMode ? planStyle : style}</span>
            </div>

            {!resultUrl ? (
              <div className={`result-empty ${generating ? "is-loading" : ""}`}>
                <div className="empty-icon">✦</div>
                <strong>{generating ? (isPlanMode ? "Reconstructing the plan" : "Creating your image") : (isPlanMode ? "Your floor plan will appear here" : "Your project starts here")}</strong>
                <p>{generating ? "Keep this page open for a moment." : (isPlanMode ? "Add 3D views, describe the layout, then generate." : "Generate a render, then ask ArchiNova for corrections and revisions.")}</p>
              </div>
            ) : (
              <div className="result-content">
                <div className="result-image-wrap" style={{ aspectRatio: ratio === "1:1" ? "1 / 1" : ratio === "4:3" ? "4 / 3" : "16 / 9" }}>
                  {selectedVersionId && <span className="version-badge">{versions.find((version) => version.id === selectedVersionId)?.label}</span>}
                  <Image src={resultUrl} alt={isPlanMode ? "AI generated architectural floor plan" : `${style} ${renderType.toLowerCase()} architectural AI render`} fill unoptimized style={{ objectFit: "contain" }} />
                </div>

                <div className="result-actions">
                  <div><small>ARCHINOVA AI</small><strong>{outputTitle}</strong></div>
                  <div className="result-buttons">
                    <button type="button" className="secondary-action" onClick={generateProject} disabled={generating || editing}>New alternative</button>
                    <a href={resultUrl} download={downloadName} className="download-action">Download</a>
                  </div>
                </div>

                <div className="revision-panel">
                  <div className="revision-heading">
                    <div><span className="revision-kicker">AI REVISION</span><h3>{isPlanMode ? "What should change in this plan?" : "What should change in this render?"}</h3></div>
                    <span className={`preserve-status ${preserveDesign ? "on" : ""}`}>{preserveDesign ? (isPlanMode ? "Conservative" : "Preserve ON") : "Creative"}</span>
                  </div>

                  <textarea
                    className="revision-input"
                    value={revisionPrompt}
                    onChange={(event) => setRevisionPrompt(event.target.value)}
                    placeholder={isPlanMode ? "Example: make the living room larger, keep the exterior footprint, use an open-plan kitchen..." : "Example: keep the same house and camera angle, make the stone darker and reduce the landscaping..."}
                    rows={4}
                  />

                  <div className="revision-chips">
                    {revisionPresets[workflow].map((item) => (
                      <button type="button" key={item} onClick={() => setRevisionPrompt(item)}>{item}</button>
                    ))}
                  </div>

                  <button type="button" className="apply-revision" onClick={applyRevision} disabled={editing || generating || !revisionPrompt.trim()}>
                    {editing ? <><span className="spinner dark-spinner" /> Applying changes...</> : <>Apply changes <span>✦</span></>}
                  </button>
                  <p className="revision-note">{isPlanMode ? "Each correction creates a new plan version. The result remains conceptual unless verified with measured drawings." : "Each correction creates a new version. Earlier versions stay available below."}</p>
                </div>

                {versions.length > 0 && (
                  <div className="version-history">
                    <div className="history-heading"><div><span className="revision-kicker">PROJECT HISTORY</span><h3>Versions</h3></div><span>{versions.length} saved this session</span></div>
                    <div className="version-strip">
                      {versions.map((version) => (
                        <button type="button" key={version.id} className={`version-card ${selectedVersionId === version.id ? "active" : ""}`} onClick={() => selectVersion(version)}>
                          <span className="version-thumb"><Image src={version.image} alt={version.label} fill unoptimized style={{ objectFit: "cover" }} /></span>
                          <span className="version-copy"><strong>{version.label}</strong><small>{version.note}</small></span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="tips-section">
        <div className="tips-copy"><span className="eyebrow">Two-way workflow</span><h2>Move between plans and visuals without starting over.</h2></div>
        <div className="tips-grid">
          <div><span>01</span><strong>Plan → Render</strong><p>Use plans, elevations and style references to create a presentation-ready architectural visual.</p></div>
          <div><span>02</span><strong>Render → Plan</strong><p>Use multiple 3D views to infer a clean conceptual top-down layout of the same building.</p></div>
          <div><span>03</span><strong>Refine every result</strong><p>Give corrections in plain language and keep each version available during the design session.</p></div>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-inner">
          <div className="brand footer-brand"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span className="brand-copy"><strong>ArchiNova</strong><small>AI</small></span></div>
          <p>From plan to vision.</p><span>© 2026 ArchiNova AI</span>
        </div>
      </footer>

      <style>{`
        .workflow-switch{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 14px}.workflow-switch button{min-height:86px;display:flex;align-items:center;gap:13px;padding:16px;border:1px solid rgba(255,255,255,.11);border-radius:18px;background:#141c17;color:#fff;text-align:left;cursor:pointer}.workflow-switch button.active{border-color:rgba(183,255,90,.55);background:#1a251e;box-shadow:0 0 0 2px rgba(183,255,90,.06)}.workflow-switch button>span:last-child{display:grid;gap:4px}.workflow-switch strong{font-size:14px}.workflow-switch small{color:#849089;font-size:10px;line-height:1.4}.workflow-icon{width:40px;height:40px;display:grid;place-items:center;flex:0 0 40px;border-radius:12px;background:rgba(183,255,90,.1);color:#b7ff5a;font-size:20px}.accuracy-note{display:flex;gap:12px;align-items:center;margin:0 0 16px;padding:12px 14px;border:1px solid rgba(183,255,90,.15);border-radius:14px;background:rgba(183,255,90,.055);color:#aeb8b2;font-size:11px;line-height:1.45}.accuracy-note strong{color:#dce5df;white-space:nowrap}.plan-scope-row button{font-size:10px}.professional-result{min-width:0}.version-badge{position:absolute;top:14px;left:14px;z-index:2;padding:7px 10px;border-radius:999px;background:rgba(12,17,14,.78);color:#fff;font-size:11px;font-weight:800;backdrop-filter:blur(10px)}.revision-panel{margin:0 16px 16px;padding:18px;border:1px solid rgba(255,255,255,.1);border-radius:18px;background:#111814}.revision-heading,.history-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.revision-heading h3,.history-heading h3{margin:4px 0 0;color:#fff;font-size:16px}.revision-kicker{color:#8d9992;font-size:9px;font-weight:850;letter-spacing:.13em;text-transform:uppercase}.preserve-status{padding:6px 9px;border-radius:999px;background:rgba(255,255,255,.06);color:#89948e;font-size:10px;font-weight:800;white-space:nowrap}.preserve-status.on{background:rgba(183,255,90,.1);color:#b7ff5a}.revision-input{width:100%;min-height:104px;margin-top:14px;padding:14px;resize:vertical;border:1px solid rgba(255,255,255,.13);border-radius:14px;outline:none;background:#18211c;color:#fff;line-height:1.5}.revision-input:focus{border-color:rgba(183,255,90,.45);box-shadow:0 0 0 3px rgba(183,255,90,.06)}.revision-input::placeholder{color:#68736d}.revision-chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}.revision-chips button{border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:7px 10px;background:#1c2721;color:#aab4ae;font-size:10px;cursor:pointer}.revision-chips button:hover{border-color:rgba(183,255,90,.3);color:#d7e0da}.apply-revision{width:100%;min-height:46px;margin-top:14px;border:0;border-radius:999px;background:#b7ff5a;color:#101512;font-weight:850;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px}.apply-revision:disabled{opacity:.42;cursor:not-allowed}.revision-note{margin:9px 0 0;color:#727e77;font-size:10px;line-height:1.45;text-align:center}.version-history{margin:0 16px 18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.09)}.history-heading>span{color:#748079;font-size:10px}.version-strip{display:flex;gap:9px;margin-top:12px;overflow-x:auto;padding:1px 1px 8px;scrollbar-width:thin}.version-card{flex:0 0 150px;min-width:0;padding:7px;border:1px solid rgba(255,255,255,.09);border-radius:14px;background:#131b17;color:#fff;cursor:pointer;text-align:left}.version-card.active{border-color:rgba(183,255,90,.58);box-shadow:0 0 0 2px rgba(183,255,90,.07)}.version-thumb{position:relative;display:block;width:100%;aspect-ratio:16/10;overflow:hidden;border-radius:9px;background:#0c110e}.version-copy{display:grid;gap:2px;padding:8px 3px 2px;min-width:0}.version-copy strong{font-size:11px}.version-copy small{color:#7f8b85;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dark-spinner{border-color:rgba(16,21,18,.2)!important;border-top-color:#101512!important}@media(max-width:720px){.workflow-switch{grid-template-columns:1fr}.workflow-switch button{min-height:74px}.accuracy-note{align-items:flex-start;flex-direction:column;gap:4px}.accuracy-note strong{white-space:normal}.revision-panel{margin:0 10px 12px;padding:14px}.version-history{margin:0 10px 14px}.revision-heading{align-items:center}.revision-heading h3{font-size:15px}.preserve-status{font-size:9px}.version-card{flex-basis:132px}}
      `}</style>
    </main>
  );
}
