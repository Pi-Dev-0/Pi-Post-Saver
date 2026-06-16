import { getStoryUrl, getStoryId, getStoryPostId } from "./facebook/story.js";
import { React } from "./react.js";

/**
 * @typedef {import('./types').Story} Story
 */

const { useEffect } = React;

/**
 * Module-level stories registry — always holds the latest stories from React state.
 * Needed because injectStoryButtons injects one persistent button per controlBar
 * and never replaces it, making the closure's `stories` reference stale after
 * subsequent React renders. This variable is updated on every render.
 * @type {import('./types').Story[]}
 */
let _currentStories = [];

export function getCurrentStories() {
  return _currentStories;
}

/**
 * Check if a container is the "active" reel in the viewport.
 * @param {Element} container
 * @returns {boolean}
 */
export function isActiveReel(container) {
  const rect = container.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  // Check if the center of the container is close to the center of the viewport
  const containerCenter = rect.top + rect.height / 2;
  const viewportCenter = viewportHeight / 2;
  // Threshold: within 50% of viewport center (relaxed for better detection)
  return Math.abs(containerCenter - viewportCenter) < viewportHeight * 0.5;
}

/**
 * Extract a value from React fiber using an accessor function.
 * @param {Element} element
 * @param {(props: any) => string | undefined} accessor
 * @param {number} [maxDepth=50]
 * @returns {string | null}
 */
export function getValueFromReactFiber(element, accessor, maxDepth = 50) {
  const fiberKey = Object.keys(element || {}).find((k) =>
    k.startsWith("__reactFiber$"),
  );
  if (!fiberKey) return null;

  // @ts-ignore - accessing React internals
  let currentFiber = element[fiberKey];
  let visited = 0;

  while (currentFiber && visited < maxDepth) {
    visited++;
    const props = currentFiber.memoizedProps;

    const value = accessor(props);
    if (value) {
      return value;
    }

    currentFiber = currentFiber.return;
  }

  return null;
}

/**
 * Create a download button element styled to match Facebook's action buttons.
 * @param {Story} story
 * @param {(story: Story) => Promise<void>} downloadStory
 * @returns {HTMLButtonElement}
 */
export function createDownloadButton(story, downloadStory) {
  const btn = document.createElement("button");
  btn.className = "fpdl-download-btn";
  btn.setAttribute("aria-label", "Download Facebook post");

  // SVG download icon
  btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M12 3c.55 0 1 .45 1 1v9.59l2.3-2.3a1.003 1.003 0 0 1 1.42 1.42l-4 4a1 1 0 0 1-1.42 0l-4-4a1.003 1.003 0 0 1 1.42-1.42l2.28 2.3V4c0-.55.45-1 1-1zm-7 16c-.55 0-1 .45-1 1s.45 1 1 1h14c.55 0 1-.45 1-1s-.45-1-1-1H5z"/>
        </svg>
    `;

  let downloading = false;
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (downloading) return;
    downloading = true;
    btn.style.opacity = "0.5";
    btn.style.cursor = "wait";

    try {
      await downloadStory(story);
    } catch (err) {
      console.warn("[fpdl] download failed", err);
    } finally {
      downloading = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
  });

  return btn;
}

/**
 * Create a debounced version of a function.
 * @template {(...args: any[]) => void} T
 * @param {T} fn
 * @param {number} delay
 * @returns {{ call: T, cancel: () => void }}
 */
function debounce(fn, delay) {
  let timer = 0;
  return {
    call: /** @type {T} */ (
      (...args) => {
        clearTimeout(timer);
        timer = window.setTimeout(() => fn(...args), delay);
      }
    ),
    cancel: () => clearTimeout(timer),
  };
}

/**
 * Find a matching story for an action button using common matching strategies.
 * @param {Element} actionBtn
 * @param {Story[]} stories
 * @returns {Story | null}
 */
export function findStoryForButton(actionBtn, stories) {
  // Match by story.id
  const storyId = getValueFromReactFiber(actionBtn, (p) => p?.story?.id);
  if (storyId) {
    const story = stories.find((s) => getStoryId(s) === storyId);
    if (story) return story;
  }

  // Fall back to matching by storyPostID
  const postId = getValueFromReactFiber(actionBtn, (p) => p?.storyPostID);
  if (postId) {
    const story = stories.find((s) => getStoryPostId(s) === postId);
    if (story) return story;
  }

  // Fall back to matching by permalink_url to story URL
  const permalinkUrl = getValueFromReactFiber(
    actionBtn,
    (p) => p?.story?.permalink_url,
  );
  if (permalinkUrl) {
    const story = stories.find((s) => getStoryUrl(s) === permalinkUrl);
    if (story) return story;
  }

  return null;
}

import { 
  injectPostFeedButtons, 
  injectVideoFeedButtons, 
  injectWatchVideoButtons, 
  injectReelsButtons, 
  injectStoryButtons 
} from "./facebook/download-button.js";

import { 
  injectInstagramButtons, 
  injectInstagramStoryButtons 
} from "./instagram/download-button.js";

/**
 * Inject download buttons into all supported page types.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
function injectDownloadButtons(stories, downloadStory) {
  if (window.location.hostname.includes("facebook.com")) {
    injectPostFeedButtons(stories, downloadStory);
    injectVideoFeedButtons(stories, downloadStory);
    injectWatchVideoButtons(stories, downloadStory);
    injectReelsButtons(stories, downloadStory);
    injectStoryButtons(stories, downloadStory);
  } else if (window.location.hostname.includes("instagram.com")) {
    injectInstagramButtons(stories, downloadStory);
    injectInstagramStoryButtons(stories, downloadStory);
  }
}

/**
 * Inject CSS styles for download buttons.
 */
function injectDownloadButtonStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .fpdl-download-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            border: none;
            background: transparent;
            color: #006aceff;
            cursor: pointer;
            padding: 0;
            transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
        .fpdl-download-btn:hover {
            background: rgba(59, 130, 246, 0.15);
            color: #3b82f6;
            transform: scale(1.15);
        }
        .fpdl-download-btn svg {
            filter: drop-shadow(0 1px 2px rgba(0,0,0,0.1));
        }
        .fpdl-download-btn--video,
        .fpdl-download-btn--video:hover {
            background: transparent;
        }
        .fpdl-download-btn--video {
            position: relative;
            align-self: flex-start;
            width: 32px;
            height: 32px;
            margin-right: 8px;
        }
        .fpdl-download-btn--video::before {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 36px;
            height: 36px;
            border-radius: 50%;
            z-index: -1;
            transition: background 0.2s;
        }
        .fpdl-download-btn--video:hover::before {
             background: rgba(59, 130, 246, 0.15);
        }
        .fpdl-download-btn-wrapper {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 48px;
            margin-right: 8px;
        }
        .fpdl-download-btn--watch {
            width: 48px;
            height: 36px;
            border-radius: 8px;
            color: white;
            background: #1877f2;
        }
        .fpdl-download-btn--watch:hover {
             background: #166fe5;
        }
        .fpdl-download-btn--instagram-header {
            color: #006aceff;
            opacity: 0.8;
            border: 1px solid white;
            width: 40px;
            height: 40px;
            background: transparent;
            margin-right: 4px;
            margin-left: 6px;
        }
        .fpdl-download-btn--instagram-header:hover {
            opacity: 1;
            transform: scale(1.1);
        }
        .fpdl-download-btn--instagram-reel {
            color: white;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            width: 40px !important;
            height: 40px !important;
            border-radius: 50%;
            margin-bottom: 16px;
        }
        .fpdl-download-btn--instagram-reel:hover {
            background: rgba(255, 255, 255, 0.2);
            transform: scale(1.1);
        }
        .fpdl-download-btn--facebook-feed {
            color: #006aceff !important;
            opacity: 0.8 !important;
            border: 1px solid white !important;
            width: 36px !important;
            height: 36px !important;
            background: transparent !important;
            margin-right: 8px !important;
        }
        .fpdl-download-btn--facebook-feed:hover {
            opacity: 1 !important;
            background: rgba(0, 106, 206, 0.05) !important;
            transform: scale(1.1) !important;
        }
        .xrvj5dj {
            display: flex !important;
        }
        .fpdl-download-btn-story {
            display: flex !important;
            align-items: center;
            justify-content: center;
            width: 36px !important;
            height: 36px !important;
            border-radius: 50% !important;
            background-color: rgba(255, 255, 255, 0.1) !important;
            border: none !important;
            cursor: pointer !important;
            color: white !important;
            margin-right: 8px !important;
            opacity: 1 !important;
        }
    `;
  document.head.appendChild(style);
}

/**
 * Initialize SPA URL-change detection in the main page world.
 * Facebook uses React Router, so we monkeypatch history.pushState and replaceState
 * to detect when the user navigates (e.g. from Home to a specific Reel) without
 * a full page reload, and dispatch our custom 'fpdl_urlchange' event.
 */
function initSpaNavigationTracker() {
  if (window.__fpdl_spa_tracker_initialized) return;
  window.__fpdl_spa_tracker_initialized = true;

  function dispatchUrlChange() {
    window.dispatchEvent(new Event("fpdl_urlchange"));
    // Fire again after delays because React might take time to fetch and render the new page's DOM
    setTimeout(() => window.dispatchEvent(new Event("fpdl_urlchange")), 1000);
    setTimeout(() => window.dispatchEvent(new Event("fpdl_urlchange")), 2000);
  }

  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    dispatchUrlChange();
  };

  const _replaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _replaceState(...args);
    dispatchUrlChange();
  };

  window.addEventListener("popstate", dispatchUrlChange);
}

// Run the tracker initialization as soon as this module loads
initSpaNavigationTracker();

/**
 * React hook to inject download buttons into posts.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
export function useDownloadButtonInjection(stories, downloadStory) {
  // Keep module-level registry fresh on every render so the persistent story
  // download button always resolves against the latest story list.
  _currentStories = stories;

  useEffect(() => {
    injectDownloadButtonStyles();
  }, []);

  useEffect(() => {
    const { call: inject, cancel } = debounce(
      () => injectDownloadButtons(stories, downloadStory),
      250, // slightly longer debounce helps batch React's async renders
    );

    const observer = new MutationObserver(inject);
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("fpdl_urlchange", inject);

    inject();

    return () => {
      cancel();
      observer.disconnect();
      window.removeEventListener("fpdl_urlchange", inject);
    };
  }, [stories, downloadStory]);
}
