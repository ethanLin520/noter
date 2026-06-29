// Note export. Markdown is a pure client-side download of the raw text already
// in editor state; PDF is rendered server-side (md-to-pdf + github-markdown-css)
// and downloaded as a blob. No new dependencies.
import { exportPdf } from "./api";

/** Strip path-hostile chars so the download name is safe across OSes. */
function safeFilename(name: string): string {
  const base = (name || "note").replace(/\.md$/i, "").trim();
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[/\\:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim();
  return (cleaned || "note").slice(0, 120);
}

/** Trigger a browser download of `data` as `filename` via a temporary anchor. */
function triggerDownload(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Download the raw markdown (already in editor state) as <name>.md. */
export function downloadMarkdown(name: string, markdown: string) {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  triggerDownload(blob, `${safeFilename(name)}.md`);
}

/** Request a server-rendered PDF and download it as <name>.pdf. */
export async function exportNotePdf(name: string, markdown: string) {
  const blob = await exportPdf(name, markdown);
  triggerDownload(blob, `${safeFilename(name)}.pdf`);
}
