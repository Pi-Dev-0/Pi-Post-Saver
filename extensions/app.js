import { storyListener } from "./facebook/facebook.js";
import { fetchStoryFiles } from "./facebook/story.js";
import { getAttachmentCount, getDownloadCount } from "./facebook/posts.js";
import { isStoryPost, getStoryPostId, getStoryMessage, getStoryId, getCreateTime } from "./facebook/story.js";
import { isInstagramStory } from "./instagram/instagram.js";
import { isFacebookReel } from "./facebook/reels.js";
import { React, ReactDOM } from "./react.js";
import { useDownloadButtonInjection } from "./download-button.js";

/**
 * @typedef {import('./types').Story} Story
 * @typedef {import('./types').AppMessage} AppMessage
 * @typedef {import('./types').ChromeMessage} ChromeMessage
 */

const { useState, useEffect, useCallback, useMemo, useRef } = React;

/**
 * Hook to listen for Chrome extension messages of a specific type.
 * @template {ChromeMessage['type']} T
 * @param {T} type - The message type to listen for.
 * @param {(message: Extract<ChromeMessage, { type: T }>) => void} callback - Callback invoked when a matching message is received.
 */
function useChromeMessage(type, callback) {
  useEffect(() => {
    /** @param {MessageEvent<ChromeMessage & { __fpdl?: boolean }>} event */
    const listener = (event) => {
      if (event.source !== window) return;
      if (!event.data.__fpdl) return;
      if (event.data.type === type) {
        callback(
          /** @type {Extract<ChromeMessage, { type: T }>} */ (event.data),
        );
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [type, callback]);
}

/**
 * Send a message to the content script.
 * @param {AppMessage} message
 */
function sendAppMessage(message) {
  window.postMessage({ __fpdl: true, ...message }, window.location.origin);
}

/**
 * Fetch a blob URL and convert it to a Base64 data URL.
 * @param {string} blobUrl
 * @returns {Promise<string>}
 */
async function blobToDataUrl(blobUrl) {
  try {
    // Some browsers block fetch for blob URLs in certain contexts.
    // XHR is generally more reliable for blob URLs.
    const blob = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", blobUrl, true);
      xhr.responseType = "blob";
      xhr.onload = () => {
        if (xhr.status === 200 || xhr.status === 0) resolve(xhr.response);
        else reject(new Error(`XHR failed: ${xhr.status}`));
      };
      xhr.onerror = async () => {
        // Fallback to fetch if XHR fails
        try {
          const res = await fetch(blobUrl);
          if (res.ok) resolve(await res.blob());
          else reject(new Error("Fetch fallback failed"));
        } catch (e) {
          reject(new Error("XHR and Fetch failed"));
        }
      };
      xhr.send();
    });

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    console.warn("[fpdl] blobToDataUrl failed", err);
    throw err;
  }
}

/**
 * Download all files for a story.
 * @param {Story} story
 */
async function downloadStory(story) {
  let yielded = false;
  for await (const { storyId, url, filename } of fetchStoryFiles(story)) {
    yielded = true;
    await new Promise((r) => setTimeout(r, 200));
    sendAppMessage({ type: "FPDL_DOWNLOAD", storyId, url, filename });
  }

  // Fallback for placeholders if GraphQL yielded nothing
  if (!yielded && (/** @type {any} */ (story).placeholder)) {
    console.log("[fpdl] GraphQL failed for placeholder, trying DOM fallback...");
    const storyId = getStoryId(story);
    let mediaUrl = null;
    let ext = "mp4";

    if (isInstagramStory(story)) {
      const video = document.querySelector("section video, article video, main video, div[aria-label='Reels Viewer'] video");
      if (video) {
        // Try finding the real URL in React Fiber props (traversing up)
        // @ts-ignore
        const fiberKey = Object.keys(video).find((k) =>
          k.startsWith("__reactFiber$"),
        );
        if (fiberKey) {
          // @ts-ignore
          let fiber = video[fiberKey];
          while (fiber) {
            const props = fiber.memoizedProps;
            mediaUrl =
              props?.videoData?.$1?.playable_url_quality_hd ||
              props?.videoData?.$1?.browser_native_hd_url ||
              props?.videoData?.$1?.hd_src ||
              props?.videoData?.$1?.playable_url ||
              props?.videoData?.$1?.sd_src ||
              props?.children?.props?.children?.props?.implementations?.[0]
                ?.data?.hdSrc ||
              props?.videoData?.hdSrc ||
              props?.videoData?.sdSrc ||
              props?.item?.video_versions?.[0]?.url ||
              props?.video_versions?.[0]?.url ||
              props?.item?.image_versions2?.candidates?.[0]?.url ||
              props?.image_versions2?.candidates?.[0]?.url;

            if (
              mediaUrl &&
              typeof mediaUrl === "string" &&
              !mediaUrl.startsWith("blob:")
            )
              break;
            fiber = fiber.return;
          }
        }
        if (!mediaUrl || mediaUrl.startsWith("blob:")) {
          mediaUrl = video.querySelector("source")?.src || video.src;
        }
      } else {
        const img = document.querySelector("section img[srcset], section img.x5yr21d");
        if (img) {
          if (/** @type {HTMLImageElement} */ (img).srcset) {
            const sources = /** @type {HTMLImageElement} */ (img).srcset
              .split(",")
              .map((s) => {
                const [url, size] = s.trim().split(" ");
                return { url, width: parseInt(size) || 0 };
              });
            if (sources.length > 0) {
              mediaUrl = sources.sort((a, b) => b.width - a.width)[0].url;
            }
          }
          if (!mediaUrl) mediaUrl = (/** @type {HTMLImageElement} */ (img)).src;
          ext = "jpg";
        }
      }
    } else {
      // Facebook fallback - Similar to Instagram, try Fiber first
      const isReel = isFacebookReel(story) || window.location.href.includes("/reel/");
      const videoSelector = isReel ? 'div[role="main"] video, .x1useyqa video, .xpdmqnj video' : 'video';
      const video = document.querySelector(videoSelector) || document.querySelector('video');

      if (video) {
        // @ts-ignore
        const fiberKey = Object.keys(video).find((k) =>
          k.startsWith("__reactFiber$"),
        );
        if (fiberKey) {
          // @ts-ignore
          let fiber = video[fiberKey];
          while (fiber) {
            const props = fiber.memoizedProps;
            // Prioritize HD sources
            mediaUrl =
              props?.videoData?.$1?.playable_url_quality_hd ||
              props?.videoData?.$1?.browser_native_hd_url ||
              props?.videoData?.$1?.hd_src ||
              props?.videoData?.$1?.playable_url ||
              props?.videoData?.$1?.sd_src ||
              props?.children?.props?.children?.props?.implementations?.[0]
                ?.data?.hdSrc ||
              props?.implementations?.[0]?.data?.hdSrc ||
              props?.videoData?.hdSrc ||
              props?.videoData?.sdSrc ||
              props?.item?.video_versions?.[0]?.url ||
              props?.video_versions?.[0]?.url;

            if (
              mediaUrl &&
              typeof mediaUrl === "string" &&
              !mediaUrl.startsWith("blob:")
            )
              break;
            fiber = fiber.return;
          }
        }
        if (!mediaUrl || mediaUrl.startsWith("blob:")) {
          mediaUrl = video.src;
        }
      } else {
        const img = document.querySelector('img[draggable="false"], img.xlpa8m3');
        if (img && (/** @type {HTMLImageElement} */ (img).offsetHeight > 200 || /** @type {HTMLImageElement} */ (img).offsetWidth > 200)) {
          // Try to get highest resolution from srcset
          const srcset = (/** @type {HTMLImageElement} */ (img)).srcset || (/** @type {HTMLElement} */ (img)).getAttribute('srcset');
          if (srcset) {
            const sources = srcset.split(',').map(s => {
              const parts = s.trim().split(' ');
              const url = parts[0];
              const size = parts[1];
              return { url, width: parseInt(size) || 0 };
            });
            if (sources.length > 0) {
              mediaUrl = sources.sort((a, b) => b.width - a.width)[0].url;
            }
          }
          
          if (!mediaUrl) mediaUrl = (/** @type {HTMLImageElement} */ (img)).src;
          ext = "jpg";
        }
      }
    }

    if (mediaUrl) {
      const filename = `story_${storyId}.${ext}`;
      if (mediaUrl.startsWith('blob:')) {
        console.log("[fpdl] Found blob URL, converting to DataURL for download...");
        try {
          const dataUrl = await blobToDataUrl(mediaUrl);
          sendAppMessage({ type: "FPDL_DOWNLOAD", storyId, url: dataUrl, filename });
        } catch (err) {
          console.warn("[fpdl] Failed to convert blob to DataURL, download will likely fail", err);
          // Send it anyway, maybe the background can fetch it (unlikely but worth a shot)
          sendAppMessage({ type: "FPDL_DOWNLOAD", storyId, url: mediaUrl, filename });
        }
      } else {
        sendAppMessage({ type: "FPDL_DOWNLOAD", storyId, url: mediaUrl, filename });
      }
    }
  }
}

/**
 * Inject styles for the FPDL UI.
 */
function injectStyles() {
  if (document.getElementById("fpdl-styles")) return;

  const style = document.createElement("style");
  style.id = "fpdl-styles";
  style.textContent = `

        :root {
            --fpdl-bg: rgba(18, 18, 24, 0.85);
            --fpdl-border: rgba(255, 255, 255, 0.08);
            --fpdl-text: #ececec;
            --fpdl-text-muted: #a0a0a0;
            --fpdl-accent: #3b82f6; /* Modern Blue */
            --fpdl-accent-hover: #2563eb;
            --fpdl-success: #10b981;
            --fpdl-success-bg: rgba(16, 185, 129, 0.1);
            --fpdl-warning: #f59e0b;
            --fpdl-warning-bg: rgba(245, 158, 11, 0.1);
            --fpdl-radius: 12px;
            --fpdl-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            --fpdl-shadow: 0 10px 40px -10px rgba(0,0,0,0.5);
        }

        .fpdl-container {
            position: fixed;
            left: 20px;
            bottom: 20px;
            z-index: 999999;
            width: 800px;
            max-width: 95vw;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            background: var(--fpdl-bg);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            color: var(--fpdl-text);
            border: 1px solid var(--fpdl-border);
            border-radius: var(--fpdl-radius);
            box-shadow: var(--fpdl-shadow);
            font-family: var(--fpdl-font);
            font-size: 13px;
            overflow: hidden;
            opacity: 0;
            transform: translateY(20px) scale(0.95);
            animation: fpdl-fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        @keyframes fpdl-fade-in {
            to { opacity: 1; transform: translateY(0) scale(1); }
        }

        /* Scrollbar Styling */
        .fpdl-container ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }
        .fpdl-container ::-webkit-scrollbar-track {
            background: transparent;
        }
        .fpdl-container ::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.15);
            border-radius: 3px;
        }
        .fpdl-container ::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.25);
        }

        .fpdl-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            background: rgba(255, 255, 255, 0.03);
            border-bottom: 1px solid var(--fpdl-border);
            flex-shrink: 0;
        }

        .fpdl-title {
            font-size: 14px;
            font-weight: 600;
            color: #fff;
            letter-spacing: 0.3px;
            flex: 1;
            padding: 0 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .fpdl-actions {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .fpdl-btn {
            appearance: none;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.05);
            color: var(--fpdl-text);
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            outline: none;
            display: inline-flex;
            align-items: center;
            height: 28px;
        }

        .fpdl-btn:hover {
            background: rgba(255, 255, 255, 0.15);
            border-color: rgba(255, 255, 255, 0.1);
            transform: translateY(-1px);
        }

        .fpdl-btn:active {
            transform: translateY(0);
        }

        .fpdl-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none !important;
        }

        .fpdl-btn.primary {
            background: var(--fpdl-accent);
            border-color: transparent;
            color: white;
            box-shadow: 0 2px 5px rgba(59, 130, 246, 0.3);
        }
        .fpdl-btn.primary:hover {
            background: var(--fpdl-accent-hover);
            box-shadow: 0 4px 8px rgba(59, 130, 246, 0.4);
        }

        .fpdl-close-btn {
            background: transparent;
            border: none;
            color: var(--fpdl-text-muted);
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            cursor: pointer;
            font-size: 20px;
            transition: all 0.2s;
            margin-left: 8px;
        }
        .fpdl-close-btn:hover {
            background: rgba(255,255,255,0.1);
            color: #fff;
        }

        .fpdl-sponsor-btn {
            color: #ec4899; /* Pink-500 */
            text-decoration: none;
            font-size: 16px;
            opacity: 0.8;
            transition: transform 0.2s;
            display: flex;
            align-items: center;
            padding: 0 4px;
        }
        .fpdl-sponsor-btn:hover {
            opacity: 1;
            transform: scale(1.1);
        }

        .fpdl-table-container {
            flex: 1;
            overflow-y: auto;
            position: relative;
        }

        .fpdl-table {
            width: 100%;
            border-collapse: separate; /* Allows border-radius on rows if needed */
            border-spacing: 0;
            text-align: left;
        }

        .fpdl-th {
            position: sticky;
            top: 0;
            background: rgba(28, 28, 35, 0.95);
            backdrop-filter: blur(8px);
            color: var(--fpdl-text-muted);
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            padding: 10px 12px;
            border-bottom: 1px solid var(--fpdl-border);
            z-index: 10;
        }

        .fpdl-td {
            padding: 10px 12px;
            border-bottom: 1px solid var(--fpdl-border);
            color: var(--fpdl-text);
            vertical-align: middle;
            transition: background 0.15s;
        }

        .fpdl-table tr:last-child .fpdl-td {
            border-bottom: none;
        }

        .fpdl-table tbody tr:hover td {
            background: rgba(255, 255, 255, 0.04);
        }

        /* Column Widths */
        .fpdl-col-check { width: 40px; text-align: center; }
        .fpdl-col-date { width: 140px; }
        .fpdl-col-id { width: 120px; }
        .fpdl-col-msg { max-width: 200px; }
        .fpdl-col-meta { width: 80px; text-align: center; }

        /* Checkbox */
        input[type="checkbox"] {
            appearance: none;
            width: 16px;
            height: 16px;
            border: 1.5px solid var(--fpdl-text-muted);
            border-radius: 4px;
            background: transparent;
            cursor: pointer;
            position: relative;
            transition: all 0.2s;
        }
        input[type="checkbox"]:checked {
            background: var(--fpdl-accent);
            border-color: var(--fpdl-accent);
        }
        input[type="checkbox"]:checked::after {
            content: '';
            position: absolute;
            left: 4px;
            top: 1px;
            width: 5px;
            height: 9px;
            border: solid white;
            border-width: 0 2px 2px 0;
            transform: rotate(45deg);
        }

        /* Message Truncation */
        .fpdl-msg-text {
            display: block;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 100%;
            color: rgba(255, 255, 255, 0.8);
        }

        /* Status States */
        .fpdl-row-selected td {
            background: rgba(59, 130, 246, 0.15) !important;
        }

        .fpdl-row-pending td {
             /* Default state */
        }

        .fpdl-row-downloading td {
            background: var(--fpdl-warning-bg) !important;
            color: var(--fpdl-warning);
        }
        
        .fpdl-row-downloaded td {
            background: var(--fpdl-success-bg) !important;
            color: var(--fpdl-success);
        }

        .fpdl-status-pill {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .fpdl-status-downloading {
            background: rgba(245, 158, 11, 0.2);
            color: #fbbf24;
            animation: fpdl-pulse 2s infinite;
        }
        .fpdl-status-done {
            background: rgba(16, 185, 129, 0.2);
            color: #34d399;
        }

        @keyframes fpdl-pulse {
            0% { opacity: 0.6; }
            50% { opacity: 1; }
            100% { opacity: 0.6; }
        }
    `;
  document.head.appendChild(style);
}

/**
 * Render a single story row in the table.
 * @param {{ story: Story, selected: boolean, onToggle: () => void, downloadedCount: number | undefined }} props
 */
function StoryRow({ story, selected, onToggle, downloadedCount }) {
  const total = getDownloadCount(story);
  const isPending = downloadedCount === 0;
  const isDownloading =
    downloadedCount !== undefined &&
    downloadedCount > 0 &&
    downloadedCount < total;
  const isDownloaded =
    downloadedCount !== undefined && downloadedCount >= total;

  let className = undefined;
  if (isDownloaded) {
    className = "fpdl-row-downloaded";
  } else if (isDownloading) {
    className = "fpdl-row-downloading";
  } else if (isPending) {
    className = "fpdl-row-pending";
  } else if (selected) {
    className = "fpdl-row-selected";
  }

  return React.createElement(
    "tr",
    {
      className,
      onClick: downloadedCount === undefined ? onToggle : undefined,
      style: downloadedCount === undefined ? { cursor: "pointer" } : undefined,
    },
    React.createElement(
      "td",
      { className: "fpdl-td fpdl-col-check" },
      downloadedCount !== undefined
        ? React.createElement(
            "span",
            {
              className: `fpdl-status-pill ${
                isDownloaded ? "fpdl-status-done" : "fpdl-status-downloading"
              }`,
            },
            isDownloaded ? "Done" : `${downloadedCount}/${total}`,
          )
        : React.createElement("input", {
            type: "checkbox",
            checked: selected,
            onChange: onToggle,
            onClick: (/** @type {MouseEvent} */ e) => e.stopPropagation(),
          }),
    ),
    React.createElement(
      "td",
      { className: "fpdl-td fpdl-col-date" },
      getCreateTime(story)?.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }) ?? "",
    ),
    React.createElement(
      "td",
      { className: "fpdl-td fpdl-col-id" },
      getStoryPostId(story),
    ),
    React.createElement(
      "td",
      { className: "fpdl-td fpdl-col-msg" },
      React.createElement(
        "span",
        { className: "fpdl-msg-text", title: getStoryMessage(story) },
        getStoryMessage(story) ?? "",
      ),
    ),
    React.createElement(
      "td",
      { className: "fpdl-td fpdl-col-meta" },
      isStoryPost(story) && story.attached_story ? "Yes" : "-",
    ),
    React.createElement(
      "td",
      { className: "fpdl-td fpdl-col-meta" },
      getAttachmentCount(story),
    ),
  );
}

/**
 * Render the story table with headers and rows.
 * @param {{ stories: Story[], selectedStories: Set<string>, toggleStory: (story: Story) => void, toggleAllStories: () => void, downloadingStories: { [storyId: string]: number } }} props
 */
function StoryTable({
  stories,
  selectedStories,
  toggleStory,
  toggleAllStories,
  downloadingStories,
}) {
  const selectableStories = stories.filter(
    (s) => !(getStoryId(s) in downloadingStories),
  );
  const allSelected =
    selectableStories.length > 0 &&
    selectableStories.every((s) => selectedStories.has(getStoryId(s)));

  return React.createElement(
    "div",
    { className: "fpdl-table-container" },
    React.createElement(
      "table",
      { className: "fpdl-table" },
      React.createElement(
        "thead",
        null,
        React.createElement(
          "tr",
          null,
          React.createElement(
            "th",
            { className: "fpdl-th fpdl-col-check" },
            React.createElement("input", {
              type: "checkbox",
              checked: allSelected,
              onChange: toggleAllStories,
              disabled: selectableStories.length === 0,
            }),
          ),
          React.createElement(
            "th",
            { className: "fpdl-th fpdl-col-date" },
            "Date",
          ),
          React.createElement("th", { className: "fpdl-th fpdl-col-id" }, "ID"),
          React.createElement(
            "th",
            { className: "fpdl-th fpdl-col-msg" },
            "Message",
          ),
          React.createElement(
            "th",
            { className: "fpdl-th fpdl-col-meta" },
            "Sub-Post",
          ),
          React.createElement(
            "th",
            { className: "fpdl-th fpdl-col-meta" },
            "Files",
          ),
        ),
      ),
      React.createElement(
        "tbody",
        null,
        stories.map((story) =>
          React.createElement(StoryRow, {
            key: getStoryId(story),
            story,
            selected: selectedStories.has(getStoryId(story)),
            onToggle: () => toggleStory(story),
            downloadedCount: downloadingStories[getStoryId(story)],
          }),
        ),
      ),
    ),
  );
}

/**
 * Render a button to hide/unhide stories based on current state.
 * @param {{ selectedStories: Set<string>, visibleStories: Story[], downloadingStories: { [storyId: string]: number }, hiddenStories: Set<string>, clearSelectedStories: () => void, setHiddenStories: (updater: (prev: Set<string>) => Set<string>) => void }} props
 */
function HideButton({
  selectedStories,
  visibleStories,
  downloadingStories,
  hiddenStories,
  clearSelectedStories,
  setHiddenStories,
}) {
  const downloadedStoryIds = useMemo(
    () =>
      visibleStories
        .filter((s) => {
          const id = getStoryId(s);
          const downloadingCount = downloadingStories[id];
          return downloadingCount === getDownloadCount(s);
        })
        .map((s) => getStoryId(s)),
    [visibleStories, downloadingStories],
  );

  const hideSelected = useCallback(() => {
    trackEvent("SelectedStoriesHidden", { count: selectedStories.size });
    setHiddenStories((prev) => new Set([...prev, ...selectedStories]));
    clearSelectedStories();
  }, [selectedStories, setHiddenStories, clearSelectedStories]);

  const hideDownloaded = useCallback(() => {
    trackEvent("DownloadedStoriesHidden", { count: downloadedStoryIds.length });
    setHiddenStories((prev) => new Set([...prev, ...downloadedStoryIds]));
    clearSelectedStories();
  }, [downloadedStoryIds, setHiddenStories, clearSelectedStories]);

  const unhide = useCallback(() => {
    trackEvent("StoriesUnhidden", { count: hiddenStories.size });
    setHiddenStories(() => new Set());
    clearSelectedStories();
  }, [hiddenStories.size, setHiddenStories, clearSelectedStories]);

  let label = null;
  let action = null;

  if (selectedStories.size > 0) {
    label = `Hide selected (${selectedStories.size})`;
    action = hideSelected;
  } else if (downloadedStoryIds.length > 0) {
    label = `Hide downloaded (${downloadedStoryIds.length})`;
    action = hideDownloaded;
  } else if (hiddenStories.size > 0) {
    label = `Unhide (${hiddenStories.size})`;
    action = unhide;
  }

  if (!label) return null;

  return React.createElement(
    "button",
    {
      type: "button",
      className: "fpdl-btn",
      onClick: action,
      style: { marginLeft: "8px" },
    },
    label,
  );
}

/**
 * Hook to manage dialog open/close state.
 * @param {{ clearSelectedStories: () => void }} params
 * @returns {{ open: boolean, closeDialog: () => void }}
 */
function useDialogOpen({ clearSelectedStories }) {
  const [open, setOpen] = useState(false);
  const hasRendered = React.useRef(false);

  const closeDialog = useCallback(() => {
    setOpen(false);
    clearSelectedStories();
    trackEvent("DialogClosed");
  }, [clearSelectedStories]);

  useChromeMessage(
    "FPDL_TOGGLE",
    useCallback(() => {
      if (!hasRendered.current) {
        hasRendered.current = true;
        window.scrollBy(0, 1);
      }
      setOpen((v) => {
        const newOpen = !v;
        trackEvent("DialogToggled", { open: newOpen });
        return newOpen;
      });
    }, []),
  );

  return { open, closeDialog };
}

/**
 * Hook to listen for new stories and update badge count.
 * @param {{ initialStories: Story[], onStory: (cb: (story: Story) => void) => void }} params
 * @returns {Story[]}
 */
function useStoryListener({ initialStories, onStory }) {
  const [stories, setStories] = useState(initialStories);

  useEffect(() => {
    onStory((story) => {
      setStories((prev) => [...prev, story]);
    });
  }, [onStory]);

  useEffect(() => {
    sendAppMessage({ type: "FPDL_STORY_COUNT", count: stories.length });
  }, [stories.length]);

  return stories;
}

/**
 * Hook to manage story selection state.
 * @param {{ stories: Story[], visibleStories: Story[] }} params
 * @returns {{ selectedStories: Set<string>, toggleStory: (story: Story) => void, toggleAllStories: () => void, clearSelectedStories: () => void }}
 */
function useSelectedStories({ stories, visibleStories }) {
  const [selectedStories, setSelectedStories] = useState(
    /** @type {Set<string>} */ (new Set()),
  );

  const toggleStory = useCallback(
    (/** @type {Story} */ story) => {
      const id = getStoryId(story);
      setSelectedStories((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          trackEvent("StoryDeselected", { storiesCount: stories.length });
        } else {
          next.add(id);
          trackEvent("StorySelected", { storiesCount: stories.length });
        }
        return next;
      });
    },
    [stories.length],
  );

  const toggleAllStories = useCallback(() => {
    setSelectedStories((prev) => {
      const allSelected = visibleStories.every((s) => prev.has(getStoryId(s)));
      if (allSelected) {
        trackEvent("AllStoriesDeselected", {
          visibleCount: visibleStories.length,
          storiesCount: stories.length,
        });
        return new Set();
      } else {
        trackEvent("AllStoriesSelected", {
          visibleCount: visibleStories.length,
          storiesCount: stories.length,
        });
        return new Set(visibleStories.map((s) => getStoryId(s)));
      }
    });
  }, [stories.length, visibleStories]);

  const clearSelectedStories = useCallback(() => {
    setSelectedStories(new Set());
  }, []);

  return {
    selectedStories,
    toggleStory,
    toggleAllStories,
    clearSelectedStories,
  };
}

/**
 * Hook to filter visible stories based on hidden state.
 * @param {{ stories: Story[] }} params
 * @returns {{ visibleStories: Story[], hiddenStories: Set<string>, setHiddenStories: React.Dispatch<React.SetStateAction<Set<string>>> }}
 */
function useVisibleStories({ stories }) {
  const [hiddenStories, setHiddenStories] = useState(
    /** @type {Set<string>} */ (new Set()),
  );

  const visibleStories = useMemo(
    () => stories.filter((s) => !hiddenStories.has(getStoryId(s))),
    [stories, hiddenStories],
  );

  return { visibleStories, hiddenStories, setHiddenStories };
}

/**
 * Hook to manage story download state and download logic.
 * @param {{ stories: Story[], visibleStories: Story[], selectedStories: Set<string>, clearSelectedStories: () => void }} params
 * @returns {{ downloadingStories: { [storyId: string]: number }, downloadStories: () => void }}
 */
function useDownloadingStories({
  stories,
  visibleStories,
  selectedStories,
  clearSelectedStories,
}) {
  const [downloadingStories, setDownloadingStories] = useState(
    /** @type {{ [storyId: string]: number }} */ ({}),
  );
  const downloadQueueRef = React.useRef(/** @type {Story[]} */ ([]));
  const isProcessingRef = React.useRef(false);

  useChromeMessage(
    "FPDL_DOWNLOAD_RESULT",
    useCallback((message) => {
      setDownloadingStories((prev) => ({
        ...prev,
        [message.storyId]: (prev[message.storyId] ?? 0) + 1,
      }));
    }, []),
  );

  const processDownloadQueue = useCallback(async () => {
    if (isProcessingRef.current) return;
    if (downloadQueueRef.current.length === 0) return;

    isProcessingRef.current = true;

    while (downloadQueueRef.current.length > 0) {
      const story = downloadQueueRef.current.shift();
      if (!story) break;

      try {
        await downloadStory(story);
      } catch (err) {
        console.error(
          "[fpdl] download failed for story",
          getStoryId(story),
          err,
        );
      }

      if (downloadQueueRef.current.length > 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    isProcessingRef.current = false;
  }, []);

  const downloadStories = useCallback(() => {
    const storiesToDownload = visibleStories.filter((s) =>
      selectedStories.has(getStoryId(s)),
    );
    if (storiesToDownload.length === 0) return;

    trackEvent("DownloadClicked", {
      downloadCount: storiesToDownload.length,
      visibleCount: visibleStories.length,
      storiesCount: stories.length,
    });

    clearSelectedStories();

    // Mark stories as queued (0 downloads) for UI feedback
    setDownloadingStories((prev) => {
      const next = { ...prev };
      for (const story of storiesToDownload) {
        next[getStoryId(story)] = 0;
      }
      return next;
    });

    // Add stories to queue
    downloadQueueRef.current.push(...storiesToDownload);

    // Start processing the queue
    processDownloadQueue();
  }, [
    selectedStories,
    visibleStories,
    clearSelectedStories,
    processDownloadQueue,
  ]);

  return { downloadingStories, downloadStories };
}

/**
 * Main application component for the Social Post Downloader.
 * @param {{ initialStories: Story[], onStory: (cb: (story: Story) => void) => void }} props
 */
function App({ initialStories, onStory }) {
  const stories = useStoryListener({ initialStories, onStory });
  const { visibleStories, hiddenStories, setHiddenStories } = useVisibleStories(
    { stories },
  );
  const {
    selectedStories,
    toggleStory,
    toggleAllStories,
    clearSelectedStories,
  } = useSelectedStories({ stories, visibleStories });
  const { downloadingStories, downloadStories } = useDownloadingStories({
    stories,
    visibleStories,
    selectedStories,
    clearSelectedStories,
  });

  const { open, closeDialog } = useDialogOpen({ clearSelectedStories });

  const downloadingCountRef = useRef({ downloadingCount: 0, storiesCount: 0 });
  downloadingCountRef.current = {
    downloadingCount: Object.keys(downloadingStories).length,
    storiesCount: stories.length,
  };

  useEffect(() => {
    const handleUnload = () => {
      // trackEvent("PageUnloaded", downloadingCountRef.current);
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, []);

  useDownloadButtonInjection(
    stories,
    useCallback(async (story) => {
      // trackEvent("InjectedDownloadClicked", downloadingCountRef.current);
      await downloadStory(story);
    }, []),
  );

  if (!open) return null;

  return React.createElement(
    "div",
    { className: "fpdl-container" },
    React.createElement(
      "div",
      { className: "fpdl-header" },
      React.createElement(
        "div",
        { className: "fpdl-actions" },
        React.createElement(
          "a",
          {
            className: "fpdl-sponsor-btn",
            href: "https://rashid-sahriar.blogspot.com/",
            target: "_blank",
            rel: "noopener noreferrer",
            title: "Sponsor",
          },
          "♥",
        ),
        React.createElement(
          "div",
          { className: "fpdl-title" },
          `Social Downloader (${visibleStories.length})`,
        ),
      ),
      React.createElement(
        "div",
        { className: "fpdl-actions" },
        React.createElement(HideButton, {
          selectedStories,
          visibleStories,
          downloadingStories,
          hiddenStories,
          clearSelectedStories,
          setHiddenStories,
        }),
        React.createElement(
          "button",
          {
            type: "button",
            className: "fpdl-btn primary",
            onClick: downloadStories,
            disabled: selectedStories.size === 0,
          },
          `Download ${
            selectedStories.size > 0 ? `(${selectedStories.size})` : ""
          }`,
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "fpdl-close-btn",
            onClick: closeDialog,
            title: "Close",
          },
          "×",
        ),
      ),
    ),
    React.createElement(StoryTable, {
      stories: visibleStories,
      selectedStories,
      toggleStory,
      toggleAllStories,
      downloadingStories,
    }),
  );
}

function run() {
  injectStyles();

  /** @type {Story[]} */
  const collectedStories = [];
  /** @type {((story: Story) => void) | null} */
  let storyCallback = null;

  storyListener((story) => {
    if (storyCallback) {
      storyCallback(story);
    } else {
      collectedStories.push(story);
    }
  });

  const container = document.createElement("div");
  container.id = "fpdl-post-table-root";
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);

  root.render(
    React.createElement(App, {
      initialStories: collectedStories,
      onStory: (cb) => {
        storyCallback = cb;
      },
    }),
  );
}

run();
