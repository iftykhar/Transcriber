import { renderTranscript, type Renderer } from "../render-transcript";
import type { TranscriptSegment } from "../../types/transcript";

// The transcript panel, mounted into a Shadow DOM so neither the extension nor
// the host page can disturb the other. Meet and Zoom both ship aggressive
// global CSS, and a shadow root is the only reliable way to keep our panel
// looking the same on both.
//
// The stylesheet is fetched from the extension bundle and adopted via a
// constructable stylesheet, which avoids adding a <link> to a page-controlled
// document.

const HOST_ID = "bn-en-live-transcriber-overlay";

export interface OverlayPanel {
  append(segment: TranscriptSegment): void;
  clear(): void;
  destroy(): void;
}

function positionHost(host: HTMLElement): void {
  // Pinned bottom-right; `!important` because some sites style bare divs.
  const s = host.style;
  s.setProperty("position", "fixed", "important");
  s.setProperty("top", "auto", "important");
  s.setProperty("left", "auto", "important");
  s.setProperty("right", "16px", "important");
  s.setProperty("bottom", "16px", "important");
  s.setProperty("width", "360px", "important");
  s.setProperty("height", "280px", "important");
  s.setProperty("z-index", "2147483647", "important");
  s.setProperty("pointer-events", "auto", "important");
}

export function mountOverlayPanel(): OverlayPanel {
  // Guard against the content script being injected twice.
  const existing = document.getElementById(HOST_ID);
  existing?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  positionHost(host);

  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  // Inlined placeholder; the real sheet is swapped in asynchronously below so
  // the panel is never unstyled while the fetch is in flight.
  style.textContent = ":host{all:initial}";
  shadow.append(style);

  const root = document.createElement("div");
  root.className = "panel";

  const header = document.createElement("header");
  header.className = "panel-header";
  header.textContent = "Live transcript";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "panel-close";
  close.textContent = "\u00d7";
  close.setAttribute("aria-label", "Hide transcript");
  close.addEventListener("click", () => {
    host.style.setProperty("display", "none", "important");
  });
  header.append(close);

  const status = document.createElement("p");
  status.className = "panel-status";
  status.textContent = "Starting\u2026";

  const list = document.createElement("ul");
  list.className = "panel-list";

  root.append(header, status, list);
  shadow.append(root);
  document.documentElement.append(host);

  // Load the real stylesheet; failure is non-fatal (panel stays readable).
  void fetch(chrome.runtime.getURL("content/overlay/overlay.css"))
    .then((response) => response.text())
    .then((css) => {
      style.textContent = css;
    })
    .catch(() => {
      /* keep the minimal fallback */
    });

  const renderer: Renderer = renderTranscript(list);

  return {
    append(segment: TranscriptSegment): void {
      status.textContent = "Listening";
      renderer.append(segment);
    },
    clear(): void {
      renderer.clear();
      status.textContent = "Listening";
    },
    destroy(): void {
      host.remove();
    },
  };
}

export function setOverlayStatus(text: string): void {
  const host = document.getElementById(HOST_ID);
  const status = host?.shadowRoot?.querySelector(".panel-status");
  if (status) status.textContent = text;
}
