import { useState, useRef, useEffect, useCallback } from "react";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const STORAGE_KEY = "resumeai_v2";
const API_TIMEOUT_MS = 45000;
const mono = "'DM Mono', monospace";
const serif = "'Playfair Display', serif";
const WORK_MODES = ["Remote", "Hybrid", "On-site", "Open to all"];
const CONTACT_FIELDS = [
  { key: "name",      label: "Full Name",          placeholder: "Jane Smith",                required: true },
  { key: "email",     label: "Email Address",       placeholder: "jane@example.com",          required: true },
  { key: "phone",     label: "Phone",               placeholder: "+1 (555) 000-0000" },
  { key: "location",  label: "Location",            placeholder: "Lagos, Nigeria" },
  { key: "linkedin",  label: "LinkedIn",            placeholder: "linkedin.com/in/janesmith" },
  { key: "portfolio", label: "Portfolio / Website", placeholder: "janesmith.dev" },
];

// ─── THEME TOKENS ─────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    bg: "#0a0a0a", surface: "#111", border: "#1e1e1e", border2: "#2a2a2a",
    text: "#e8e0d0", textMuted: "#666", textFaint: "#333",
    inputBg: "#0d0d0d", inputBorder: "#222",
    btnPrimaryBg: "#e8e0d0", btnPrimaryText: "#0a0a0a",
    btnGhostBorder: "#2a2a2a", btnGhostText: "#666",
    tabActive: "#e8e0d0", tabInactive: "#444",
    cardBg: "#0d0d0d", cardBorder: "#1a1a1a",
    errorBg: "#130000", errorBorder: "#2e0000", errorText: "#e05555",
    warnBg: "#100e00", warnBorder: "#2e2800", warnText: "#c09000",
    trackStroke: "#2a2a2a",
    regenBg: "#1a1a1a", regenBorder: "#2a2a2a", regenText: "#555",
    dotBg: "#e8e0d0",
    toggleLabel: "☀ Light",
  },
  light: {
    bg: "#f4f3ef", surface: "#fff", border: "#e2dfd8", border2: "#ccc8be",
    text: "#1a1814", textMuted: "#777", textFaint: "#bbb",
    inputBg: "#fff", inputBorder: "#d4d0c8",
    btnPrimaryBg: "#1a1814", btnPrimaryText: "#f4f3ef",
    btnGhostBorder: "#ccc8be", btnGhostText: "#777",
    tabActive: "#1a1814", tabInactive: "#aaa",
    cardBg: "#fff", cardBorder: "#e2dfd8",
    errorBg: "#fff2f2", errorBorder: "#f5c6c6", errorText: "#b03030",
    warnBg: "#fffce8", warnBorder: "#f0d060", warnText: "#7a6000",
    trackStroke: "#ddd",
    regenBg: "#f0eeea", regenBorder: "#d8d4cc", regenText: "#888",
    dotBg: "#1a1814",
    toggleLabel: "☾ Dark",
  },
};

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert resume strategist and ATS optimization specialist. You handle every candidate type — fresh graduates with zero experience, career changers, and seasoned professionals — and every job posting type — detailed specs, vague narratives, and sparse one-liners.

RULES:
1. NEVER fabricate experience, credentials, or metrics not explicitly provided
2. DO reframe what the candidate HAS using the job posting language and keywords
3. If the job posting is vague or sparse, infer reasonable expectations from the job title, industry, and target role — do not refuse or leave gaps
4. If candidate has NO formal work experience: build around education, projects, coursework, volunteering, extracurriculars, internships, transferable skills. Rename the experience section "Projects & Experience" or "Relevant Experience" as appropriate. Never leave it empty.
5. Insert [METRIC] only where a specific number would genuinely strengthen a bullet — add plain-English description to flaggedPlaceholders
6. ATS-safe output only — no tables, no columns, no graphics
7. Inject keywords naturally — never stuff
8. Honor preferred work mode in summary if provided
9. Leave all contact fields as empty strings — they are injected after
10. Match tone and seniority to role level

CANDIDATE TYPE HANDLING:
- No experience: Lead with education. Highlight projects, coursework, clubs, volunteer work. Summary emphasizes potential and learning agility.
- Career changer: Bridge past experience to new domain. Lead with transferable skills. Use target role language throughout.
- Experienced: Lead with impact. Quantify. Seniority signals matter.

Return ONLY valid JSON — no prose, no markdown fences:
{
  "gaps": ["specific gap"],
  "flaggedPlaceholders": ["what metric to add and where"],
  "resume": {
    "name": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin": "",
    "portfolio": "",
    "summary": "3-4 sentences tailored to candidate type and role",
    "experience": [
      {
        "title": "Job Title, Project Name, or Role",
        "company": "Company, University, or Organization",
        "duration": "Date range or Year",
        "bullets": ["Action verb + what + result or [METRIC]"]
      }
    ],
    "skills": ["skill1", "skill2"],
    "education": [{ "degree": "Degree", "institution": "School", "year": "Year" }],
    "certifications": ["cert"]
  }
}`;

// ─── SECTION REGEN PROMPT BUILDER ────────────────────────────────────────────
function buildSectionPrompt(section, jobDesc, resume, hasExperience) {
  const ctx = `JOB DESCRIPTION:\n${jobDesc || "Not provided — infer from resume context."}\n\nCURRENT SUMMARY:\n${resume.summary}\n\nCANDIDATE HAS FORMAL WORK EXPERIENCE: ${hasExperience}`;
  if (section === "summary") {
    return `${ctx}\n\nRewrite ONLY the professional summary (3-4 sentences, keyword-rich, tailored to the role and candidate type). Return only the summary text — no JSON, no labels.`;
  }
  if (section.startsWith("bullets-")) {
    const ji = parseInt(section.split("-")[1], 10);
    const job = resume.experience[ji] || {};
    return `${ctx}\n\nROLE: ${job.title || ""} at ${job.company || ""}\nCURRENT BULLETS:\n${(job.bullets || []).join("\n")}\n\nRewrite ONLY the bullet points for this role (3-5 bullets, strong action verbs, keywords from JD). Return a JSON array of strings only — e.g. ["Bullet one","Bullet two"].`;
  }
  return "";
}

// ─── ATS SCORING (deterministic) ─────────────────────────────────────────────
function computeAtsScore(jobDescription, resume, hasExperience) {
  const jdLower = (jobDescription || "").toLowerCase();
  const resumeText = [
    resume.summary || "",
    ...(resume.experience || []).flatMap(j => [j.title || "", j.company || "", ...(j.bullets || [])]),
    ...(resume.skills || []),
  ].join(" ").toLowerCase();

  const stopWords = new Set([
    "the","and","for","are","with","that","this","have","from","will","you","your",
    "our","their","they","been","has","was","not","but","can","all","any","also",
    "its","who","may","must","able","both","each","into","more","most","over","such",
    "than","then","them","when","where","which","while","would","about","after",
    "before","being","between","during","other","these","those","through","under","well",
  ]);

  const jdTokens = jdLower.match(/\b[a-z][a-z0-9+#.]{2,}\b/g) || [];
  const jdKeywords = [...new Set(jdTokens.filter(w => !stopWords.has(w)))];
  const matched = jdKeywords.filter(kw => resumeText.includes(kw));

  // Sparse JD: fall back to neutral score rather than penalizing candidate
  const keywordScore = jdKeywords.length > 5
    ? Math.min(100, Math.round((matched.length / jdKeywords.length) * 140))
    : 65;

  const unfilledMetrics = (resumeText.match(/\[metric\]/gi) || []).length;
  const formattingScore = Math.max(40, 100 - unfilledMetrics * 8);

  const expEntries = (resume.experience || []).length;
  const bulletsTotal = (resume.experience || []).reduce((s, j) => s + (j.bullets?.length || 0), 0);
  const hasEdu = (resume.education || []).length > 0;
  const hasSkills = (resume.skills || []).length > 0;
  const expBase = hasExperience
    ? (expEntries > 0 ? 50 : 0)
    : (hasEdu || hasSkills ? 40 : 20); // no-experience candidates: partial credit
  const experienceAlignment = Math.min(100, expBase + Math.min(50, bulletsTotal * 8));

  const actionVerbs = [
    "led","built","designed","developed","improved","increased","reduced","managed",
    "created","launched","delivered","implemented","drove","achieved","optimized",
    "automated","coordinated","collaborated","spearheaded","established","streamlined",
    "mentored","negotiated","analyzed","produced","deployed","migrated","scaled","grew",
    "completed","earned","participated","contributed","presented","researched","supported",
    "initiated","organised","organized","facilitated","maintained","operated",
  ];
  const allBullets = (resume.experience || []).flatMap(j => j.bullets || []);
  const goodBullets = allBullets.filter(b =>
    actionVerbs.some(v => b.toLowerCase().trimStart().startsWith(v))
  ).length;
  const sentenceQuality = allBullets.length > 0
    ? Math.min(100, Math.round((goodBullets / allBullets.length) * 100))
    : 40;

  const overall = Math.round(
    keywordScore * 0.40 +
    experienceAlignment * 0.30 +
    sentenceQuality * 0.20 +
    formattingScore * 0.10
  );

  return { overall, breakdown: { keywordScore, formattingScore, experienceAlignment, sentenceQuality }, matchedKeywords: matched, totalKeywords: jdKeywords.length };
}

// ─── REGEX ESCAPE — explicit per-character, no character class ───────────────
function escapeRegex(s) {
  return s
    .replace(/\\/g,  "\\\\")
    .replace(/\./g,  "\\.")
    .replace(/\+/g,  "\\+")
    .replace(/\*/g,  "\\*")
    .replace(/\?/g,  "\\?")
    .replace(/\^/g,  "\\^")
    .replace(/\$/g,  "\\$")
    .replace(/\{/g,  "\\{")
    .replace(/\}/g,  "\\}")
    .replace(/\(/g,  "\\(")
    .replace(/\)/g,  "\\)")
    .replace(/\|/g,  "\\|")
    .replace(/\[/g,  "\\[")
    .replace(/\]/g,  "\\]");
}

// ─── SANITIZE BULLET HTML — only <mark> allowed ───────────────────────────────
function sanitizeBullet(raw) {
  const stripped = (raw || "").replace(/<(?!\/?mark(\s[^>]*)?>)[^>]+>/gi, "");
  return stripped.replace(/\[METRIC\]/gi, '<mark style="background:#fff3cd;padding:0 2px;border-radius:2px">[METRIC]</mark>');
}

// ─── API HELPERS ──────────────────────────────────────────────────────────────
async function apiFetch(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `API error ${res.status}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "API error");
  return data.content?.[0]?.text?.trim() || "";
}

async function callGenerateResume(jobDescription, userExperience, workMode, targetRole, hasExperience) {
  const content = [
    `JOB POSTING:\n${jobDescription || "Not provided — infer from target role."}`,
    `TARGET ROLE: ${targetRole || "Infer from job posting."}`,
    `CANDIDATE HAS FORMAL WORK EXPERIENCE: ${hasExperience}`,
    `PREFERRED WORK MODE: ${workMode || "Not specified"}`,
    `CANDIDATE BACKGROUND:\n${userExperience}`,
    "Return only valid JSON.",
  ].join("\n\n");

  const text = await apiFetch({ model: "claude-sonnet-4-20250514", max_tokens: 4000, system: SYSTEM_PROMPT, messages: [{ role: "user", content }] });
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch { throw new Error("PARSE_ERROR"); }
}

async function callRegenerateSection(prompt) {
  return apiFetch({ model: "claude-sonnet-4-20250514", max_tokens: 800, messages: [{ role: "user", content: prompt }] });
}

async function callGenerateCoverLetter(jobDesc, resume) {
  const content = `Write a compelling, concise cover letter for this candidate.

CANDIDATE: ${resume.name || "Candidate"}
JOB:
${jobDesc || "Not provided — write based on resume context."}
SUMMARY: ${resume.summary || ""}
KEY EXPERIENCE:
${(resume.experience || []).map(j => `${j.title} at ${j.company}: ${(j.bullets || []).slice(0, 2).join("; ")}`).join("\n")}

INSTRUCTIONS: 3 tight paragraphs — hook, fit, close. Use job language. No address blocks or date lines. Max 250 words.`;

  return apiFetch({ model: "claude-sonnet-4-20250514", max_tokens: 1200, messages: [{ role: "user", content }] });
}

// ─── STYLE FACTORIES ──────────────────────────────────────────────────────────
const mkInput = (t) => ({
  width: "100%", background: t.inputBg, border: `1px solid ${t.inputBorder}`,
  borderRadius: 5, color: t.text, padding: "12px 14px",
  fontFamily: mono, fontSize: 13, outline: "none",
  boxSizing: "border-box", transition: "border-color 0.15s",
  WebkitAppearance: "none", display: "block",
});
const mkLabel = (t) => ({
  fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase",
  color: t.textMuted, display: "block", marginBottom: 8, fontFamily: mono,
});
const mkPrimary = (t, active) => ({
  background: active ? t.btnPrimaryBg : t.surface,
  color: active ? t.btnPrimaryText : t.textFaint,
  border: `1px solid ${active ? t.btnPrimaryBg : t.border2}`,
  padding: "12px 26px", borderRadius: 4,
  cursor: active ? "pointer" : "not-allowed",
  fontFamily: mono, fontSize: 12, fontWeight: 700,
  letterSpacing: "0.1em", textTransform: "uppercase",
  transition: "all 0.15s", WebkitAppearance: "none",
  touchAction: "manipulation", flexShrink: 0,
});
const mkGhost = (t) => ({
  background: "transparent", border: `1px solid ${t.btnGhostBorder}`,
  color: t.btnGhostText, padding: "11px 20px", borderRadius: 4,
  cursor: "pointer", fontFamily: mono, fontSize: 11,
  letterSpacing: "0.08em", WebkitAppearance: "none", touchAction: "manipulation", flexShrink: 0,
});

// ─── STEP BAR ─────────────────────────────────────────────────────────────────
function StepBar({ step, t }) {
  const steps = ["Contact", "Role", "Resume"];
  const idx = { contact: 0, input: 1, loading: 1, result: 2 }[step] ?? 0;
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {steps.map((s, i) => (
        <div key={s} style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
              width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 9, fontFamily: mono, fontWeight: 700,
              background: i <= idx ? t.btnPrimaryBg : t.surface,
              color: i <= idx ? t.btnPrimaryText : t.textMuted,
              border: `1.5px solid ${i <= idx ? t.btnPrimaryBg : t.border2}`,
            }}>
              {i < idx ? "✓" : i + 1}
            </div>
            <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: mono, color: i === idx ? t.text : i < idx ? t.textMuted : t.border2 }}>
              {s}
            </span>
          </div>
          {i < 2 && <div style={{ width: 20, height: 1, background: i < idx ? t.border2 : t.border, margin: "0 8px" }} />}
        </div>
      ))}
    </div>
  );
}

// ─── SCORE RING ───────────────────────────────────────────────────────────────
function ScoreRing({ score, label: lbl, size = 80, t }) {
  const r = size / 2 - 7;
  const circ = 2 * Math.PI * r;
  const fill = ((score || 0) / 100) * circ;
  const color = score >= 80 ? "#4ade80" : score >= 60 ? "#facc15" : "#f87171";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)", position: "absolute", top: 0, left: 0 }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.trackStroke} strokeWidth={5} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={5}
            strokeDasharray={`${fill} ${circ}`} strokeLinecap="round"
            style={{ transition: "stroke-dasharray 1.1s ease" }} />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color, fontFamily: mono, fontSize: size > 75 ? 19 : 14, fontWeight: 700 }}>
          {score ?? "—"}
        </div>
      </div>
      <div style={{ color: t.textMuted, fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", fontFamily: mono, textAlign: "center" }}>
        {lbl}
      </div>
    </div>
  );
}

// ─── WORD COUNT ───────────────────────────────────────────────────────────────
function WordCount({ text, min, t }) {
  const count = text.trim() ? text.trim().split(/\s+/).length : 0;
  const ok = count >= min;
  return (
    <div style={{ fontSize: 10, fontFamily: mono, marginTop: 6, textAlign: "right", color: t.textMuted }}>
      {count} words
      {!ok && count > 0 && <span> · aim for {min}+</span>}
      {ok && <span style={{ color: "#4ade80" }}> · ✓</span>}
    </div>
  );
}

// ─── EDITABLE ─────────────────────────────────────────────────────────────────
function Editable({ value, onChange, tag = "span", style = {}, multiline = false, html }) {
  const ref = useRef();
  const composing = useRef(false);

  useEffect(() => {
    if (!ref.current || document.activeElement === ref.current) return;
    if (html !== undefined) {
      ref.current.innerHTML = html;
    } else if (ref.current.innerText !== (value || "")) {
      ref.current.innerText = value || "";
    }
  }, [value, html]);

  const Tag = tag;
  return (
    <Tag
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onBlur={() => { if (!composing.current) onChange(ref.current?.innerText || ""); }}
      onKeyDown={e => { if (!multiline && e.key === "Enter") { e.preventDefault(); ref.current?.blur(); } }}
      onMouseEnter={e => { e.currentTarget.style.borderBottomColor = "#aaa"; }}
      onMouseLeave={e => { if (document.activeElement !== e.currentTarget) e.currentTarget.style.borderBottomColor = "transparent"; }}
      onFocus={e => { e.currentTarget.style.borderBottomColor = "#888"; }}
      style={{ outline: "none", borderBottom: "1px dashed transparent", transition: "border-color 0.15s", cursor: "text", ...style }}
    />
  );
}

// ─── RESUME PREVIEW ───────────────────────────────────────────────────────────
// Typography: R object defines all sizes — matched 1:1 in print CSS below
const R = {
  name:    { fontSize: 22, fontWeight: 700, letterSpacing: -0.5, marginBottom: 4, fontFamily: "Georgia, serif", display: "block" },
  contact: { fontSize: 10, color: "#555", display: "flex", flexWrap: "wrap", gap: "3px 16px", marginBottom: 16 },
  sec:     { fontSize: 8, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", borderBottom: "1.5px solid #ccc", paddingBottom: 3, marginBottom: 9, marginTop: 14, fontFamily: "Georgia, serif" },
  summary: { fontSize: 10.5, lineHeight: 1.75, color: "#1a1a1a", display: "block", marginBottom: 14, fontFamily: "Georgia, serif" },
  jobHead: { display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 2, alignItems: "baseline", marginBottom: 4 },
  jobTitle:{ fontWeight: 700, fontSize: 11, fontFamily: "Georgia, serif" },
  jobMeta: { fontSize: 9.5, color: "#666", fontFamily: "Georgia, serif" },
  bullet:  { fontSize: 10.5, lineHeight: 1.65, marginBottom: 2 },
  skill:   { fontSize: 10.5, lineHeight: 1.8, display: "block", fontFamily: "Georgia, serif" },
  edu:     { display: "flex", justifyContent: "space-between", fontSize: 10.5, marginBottom: 4 },
  cert:    { fontSize: 10.5, marginBottom: 3 },
};

// Print CSS mirrors the R object exactly so WYSIWYG = PDF
const PRINT_CSS = `
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Georgia',serif;color:#111;padding:.65in .8in;max-width:8.5in;font-size:10.5pt}
  h1{font-size:22pt;font-weight:700;letter-spacing:-.5px;margin-bottom:4px}
  .rc{font-size:10pt;color:#555;display:flex;flex-wrap:wrap;gap:3px 16px;margin-bottom:16px}
  .rs{font-size:8pt;font-weight:700;letter-spacing:.18em;text-transform:uppercase;border-bottom:1.5px solid #ccc;padding-bottom:3px;margin:14px 0 9px}
  .rjh{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:2px;margin-bottom:4px}
  .rjt{font-weight:700;font-size:11pt}
  .rjm{font-size:9.5pt;color:#666}
  ul{padding-left:16px;margin-top:4px}
  li{font-size:10.5pt;line-height:1.65;margin-bottom:2px}
  .rsk{font-size:10.5pt;line-height:1.8}
  .red{display:flex;justify-content:space-between;font-size:10.5pt;margin-bottom:4px}
  mark{background:#fff3cd;padding:0 2px;border-radius:2px}
  .regen-btn{display:none}
  @media print{body{padding:.5in .65in}}
`;

function ResumePreview({ resume, onResumeChange, jobDesc, atsData, showKeywords, hasExperience, t }) {
  const printRef = useRef();
  const [regenLoading, setRegenLoading] = useState(null);

  const highlight = useCallback((text) => {
    if (!showKeywords || !atsData?.matchedKeywords?.length || !text) return undefined;
    const pattern = atsData.matchedKeywords
      .slice()
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join("|");
    if (!pattern) return undefined;
    try {
      return text.replace(
        new RegExp("(" + pattern + ")", "gi"),
        '<mark style="background:#d4f0d4;color:#1a5c1a;padding:0 1px;border-radius:2px">$1</mark>'
      );
    } catch { return undefined; }
  }, [showKeywords, atsData]);

  const update = useCallback((path, value) => {
    const parts = path.split(".");
    const next = JSON.parse(JSON.stringify(resume));
    let cur = next;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
    onResumeChange(next);
  }, [resume, onResumeChange]);

  const handleRegen = async (section) => {
    setRegenLoading(section);
    try {
      const prompt = buildSectionPrompt(section, jobDesc, resume, hasExperience);
      const raw = await callRegenerateSection(prompt);
      const next = JSON.parse(JSON.stringify(resume));
      if (section === "summary") {
        next.summary = raw;
      } else if (section.startsWith("bullets-")) {
        const ji = parseInt(section.split("-")[1], 10);
        try { next.experience[ji].bullets = JSON.parse(raw); } catch { /* keep existing on parse fail */ }
      }
      onResumeChange(next);
    } catch { /* silently keep existing — don't surface regen failures as hard errors */ }
    finally { setRegenLoading(null); }
  };

  // Export: clone DOM, strip editor chrome, open print window
  // Falls back to hidden iframe when popups are blocked (common on mobile)
  const handlePrint = () => {
    const node = printRef.current;
    if (!node) return;
    const clone = node.cloneNode(true);
    clone.querySelectorAll("[contenteditable]").forEach(el => {
      el.removeAttribute("contenteditable");
      el.style.borderBottom = "none";
      el.style.cursor = "default";
    });
    // Strip keyword highlight marks for PDF — keep [METRIC] marks only
    clone.querySelectorAll("mark").forEach(m => {
      if (!(m.textContent || "").includes("[METRIC]")) {
        m.replaceWith(document.createTextNode(m.textContent || ""));
      }
    });
    clone.querySelectorAll(".regen-btn").forEach(el => el.remove());

    const html = `<html><head><title>Resume${resume.name ? " — " + resume.name : ""}</title><style>${PRINT_CSS}</style></head><body>${clone.innerHTML}</body></html>`;

    const w = window.open("", "_blank");
    if (!w) {
      // Popup blocked — iframe fallback
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;border:none;z-index:9999;background:white";
      document.body.appendChild(iframe);
      iframe.contentDocument.write(html);
      iframe.contentDocument.close();
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => document.body.removeChild(iframe), 3000);
      return;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  const contactItems = [resume.email, resume.phone, resume.location, resume.linkedin, resume.portfolio].filter(Boolean);
  const expLabel = hasExperience ? "Experience" : "Projects & Experience";
  const isEmpty = !resume.summary && !(resume.experience || []).length && !(resume.skills || []).length;

  // Regen button — shown on hover (CSS media query handles hover availability)
  const regenBtn = (section, label) => (
    <button className="regen-btn" onClick={() => handleRegen(section)} disabled={!!regenLoading}
      style={{
        fontSize: 9, padding: "2px 8px", borderRadius: 3, cursor: "pointer",
        fontFamily: mono, marginLeft: 8, verticalAlign: "middle",
        background: t.regenBg, border: `1px solid ${t.regenBorder}`, color: t.regenText,
        WebkitAppearance: "none",
      }}>
      {regenLoading === section ? "..." : label}
    </button>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={handlePrint} style={{ ...mkPrimary(t, true), padding: "10px 22px", fontSize: 11 }}>
          Export PDF ↗
        </button>
        <span style={{ fontSize: 10, color: t.textMuted, fontFamily: mono, marginLeft: "auto" }}>
          ✎ Click any text to edit · hover sections for ↺ redo
        </span>
      </div>

      {/* White card — always white to match print output */}
      <div ref={printRef} style={{ background: "#fff", color: "#111", padding: "36px 48px", fontFamily: "Georgia, serif", lineHeight: 1.55, borderRadius: 6, boxShadow: "0 2px 20px rgba(0,0,0,0.10)" }}>
        {isEmpty ? (
          <div style={{ color: "#bbb", fontSize: 11, fontStyle: "italic", textAlign: "center", padding: "32px 0" }}>
            Resume content will appear here after generation.
          </div>
        ) : (
          <>
            {resume.name && (
              <Editable tag="h1" value={resume.name} onChange={v => update("name", v)} style={R.name} />
            )}

            {contactItems.length > 0 && (
              <div className="rc" style={R.contact}>
                {contactItems.map((item, i) => <span key={i}>{item}</span>)}
              </div>
            )}

            {resume.summary !== undefined && (
              <>
                <div className="rs" style={R.sec}>
                  Professional Summary {regenBtn("summary", "↺ redo")}
                </div>
                <Editable tag="p" value={resume.summary} onChange={v => update("summary", v)} multiline
                  html={highlight(resume.summary)} style={R.summary} />
              </>
            )}

            {(resume.experience || []).length > 0 && (
              <>
                <div className="rs" style={R.sec}>{expLabel}</div>
                {resume.experience.map((job, ji) => (
                  <div key={ji} style={{ marginBottom: 14 }}>
                    <div className="rjh" style={R.jobHead}>
                      <Editable
                        value={`${job.title || ""}${job.company ? ` — ${job.company}` : ""}`}
                        onChange={v => {
                          const [title, ...rest] = v.split(" — ");
                          update(`experience.${ji}.title`, title.trim());
                          update(`experience.${ji}.company`, rest.join(" — ").trim());
                        }}
                        style={{ ...R.jobTitle }} />
                      <Editable value={job.duration || ""} onChange={v => update(`experience.${ji}.duration`, v)}
                        style={R.jobMeta} />
                    </div>
                    <ul style={{ paddingLeft: 16, marginTop: 4 }}>
                      {(job.bullets || []).map((b, bi) => (
                        <li key={bi} style={R.bullet}>
                          <Editable value={b} onChange={v => update(`experience.${ji}.bullets.${bi}`, v)}
                            html={(() => { const kh = highlight(b); return kh ? sanitizeBullet(kh) : sanitizeBullet(b); })()}
                            style={{ fontFamily: "Georgia, serif" }} />
                        </li>
                      ))}
                      {(job.bullets || []).length === 0 && (
                        <li style={{ ...R.bullet, color: "#bbb", fontStyle: "italic" }}>No bullets yet.</li>
                      )}
                    </ul>
                    {regenBtn(`bullets-${ji}`, "↺ redo bullets")}
                  </div>
                ))}
              </>
            )}

            {(resume.skills || []).length > 0 && (
              <>
                <div className="rs" style={R.sec}>Skills</div>
                <Editable tag="p"
                  value={resume.skills.join(" · ")}
                  onChange={v => update("skills", v.split(/\s*[·,]\s*/).map(s => s.trim()).filter(Boolean))}
                  style={R.skill} />
              </>
            )}

            {(resume.education || []).length > 0 && (
              <>
                <div className="rs" style={R.sec}>Education</div>
                {resume.education.map((e, ei) => (
                  <div key={ei} className="red" style={R.edu}>
                    <Editable
                      value={`${e.degree || ""}${e.institution ? ` — ${e.institution}` : ""}`}
                      onChange={v => {
                        const [deg, ...rest] = v.split(" — ");
                        update(`education.${ei}.degree`, deg.trim());
                        update(`education.${ei}.institution`, rest.join(" — ").trim());
                      }}
                      style={{ fontFamily: "Georgia, serif" }} />
                    <Editable value={e.year || ""} onChange={v => update(`education.${ei}.year`, v)}
                      style={{ color: "#666", fontFamily: "Georgia, serif" }} />
                  </div>
                ))}
              </>
            )}

            {(resume.certifications || []).filter(Boolean).length > 0 && (
              <>
                <div className="rs" style={R.sec}>Certifications</div>
                {resume.certifications.filter(Boolean).map((c, ci) => (
                  <div key={ci} style={R.cert}>
                    • <Editable value={c} onChange={v => update(`certifications.${ci}`, v)}
                        style={{ fontFamily: "Georgia, serif" }} />
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── ANALYSIS TAB ─────────────────────────────────────────────────────────────
function AnalysisTab({ atsData, gaps, flaggedPlaceholders, coverLetter, coverLetterLoading, onGenerateCoverLetter, onViewResume, isMobile, t }) {
  const sparseJD = atsData.totalKeywords <= 5;
  return (
    <div style={{ animation: "fadeUp 0.25s ease" }}>
      {/* Hero row */}
      <div style={{ display: "flex", gap: isMobile ? 20 : 44, alignItems: "center", marginBottom: 36, flexWrap: "wrap" }}>
        <ScoreRing score={atsData.overall} label="ATS Score" size={isMobile ? 96 : 116} t={t} />
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontFamily: serif, fontSize: isMobile ? 20 : 26, fontWeight: 800, lineHeight: 1.2, marginBottom: 8, color: t.text }}>
            {atsData.overall >= 80
              ? <span>Your resume is <span style={{ color: "#4ade80" }}>strong.</span></span>
              : atsData.overall >= 60
              ? <span>Room to <span style={{ color: "#facc15" }}>improve.</span></span>
              : <span>Needs <span style={{ color: "#f87171" }}>work.</span></span>}
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, fontFamily: mono, lineHeight: 1.8 }}>
            {sparseJD
              ? "Job posting was sparse — score based on inferred role keywords."
              : `${atsData.matchedKeywords.length} of ${atsData.totalKeywords} job keywords matched.`}
            {atsData.overall < 80 && !sparseJD && " Address gaps below before applying."}
          </div>
        </div>
      </div>

      {/* Breakdown */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)", gap: 1, marginBottom: 28, background: t.border, borderRadius: 8, overflow: "hidden", border: `1px solid ${t.border}` }}>
        {[
          { score: atsData.breakdown.keywordScore,        label: "Keywords",  desc: sparseJD ? "Estimated from role" : "JD terms matched" },
          { score: atsData.breakdown.experienceAlignment,  label: "Depth",     desc: "Content coverage" },
          { score: atsData.breakdown.sentenceQuality,      label: "Quality",   desc: "Action verb bullets" },
          { score: atsData.breakdown.formattingScore,      label: "Format",    desc: "ATS-safe structure" },
        ].map(({ score, label, desc }) => {
          const col = score >= 80 ? "#4ade80" : score >= 60 ? "#facc15" : "#f87171";
          return (
            <div key={label} style={{ background: t.cardBg, padding: "18px 16px" }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: col, fontFamily: mono, marginBottom: 3 }}>{score}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: t.text, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 10, color: t.textMuted, fontFamily: mono }}>{desc}</div>
            </div>
          );
        })}
      </div>

      {/* Gaps */}
      {(gaps || []).length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: t.textMuted, fontFamily: mono, marginBottom: 10 }}>Gaps to Address</div>
          {gaps.map((g, i) => (
            <div key={i} style={{ background: t.errorBg, border: `1px solid ${t.errorBorder}`, borderRadius: 5, padding: "10px 14px", fontSize: 12, color: t.errorText, fontFamily: mono, lineHeight: 1.6, marginBottom: 6 }}>
              ✕ {g}
            </div>
          ))}
        </div>
      )}

      {/* Missing metrics */}
      {(flaggedPlaceholders || []).length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: t.textMuted, fontFamily: mono, marginBottom: 10 }}>Missing Metrics — Add Before Sending</div>
          {flaggedPlaceholders.map((f, i) => (
            <div key={i} style={{ background: t.warnBg, border: `1px solid ${t.warnBorder}`, borderRadius: 5, padding: "10px 14px", fontSize: 12, color: t.warnText, fontFamily: mono, lineHeight: 1.6, marginBottom: 6 }}>
              ⚠ {f}
            </div>
          ))}
        </div>
      )}

      {/* CTAs */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button onClick={onViewResume} style={mkPrimary(t, true)}>View Resume →</button>
        <button onClick={onGenerateCoverLetter} disabled={coverLetterLoading}
          style={{ ...mkGhost(t), cursor: coverLetterLoading ? "not-allowed" : "pointer" }}>
          {coverLetterLoading ? "Generating..." : coverLetter ? "Regenerate Cover Letter" : "Generate Cover Letter"}
        </button>
      </div>
    </div>
  );
}

// ─── COVER LETTER TAB ─────────────────────────────────────────────────────────
function CoverLetterTab({ coverLetter, coverLetterLoading, onRegenerate, resumeName, isMobile, t }) {
  const handleExport = () => {
    const paragraphs = (coverLetter || "").split("\n\n").map(p => `<p>${p}</p>`).join("");
    const html = `<html><head><title>Cover Letter${resumeName ? " — " + resumeName : ""}</title><style>body{font-family:Georgia,serif;font-size:11pt;color:#111;padding:.75in;max-width:8.5in;line-height:1.9}p{margin-bottom:1em}@media print{body{padding:.5in}}</style></head><body>${paragraphs}</body></html>`;
    const w = window.open("", "_blank");
    if (!w) {
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;border:none;z-index:9999;background:white";
      document.body.appendChild(iframe);
      iframe.contentDocument.write(html);
      iframe.contentDocument.close();
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => document.body.removeChild(iframe), 3000);
      return;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };

  if (coverLetterLoading) return (
    <div style={{ textAlign: "center", padding: "80px 0", animation: "fadeUp 0.25s ease" }}>
      <div style={{ fontFamily: serif, fontSize: 22, marginBottom: 12, color: t.text }}>Writing your cover letter...</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 28 }}>
        {[0, 1, 2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: t.dotBg, animation: `pulse 1.4s ease ${i * 0.22}s infinite` }} />)}
      </div>
    </div>
  );

  return (
    <div style={{ animation: "fadeUp 0.25s ease" }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <button onClick={handleExport} style={{ ...mkPrimary(t, true), padding: "10px 22px", fontSize: 11 }}>Export PDF ↗</button>
        <button onClick={onRegenerate} style={{ ...mkGhost(t), fontSize: 11 }}>Regenerate</button>
      </div>
      <div style={{ background: "#fff", color: "#111", padding: isMobile ? "28px 24px" : "48px 60px", fontFamily: "Georgia, serif", fontSize: 11.5, lineHeight: 1.9, borderRadius: 6, boxShadow: "0 2px 20px rgba(0,0,0,0.10)" }}>
        {(coverLetter || "").split("\n\n").map((para, i) => <p key={i} style={{ marginBottom: "1em" }}>{para}</p>)}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [isDark, setIsDark] = useState(() => {
    try { return localStorage.getItem("resumeai_theme") !== "light"; } catch { return true; }
  });
  const t = THEMES[isDark ? "dark" : "light"];

  const [step, setStep] = useState("contact");
  const [contact, setContact] = useState({ name: "", email: "", phone: "", location: "", linkedin: "", portfolio: "" });
  const [workMode, setWorkMode] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [hasExperience, setHasExperience] = useState(true);
  const [jobDesc, setJobDesc] = useState("");
  const [experience, setExperience] = useState("");
  const [result, setResult] = useState(null);
  const [atsData, setAtsData] = useState(null);
  const [error, setError] = useState(null);
  const [isMobile, setIsMobile] = useState(false);
  const [coverLetter, setCoverLetter] = useState(null);
  const [coverLetterLoading, setCoverLetterLoading] = useState(false);
  const [resultTab, setResultTab] = useState("analysis");
  const [showKeywords, setShowKeywords] = useState(false);

  // Persist theme preference
  useEffect(() => {
    try { localStorage.setItem("resumeai_theme", isDark ? "dark" : "light"); } catch {}
  }, [isDark]);

  // Mobile detection
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Draft persistence — save while on input steps
  useEffect(() => {
    if (step === "result" || step === "loading") return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ contact, workMode, targetRole, hasExperience, jobDesc, experience })); } catch {}
  }, [contact, workMode, targetRole, hasExperience, jobDesc, experience, step]);

  // Restore draft on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const d = JSON.parse(saved);
      if (d.contact) setContact(d.contact);
      if (d.workMode) setWorkMode(d.workMode);
      if (d.targetRole) setTargetRole(d.targetRole);
      if (d.hasExperience !== undefined) setHasExperience(d.hasExperience);
      if (d.jobDesc) setJobDesc(d.jobDesc);
      if (d.experience) setExperience(d.experience);
    } catch {}
  }, []);

  const contactReady = !!(contact.name.trim() && contact.email.trim());
  const inputReady = experience.trim().length > 10;

  const handleGenerate = async () => {
    setStep("loading");
    setError(null);
    try {
      const data = await callGenerateResume(jobDesc, experience, workMode, targetRole, hasExperience);
      data.resume = { ...data.resume, ...contact };
      setResult(data);
      setAtsData(computeAtsScore(jobDesc, data.resume, hasExperience));
      setResultTab("analysis");
      setStep("result");
    } catch (e) {
      let msg = "Something went wrong. Please try again.";
      if (e.name === "AbortError") msg = "Request timed out after 45s. Please try again.";
      else if (e.message === "PARSE_ERROR") msg = "AI returned an unexpected format. Please try again.";
      else if (e.message?.includes("API error")) msg = `${e.message} — check your connection.`;
      setError(msg);
      setStep("input");
    }
  };

  const handleResumeChange = useCallback((updated) => {
    setResult(prev => ({ ...prev, resume: updated }));
    setAtsData(computeAtsScore(jobDesc, updated, hasExperience));
  }, [jobDesc, hasExperience]);

  const handleGenerateCoverLetter = async () => {
    if (!result?.resume || coverLetterLoading) return;
    setCoverLetterLoading(true);
    setCoverLetter(null);
    setResultTab("coverletter");
    try {
      const cl = await callGenerateCoverLetter(jobDesc, result.resume);
      setCoverLetter(cl);
    } catch {
      setCoverLetter("Failed to generate. Please try again.");
    } finally {
      setCoverLetterLoading(false);
    }
  };

  const handleReset = () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    setStep("contact");
    setContact({ name: "", email: "", phone: "", location: "", linkedin: "", portfolio: "" });
    setWorkMode(""); setTargetRole(""); setHasExperience(true);
    setJobDesc(""); setExperience("");
    setResult(null); setAtsData(null); setError(null);
    setCoverLetter(null); setCoverLetterLoading(false);
    setResultTab("analysis"); setShowKeywords(false);
  };

  const TABS = [
    { id: "analysis",     label: "Analysis" },
    { id: "resume",       label: "Resume" },
    ...(coverLetter || coverLetterLoading ? [{ id: "coverletter", label: "Cover Letter" }] : []),
  ];

  const inp = mkInput(t);
  const lbl = mkLabel(t);
  const gridCols = isMobile ? "1fr" : "1fr 1fr";

  return (
    <div style={{ minHeight: "100vh", background: t.bg, color: t.text, fontFamily: mono, transition: "background 0.2s, color 0.2s" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Playfair+Display:wght@700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; }
        input:focus, textarea:focus { border-color: #888 !important; box-shadow: none; }
        input::placeholder, textarea::placeholder { color: ${t.textFaint}; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
        [contenteditable]:hover { border-bottom-color: #aaa !important; }
        [contenteditable]:focus { border-bottom-color: #888 !important; outline: none; }
        .regen-btn { display: none !important; }
        @media (hover: hover) { .regen-btn { display: inline-block !important; } }
        @media print { .no-print { display: none !important; } }
      `}</style>

      {/* ── HEADER ── */}
      <div className="no-print" style={{ borderBottom: `1px solid ${t.border}`, padding: isMobile ? "12px 16px" : "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: t.bg, zIndex: 100, gap: 12, flexWrap: isMobile ? "wrap" : "nowrap" }}>
        <div style={{ fontFamily: serif, fontSize: 17, fontWeight: 800, letterSpacing: -0.5, flexShrink: 0, color: t.text }}>
          RÉSUMÉ<span style={{ color: t.textMuted }}>.AI</span>
        </div>
        {!isMobile && <StepBar step={step} t={t} />}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <button
            onClick={() => setIsDark(p => !p)}
            style={{ background: "transparent", border: `1px solid ${t.border2}`, color: t.textMuted, padding: "6px 12px", borderRadius: 4, cursor: "pointer", fontFamily: mono, fontSize: 11, WebkitAppearance: "none", transition: "all 0.15s" }}
          >
            {t.toggleLabel}
          </button>
          {step === "result" && (
            <button onClick={handleReset} style={{ ...mkGhost(t), padding: "6px 14px", fontSize: 10 }}>← New</button>
          )}
        </div>
        {isMobile && <div style={{ width: "100%", paddingTop: 4 }}><StepBar step={step} t={t} /></div>}
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: isMobile ? "28px 16px 60px" : "44px 24px 80px" }}>

        {/* ══ STEP 1: CONTACT ══ */}
        {step === "contact" && (
          <div style={{ animation: "fadeUp 0.35s ease" }}>
            <div style={{ marginBottom: 32 }}>
              <h1 style={{ fontFamily: serif, fontSize: isMobile ? 26 : 34, fontWeight: 800, lineHeight: 1.1, letterSpacing: -1, marginBottom: 10, color: t.text }}>
                Let's start with<br /><span style={{ color: t.textMuted }}>the basics.</span>
              </h1>
              <p style={{ color: t.textMuted, fontSize: 12, lineHeight: 1.9, maxWidth: 440 }}>
                This goes directly onto your resume — it never passes through the AI.
              </p>
            </div>

            {/* Contact fields: single column mobile, logical pairs on desktop */}
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "14px 24px", maxWidth: 660 }}>
              {/* Pair 1: Name + Email */}
              {CONTACT_FIELDS.slice(0, 2).map(({ key, label: fl, placeholder, required }) => (
                <div key={key}>
                  <label style={lbl}>{fl} {required && <span style={{ color: "#f87171" }}>*</span>}</label>
                  <input type={key === "email" ? "email" : "text"} style={inp} placeholder={placeholder}
                    value={contact[key]} onChange={e => setContact(p => ({ ...p, [key]: e.target.value }))} />
                </div>
              ))}
              {/* Pair 2: Phone + Location */}
              {CONTACT_FIELDS.slice(2, 4).map(({ key, label: fl, placeholder }) => (
                <div key={key}>
                  <label style={lbl}>{fl}</label>
                  <input type="text" style={inp} placeholder={placeholder}
                    value={contact[key]} onChange={e => setContact(p => ({ ...p, [key]: e.target.value }))} />
                </div>
              ))}
              {/* Pair 3: LinkedIn + Portfolio */}
              {CONTACT_FIELDS.slice(4).map(({ key, label: fl, placeholder }) => (
                <div key={key}>
                  <label style={lbl}>{fl}</label>
                  <input type="text" style={inp} placeholder={placeholder}
                    value={contact[key]} onChange={e => setContact(p => ({ ...p, [key]: e.target.value }))} />
                </div>
              ))}
              {/* Work mode — full width */}
              <div style={{ gridColumn: isMobile ? "1" : "1 / -1" }}>
                <label style={lbl}>Preferred Work Mode</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {WORK_MODES.map(m => (
                    <button key={m} onClick={() => setWorkMode(p => p === m ? "" : m)} style={{
                      padding: "8px 14px", borderRadius: 4, fontFamily: mono, fontSize: 11,
                      cursor: "pointer", transition: "all 0.15s", letterSpacing: "0.06em",
                      background: workMode === m ? t.btnPrimaryBg : "transparent",
                      color: workMode === m ? t.btnPrimaryText : t.textMuted,
                      border: `1px solid ${workMode === m ? t.btnPrimaryBg : t.border2}`,
                      WebkitAppearance: "none", touchAction: "manipulation",
                    }}>{m}</button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button onClick={() => setStep("input")} disabled={!contactReady} style={mkPrimary(t, contactReady)}>
                Continue →
              </button>
              {!contactReady && <span style={{ fontSize: 11, color: t.textMuted }}>Name and email required</span>}
            </div>
          </div>
        )}

        {/* ══ STEP 2: ROLE + BACKGROUND ══ */}
        {step === "input" && (
          <div style={{ animation: "fadeUp 0.35s ease" }}>
            <div style={{ marginBottom: 24 }}>
              <h1 style={{ fontFamily: serif, fontSize: isMobile ? 26 : 34, fontWeight: 800, lineHeight: 1.1, letterSpacing: -1, marginBottom: 10, color: t.text }}>
                The role<br /><span style={{ color: t.textMuted }}>and your story.</span>
              </h1>
            </div>

            {/* Candidate type toggle */}
            <div style={{ marginBottom: 20, padding: "14px 16px", background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 6 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: t.textMuted, marginBottom: 10, fontFamily: mono }}>
                Candidate Type
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[
                  { val: true,  label: "I have work experience" },
                  { val: false, label: "Student / No experience yet" },
                ].map(({ val, label }) => (
                  <button key={String(val)} onClick={() => setHasExperience(val)} style={{
                    padding: "8px 14px", borderRadius: 4, fontFamily: mono, fontSize: 11,
                    cursor: "pointer", transition: "all 0.15s", letterSpacing: "0.06em",
                    background: hasExperience === val ? t.btnPrimaryBg : "transparent",
                    color: hasExperience === val ? t.btnPrimaryText : t.textMuted,
                    border: `1px solid ${hasExperience === val ? t.btnPrimaryBg : t.border2}`,
                    WebkitAppearance: "none", touchAction: "manipulation",
                  }}>{label}</button>
                ))}
              </div>
            </div>

            {/* Target role */}
            <div style={{ marginBottom: 20 }}>
              <label style={lbl}>
                Target Role
                <span style={{ color: t.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>
                  — helps when JD is vague or you're changing careers
                </span>
              </label>
              <input type="text" style={inp} placeholder="e.g. Frontend Developer, Product Manager, Data Analyst"
                value={targetRole} onChange={e => setTargetRole(e.target.value)} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: isMobile ? 16 : 24 }}>
              <div>
                <label style={lbl}>
                  Job Posting
                  <span style={{ color: t.textMuted, fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>— optional if vague</span>
                </label>
                <textarea
                  style={{ ...inp, minHeight: isMobile ? 200 : 340, resize: "vertical", lineHeight: 1.7 }}
                  placeholder={"Paste the job posting here.\n\nIf the posting is vague, paste the title and company — the AI will infer requirements from your Target Role above."}
                  value={jobDesc} onChange={e => setJobDesc(e.target.value)} />
                <WordCount text={jobDesc} min={50} t={t} />
              </div>
              <div>
                <label style={lbl}>
                  Your Background <span style={{ color: "#f87171" }}>*</span>
                </label>
                <textarea
                  style={{ ...inp, minHeight: isMobile ? 200 : 340, resize: "vertical", lineHeight: 1.7 }}
                  placeholder={hasExperience
                    ? "Describe your background:\n\n• Previous roles, companies, dates\n• What you did and your impact\n• Numbers and results (rough is fine)\n• Skills, tools, technologies\n• Education and certifications\n\nNo format needed — write freely."
                    : "No experience? No problem. Describe:\n\n• Your degree, major, university, year\n• Relevant coursework or projects\n• Internships or part-time work\n• Clubs, volunteering, leadership\n• Skills and tools you know\n• Any personal or open-source projects\n\nWrite what you have — the AI will make it work."}
                  value={experience} onChange={e => setExperience(e.target.value)} />
                <WordCount text={experience} min={hasExperience ? 100 : 60} t={t} />
              </div>
            </div>

            {error && (
              <div style={{ color: t.errorText, fontSize: 11, marginTop: 14, fontFamily: mono, lineHeight: 1.6, background: t.errorBg, border: `1px solid ${t.errorBorder}`, borderRadius: 4, padding: "10px 14px" }}>
                ✕ {error}
              </div>
            )}

            <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button onClick={() => setStep("contact")} style={mkGhost(t)}>← Back</button>
              <button onClick={handleGenerate} disabled={!inputReady} style={mkPrimary(t, inputReady)}>
                Generate Resume →
              </button>
              <span style={{ fontSize: 10, color: t.textMuted }}>~15–30 seconds</span>
            </div>
          </div>
        )}

        {/* ══ LOADING ══ */}
        {step === "loading" && (
          <div style={{ textAlign: "center", padding: "100px 0", animation: "fadeUp 0.3s ease" }}>
            <div style={{ fontFamily: serif, fontSize: isMobile ? 22 : 28, marginBottom: 14, color: t.text }}>
              {hasExperience ? "Tailoring your resume..." : "Building your resume..."}
            </div>
            <div style={{ color: t.textMuted, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", animation: "pulse 2.5s infinite" }}>
              Extracting keywords · Mapping background · Optimizing for ATS
            </div>
            <div style={{ marginTop: 44, display: "flex", gap: 8, justifyContent: "center" }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: t.dotBg, animation: `pulse 1.4s ease ${i * 0.22}s infinite` }} />
              ))}
            </div>
          </div>
        )}

        {/* ══ RESULT ══ */}
        {step === "result" && result && atsData && (
          <div style={{ animation: "fadeUp 0.4s ease" }}>
            {/* Tab bar */}
            <div className="no-print" style={{ display: "flex", borderBottom: `1px solid ${t.border}`, marginBottom: 28 }}>
              {TABS.map(tab => {
                const active = resultTab === tab.id;
                return (
                  <button key={tab.id} onClick={() => setResultTab(tab.id)} style={{
                    background: "transparent", border: "none", cursor: "pointer",
                    fontFamily: mono, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase",
                    padding: "11px 18px", color: active ? t.tabActive : t.tabInactive,
                    borderBottom: `2px solid ${active ? t.tabActive : "transparent"}`,
                    marginBottom: -1, transition: "color 0.15s, border-color 0.15s",
                    WebkitAppearance: "none", touchAction: "manipulation",
                  }}>
                    {tab.label}
                    {tab.id === "analysis" && (
                      <span style={{
                        marginLeft: 7, fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 10,
                        background: atsData.overall >= 80 ? "#0f2a0a" : atsData.overall >= 60 ? "#2a2200" : "#2a0a0a",
                        color: atsData.overall >= 80 ? "#4ade80" : atsData.overall >= 60 ? "#facc15" : "#f87171",
                      }}>
                        {atsData.overall}
                      </span>
                    )}
                    {tab.id === "resume" && (
                      <button
                        onClick={e => { e.stopPropagation(); setShowKeywords(p => !p); setResultTab("resume"); }}
                        style={{
                          marginLeft: 6, fontSize: 8, padding: "1px 6px", borderRadius: 6,
                          background: showKeywords ? "#0f2a0a" : t.surface,
                          color: showKeywords ? "#4ade80" : t.textMuted,
                          border: `1px solid ${showKeywords ? "#2a4a2a" : t.border2}`,
                          cursor: "pointer", WebkitAppearance: "none", fontFamily: mono,
                        }}>
                        {showKeywords ? "kw ✓" : "kw"}
                      </button>
                    )}
                  </button>
                );
              })}
            </div>

            {resultTab === "analysis" && (
              <AnalysisTab
                atsData={atsData} gaps={result.gaps} flaggedPlaceholders={result.flaggedPlaceholders}
                coverLetter={coverLetter} coverLetterLoading={coverLetterLoading}
                onGenerateCoverLetter={handleGenerateCoverLetter}
                onViewResume={() => setResultTab("resume")}
                isMobile={isMobile} t={t}
              />
            )}

            {resultTab === "resume" && (
              <div style={{ animation: "fadeUp 0.25s ease" }}>
                <ResumePreview
                  resume={result.resume} onResumeChange={handleResumeChange}
                  jobDesc={jobDesc} atsData={atsData}
                  showKeywords={showKeywords} hasExperience={hasExperience} t={t}
                />
              </div>
            )}

            {resultTab === "coverletter" && (
              <CoverLetterTab
                coverLetter={coverLetter} coverLetterLoading={coverLetterLoading}
                onRegenerate={handleGenerateCoverLetter}
                resumeName={result.resume?.name}
                isMobile={isMobile} t={t}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
