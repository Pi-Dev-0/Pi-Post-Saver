import { getStoryUrl, getStoryId, getStoryPostId } from "./story.js";
import { React } from "./react.js";

/**
 * @typedef {import('./types').Story} Story
 */

const { useEffect } = React;

/**
 * Check if a container is the "active" reel in the viewport.
 * @param {Element} container
 * @returns {boolean}
 */
function isActiveReel(container) {
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
function getValueFromReactFiber(element, accessor, maxDepth = 50) {
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
function createDownloadButton(story, downloadStory) {
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
function findStoryForButton(actionBtn, stories) {
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

/**
 * Inject download buttons into regular post feed posts.
 * Targets the "Actions for this post" overflow button.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
function injectPostFeedButtons(stories, downloadStory) {
  const actionButtons = document.querySelectorAll(
    '[aria-label="Actions for this post"]',
  );

  for (const actionBtn of actionButtons) {
    // Regular feed: button -> parent -> parent = overflowContainer
    // Insert before the overflowContainer in its parent (buttonRow)
    const overflowContainer = actionBtn.parentElement?.parentElement;
    const buttonRow = overflowContainer?.parentElement;
    if (!buttonRow) continue;
    if (buttonRow.querySelector(".fpdl-download-btn")) continue;

    const story = findStoryForButton(actionBtn, stories);
    if (!story) continue;

    const downloadBtn = createDownloadButton(story, downloadStory);
    buttonRow.insertBefore(downloadBtn, overflowContainer);
  }
}

/**
 * Inject download buttons into video feed page posts.
 * Targets the "More" button in the video feed.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
function injectVideoFeedButtons(stories, downloadStory) {
  const actionButtons = document.querySelectorAll('[aria-label="More"]');

  for (const actionBtn of actionButtons) {
    // Watch feed: button -> parent = moreButtonWrapper (32x32 container)
    // parent.parent = buttonRow (flex row with user info, post text, More button)
    // Insert before the moreButtonWrapper
    const moreButtonWrapper = actionBtn.parentElement;
    const buttonRow = moreButtonWrapper?.parentElement;
    if (!buttonRow) continue;

    // Get video ID from React fiber
    const videoId = getValueFromReactFiber(actionBtn, (p) => p?.videoID);

    // Check if existing button is for a different video, if so remove it
    const existingBtn = buttonRow.querySelector(".fpdl-download-btn");
    if (existingBtn) {
      if (existingBtn.getAttribute("data-video-id") === videoId) continue;
      existingBtn.remove();
    }

    const story = findStoryForButton(actionBtn, stories);
    if (!story) continue;

    const downloadBtn = createDownloadButton(story, downloadStory);
    downloadBtn.classList.add("fpdl-download-btn--video");
    downloadBtn.setAttribute("data-video-id", videoId ?? "");
    buttonRow.insertBefore(downloadBtn, moreButtonWrapper);
  }
}

/**
 * Inject download buttons into Watch video page (facebook.com/watch/?v=...).
 * Targets the "More options for video" button.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
function injectWatchVideoButtons(stories, downloadStory) {
  const actionButtons = document.querySelectorAll(
    '[aria-label*="More options"]',
  );

  for (const actionBtn of actionButtons) {
    // Watch video page: button -> wrapper div -> flex container with buttons
    // Insert before this button's wrapper
    const buttonWrapper = actionBtn.parentElement;
    const buttonRow = buttonWrapper?.parentElement;
    if (!buttonRow) continue;

    // Get video ID from URL as primary source (React fiber can be stale during navigation)
    const urlParams = new URLSearchParams(window.location.search);
    const urlVideoId = urlParams.get("v");

    // Fall back to React fiber videoID if URL doesn't have it
    const videoId =
      urlVideoId || getValueFromReactFiber(actionBtn, (p) => p?.videoID);

    // Check if existing button is for a different video, if so remove it
    const existingWrapper = buttonWrapper.querySelector(
      ".fpdl-download-btn-wrapper",
    );
    if (existingWrapper) {
      if (existingWrapper.getAttribute("data-video-id") === videoId) continue;
      existingWrapper.remove();
    }

    let story = videoId
      ? stories.find((s) => {
          const attachment = /** @type {any} */ (s.attachments?.[0]);
          return attachment?.media?.id === videoId;
        })
      : null;

    // Fall back to common matching strategies
    if (!story) {
      story = findStoryForButton(actionBtn, stories);
    }

    if (!story) continue;

    const downloadBtn = createDownloadButton(story, downloadStory);
    downloadBtn.classList.add("fpdl-download-btn--watch");

    // Wrap in a container to match the "More options for video" button's parent structure
    const wrapper = document.createElement("div");
    wrapper.className = "fpdl-download-btn-wrapper";
    wrapper.setAttribute("data-video-id", videoId ?? "");
    wrapper.appendChild(downloadBtn);

    buttonWrapper.insertBefore(wrapper, actionBtn);
  }
}

/**
 * Inject download buttons into Reels page (facebook.com/reel/...).
 * Targets the "More" or "Like/Comment/Share" sidebar.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
function injectReelsButtons(stories, downloadStory) {
  // Check if we are on a Reels page
  const match = window.location.pathname.match(/\/reel\/(\d+)/);
  if (!match) return;
  const reelId = match[1];

  // Strategy: The user identified 'x1useyqa' as the container.
  // We search for this container directly.
  // To ensure it's the right one (sidebar), we check if it contains the "Like" button.
  const potentialContainers = document.querySelectorAll(".x1useyqa, .xpdmqnj");

  for (const container of potentialContainers) {
    // Check for Like or Comment button to use as anchor for ID extraction
    const likeBtn = container.querySelector('[aria-label="Like"]');
    const commentBtn = container.querySelector('[aria-label="Comment"]');
    const anchorBtn = likeBtn || commentBtn;

    if (!anchorBtn) continue;

    // Check if we already injected in this container
    if (container.querySelector(".fpdl-download-btn-reel")) continue;

    // Attempt to extract ID from React Fiber of the button with limited depth
    // Limit depth to 50 to avoid picking up parent container IDs (which might reflect the 'active' reel)
    let extractedId;

    // 1. Try "feedback" prop which usually contains the video/post ID
    extractedId =
      getValueFromReactFiber(
        anchorBtn,
        (p) => p?.feedback?.associated_group_video?.id,
        50,
      ) ||
      getValueFromReactFiber(
        anchorBtn,
        (p) =>
          p?.feedback?.video_view_count_renderer?.feedback
            ?.associated_group_video?.id,
        50,
      );

    // 2. Try simple videoID/postID props
    if (!extractedId) {
      extractedId = getValueFromReactFiber(
        anchorBtn,
        (p) => p?.videoID || p?.storyPostID || p?.upvoteInput?.storyID,
        50,
      );
    }

    // Crucial fallback: The 'feedback' object often has 'associated_video'.
    if (!extractedId) {
      extractedId = getValueFromReactFiber(
        anchorBtn,
        (p) => p?.feedback?.associated_video?.id,
        50,
      );
    }

    // Fallback Logic:
    // If we cannot extract an ID, checking the window URL is risky because it only reflects the *active* reel.
    // However, if we can determine this container IS the active reel, we can safely use the URL ID.
    // This handles the "initial load" case where Fiber might not be ready but URL is correct.
    let effectiveId = extractedId;
    if (!effectiveId && isActiveReel(container)) {
      effectiveId = reelId;
    }

    // If still no ID found, skip injection for this container
    if (!effectiveId) continue;

    // Strict ID assignment
    // const effectiveId = extractedId; // (Removed: now using logic above)

    // Try to find story
    let story = stories.find(
      (s) => getStoryId(s) === effectiveId || getStoryPostId(s) === effectiveId,
    );

    // Fallback: Check attachments or URL
    if (!story) {
      story = stories.find((s) => {
        const attachment = /** @type {any} */ (s.attachments?.[0]);
        return attachment?.media?.id === effectiveId;
      });
    }

    // New Fallback: Check if any story's metadata related to this Reel
    if (!story) {
      // Create a placeholder story that will trigger a fetch on download
      story = {
        id: effectiveId,
        __typename: "Video",
        placeholder: true,
      };
    }

    const downloadBtn = createDownloadButton(story, downloadStory);
    downloadBtn.classList.add("fpdl-download-btn--reel");
    downloadBtn.style.color = "white";

    // Create a wrapper to match the style of other buttons
    const wrapper = document.createElement("div");
    wrapper.className = "fpdl-download-btn-reel-wrapper";

    // Attempt to copy classes from the first child (sibling wrapper) for consistent layout
    if (container.firstElementChild) {
      wrapper.className = `${container.firstElementChild.className} fpdl-download-btn-reel`;
    }

    // Apply necessary layout overrides
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.justifyContent = "center";
    wrapper.style.cursor = "pointer";
    wrapper.style.marginBottom = "12px";

    // Override button styles
    downloadBtn.style.width = "40px";
    downloadBtn.style.height = "40px";
    downloadBtn.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
    downloadBtn.style.backdropFilter = "blur(12px)";
    downloadBtn.style.borderRadius = "50%";
    downloadBtn.style.display = "flex";
    downloadBtn.style.alignItems = "center";
    downloadBtn.style.justifyContent = "center";
    downloadBtn.style.border = "none";

    wrapper.appendChild(downloadBtn);
    container.appendChild(wrapper);
  }
}

/**
 * Inject download buttons into Instagram Feed and Reels.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
function injectInstagramButtons(stories, downloadStory) {
  if (!window.location.hostname.includes("instagram.com")) return;

  // 1. Feed Posts (articles) - skip on home feed
  if (window.location.pathname !== "/") {
    const articles = document.querySelectorAll("article");
    for (const article of articles) {
      // 1. From the timestamp link (most reliable)
      let shortcode = "";
      const timeLink = article.querySelector("time")?.closest("a");
      if (timeLink) {
        const href = timeLink.getAttribute("href") || "";
        const match = href.match(/\/(?:p|reels|reel)\/([A-Za-z0-9_-]+)/);
        if (match) shortcode = match[1];
      }

      if (!shortcode) {
        const link = article.querySelector(
          'a[href*="/p/"], a[href*="/reels/"], a[href*="/reel/"]',
        );
        if (link) {
          const href = link.getAttribute("href") || "";
          const match = href.match(/\/(?:p|reels|reel)\/([A-Za-z0-9_-]+)/);
          if (match) shortcode = match[1];
        }
      }

      if (!shortcode) {
        shortcode = getValueFromReactFiber(
          article,
          (p) => p?.shortcode || p?.code || p?.post?.code,
        );
      }

      if (!shortcode) continue;

      // Check if button already exists and if it's a placeholder
      const existingBtn = article.querySelector(
        `.fpdl-download-btn[data-shortcode="${shortcode}"]`,
      );
      const isPlaceholder = existingBtn?.dataset.placeholder === "true";

      const story = stories.find((s) => getStoryPostId(s) === shortcode) || {
        id: shortcode,
        shortcode: shortcode,
        __typename: "InstagramStory",
        placeholder: true,
      };

      if (existingBtn) {
        if (isPlaceholder && !story.placeholder) {
          // Upgrade placeholder to real story button
          existingBtn.remove();
        } else {
          continue;
        }
      }

      const actionRow =
        article.querySelector("section") || article.querySelector(".xh8yej3");
      if (!actionRow) continue;

      const downloadBtn = createDownloadButton(story, downloadStory);
      downloadBtn.setAttribute("data-shortcode", shortcode);
      if (story.placeholder) downloadBtn.dataset.placeholder = "true";
      downloadBtn.style.marginLeft = "8px";

      actionRow.appendChild(downloadBtn);
    }
  }

  // 2. Reels (fullscreen viewer)
  const reels = document.querySelectorAll(
    'div[role="dialog"] video, main video',
  );
  for (const video of reels) {
    const container =
      video.closest('div[style*="height"]') || video.closest("section");
    if (!container) continue;

    let shortcode;
    const match = window.location.pathname.match(
      /\/(?:reels|reel|p)\/([A-Za-z0-9_-]+)/,
    );
    if (match && isActiveReel(container)) {
      shortcode = match[1];
    } else {
      shortcode = getValueFromReactFiber(
        video,
        (p) => p?.videoData?.shortcode || p?.shortcode || p?.post?.code,
      );
    }

    if (!shortcode) continue;

    const existingBtn = container.querySelector(
      `.fpdl-download-btn[data-shortcode="${shortcode}"]`,
    );
    const isPlaceholder = existingBtn?.dataset.placeholder === "true";

    const story = stories.find((s) => getStoryPostId(s) === shortcode) || {
      id: shortcode,
      shortcode: shortcode,
      __typename: "InstagramStory",
      placeholder: true,
    };

    if (existingBtn) {
      if (isPlaceholder && !story.placeholder) {
        existingBtn.remove();
      } else {
        continue;
      }
    }

    const sidebar =
      container.querySelector("div.x1oa3qoh") ||
      container.querySelector('div[style*="flex-direction: column"]') ||
      container.querySelector(".x10l6tqk.x13vifvy");

    if (!sidebar) continue;

    const downloadBtn = createDownloadButton(story, downloadStory);
    downloadBtn.setAttribute("data-shortcode", shortcode);
    if (story.placeholder) downloadBtn.dataset.placeholder = "true";
    downloadBtn.style.marginTop = "12px";

    sidebar.appendChild(downloadBtn);
  }
}

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
  } else if (window.location.hostname.includes("instagram.com")) {
    injectInstagramButtons(stories, downloadStory);
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
            border: 1px solid rgba(255, 255, 255, 1);
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
        .fpdl-download-btn--instagram {
            color: inherit;
            opacity: 0.8;
        }
        .fpdl-download-btn--instagram:hover {
            opacity: 1;
            background: transparent;
        }
        .fpdl-download-btn--instagram-reel {
            color: white;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            width: 40px !important;
            height: 40px !important;
            border-radius: 50%;
            margin-bottom: 8px;
        }
        .fpdl-download-btn--instagram-reel:hover {
            background: rgba(255, 255, 255, 0.2);
            transform: scale(1.1);
        }
        .xrvj5dj {
            display: flex !important;
        }
    `;
  document.head.appendChild(style);
}

/**
 * React hook to inject download buttons into posts.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
export function useDownloadButtonInjection(stories, downloadStory) {
  // Inject styles once
  useEffect(() => {
    injectDownloadButtonStyles();
  }, []);

  // Set up observer and inject buttons
  useEffect(() => {
    const { call: inject, cancel } = debounce(
      () => injectDownloadButtons(stories, downloadStory),
      100,
    );

    const observer = new MutationObserver(inject);
    observer.observe(document.body, { childList: true, subtree: true });

    inject();

    return () => {
      cancel();
      observer.disconnect();
    };
  }, [stories, downloadStory]);
}
