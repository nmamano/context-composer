// Clipboard helper — F-009 (plans/ui-feedback.md). navigator.clipboard exists
// only in SECURE contexts; the daemon is browsed over plain http (tailscale
// host), so fall back to the legacy textarea + execCommand path there.

export function copyText(text: string): void {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
    return;
  }
  if (typeof document.execCommand !== "function") return;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}
