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
    const overflowWrapper =
      actionBtn.closest(".x6s0dn4, .x78zum5") || actionBtn.parentElement;
    const buttonRow = overflowWrapper?.parentElement;
    if (!buttonRow) continue;
    if (buttonRow.querySelector(".fpdl-download-btn")) continue;

    const story = findStoryForButton(actionBtn, stories);
    if (!story) continue;

    const downloadBtn = createDownloadButton(story, downloadStory);
    downloadBtn.classList.add("fpdl-download-btn--facebook-feed");
    buttonRow.insertBefore(downloadBtn, overflowWrapper);
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
    const moreButtonWrapper = actionBtn.parentElement;
    const buttonRow = moreButtonWrapper?.parentElement;
    if (!buttonRow) continue;

    const videoId = getValueFromReactFiber(actionBtn, (p) => p?.videoID);

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
    const buttonWrapper = actionBtn.parentElement;
    const buttonRow = buttonWrapper?.parentElement;
    if (!buttonRow) continue;

    const urlParams = new URLSearchParams(window.location.search);
    const urlVideoId = urlParams.get("v");

    const videoId =
      urlVideoId || getValueFromReactFiber(actionBtn, (p) => p?.videoID);

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

    if (!story) {
      story = findStoryForButton(actionBtn, stories);
    }

    if (!story) continue;

    const downloadBtn = createDownloadButton(story, downloadStory);
    downloadBtn.classList.add("fpdl-download-btn--watch");

    const wrapper = document.createElement("div");
    wrapper.className = "fpdl-download-btn-wrapper";
    wrapper.setAttribute("data-video-id", videoId ?? "");
    wrapper.appendChild(downloadBtn);

    buttonWrapper.insertBefore(wrapper, actionBtn);
  }
}

/**
 * Inject download buttons into Reels page (facebook.com/reel/...).
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
function injectReelsButtons(stories, downloadStory) {
  const isReelPage = window.location.pathname.includes("/reel/");
  const match = window.location.pathname.match(/\/reel\/(\d+)/);
  const reelId = match ? match[1] : null;

  // Broad container search for anything that looks like a Reel player or viewer
  const potentialContainers = document.querySelectorAll(
    ".x1useyqa, .xpdmqnj, div[role='main'] .x1yztbdb, .x1yztbdb, .x1qjc9v5.x9f619, div[aria-label='Reels Viewer']",
  );

  for (const container of potentialContainers) {
    // Look for any standard Facebook action button to anchor next to
    const likeBtn = container.querySelector('[aria-label="Like"]');
    const commentBtn = container.querySelector('[aria-label="Comment"]');
    const shareBtn = container.querySelector(
      '[aria-label="Send this to a friend or post on your timeline."], [aria-label="Share"], [aria-label="Send in Messenger"]',
    );
    const anchorBtn = likeBtn || commentBtn || shareBtn;

    if (!anchorBtn) continue;
    if (container.querySelector(".fpdl-download-btn-reel")) continue;

    // Try multiple ways to get the ID from React Fiber
    let extractedId =
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
      ) ||
      getValueFromReactFiber(
        anchorBtn,
        (p) => p?.videoID || p?.storyPostID || p?.upvoteInput?.storyID,
        50,
      ) ||
      getValueFromReactFiber(
        anchorBtn,
        (p) => p?.feedback?.associated_video?.id,
        50,
      );

    let effectiveId = extractedId;
    if (!effectiveId && (isReelPage || isActiveReel(container))) {
      effectiveId = reelId;
    }

    if (!effectiveId) continue;

    let story = stories.find(
      (s) => getStoryId(s) === effectiveId || getStoryPostId(s) === effectiveId,
    );

    if (!story) {
      story = stories.find((s) => {
        const attachment = /** @type {any} */ (s.attachments?.[0]);
        return attachment?.media?.id === effectiveId;
      });
    }

    if (!story) {
      story = {
        id: effectiveId,
        __typename: "Video",
        placeholder: true,
      };
    }

    const downloadBtn = createDownloadButton(story, downloadStory);
    downloadBtn.classList.add("fpdl-download-btn--reel");
    downloadBtn.style.color = "white";

    const wrapper = document.createElement("div");
    wrapper.className = "fpdl-download-btn-reel-wrapper";

    if (container.firstElementChild) {
      wrapper.className = `${container.firstElementChild.className} fpdl-download-btn-reel`;
    }

    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.justifyContent = "center";
    wrapper.style.cursor = "pointer";
    wrapper.style.marginBottom = "12px";

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

  const processedPosts = new Set();

  const moreBtns = document.querySelectorAll(
    'svg[aria-label="More options"], svg[aria-label="More"]',
  );
  for (const moreSvg of moreBtns) {
    const btnRole =
      moreSvg.closest('[role="button"]') || moreSvg.closest("button");
    if (!btnRole) continue;

    const innerWrapper = btnRole.parentElement;
    if (!innerWrapper) continue;

    const container = innerWrapper.parentElement;
    if (!container) continue;

    const post =
      container.closest('article, [role="dialog"], main') || container;
    if (processedPosts.has(post)) continue;

    let shortcode;
    const headerLinks = container.querySelectorAll(
      'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]',
    );
    for (const link of headerLinks) {
      const href = link.getAttribute("href") || "";
      const match = href.match(
        /\/(?:p|reel|reels)\/(?!audio\/|videos\/)([A-Za-z0-9_-]+)/,
      );
      if (match && match[1]) {
        shortcode = match[1];
        break;
      }
    }

    if (!shortcode && post !== container) {
      const postLinks = post.querySelectorAll(
        'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]',
      );
      for (const link of postLinks) {
        const href = link.getAttribute("href") || "";
        const match = href.match(
          /\/(?:p|reel|reels)\/(?!audio\/|videos\/)([A-Za-z0-9_-]+)/,
        );
        if (match && match[1]) {
          shortcode = match[1];
          break;
        }
      }
    }

    if (!shortcode) {
      const match = window.location.pathname.match(
        /\/(?:reels|reel|p)\/([A-Za-z0-9_-]+)/,
      );
      if (match && isActiveReel(container)) shortcode = match[1];
    }

    if (!shortcode) continue;
    processedPosts.add(post);

    const story = stories.find((s) => getStoryPostId(s) === shortcode) || {
      id: shortcode,
      shortcode: shortcode,
      __typename: "InstagramStory",
      placeholder: true,
    };

    const existingBtns = post.querySelectorAll(".fpdl-download-btn");
    let btnAlreadyExists = false;
    for (const btn of existingBtns) {
      if (btn.getAttribute("data-shortcode") === shortcode) {
        const isPlaceholder = btn.dataset.placeholder === "true";
        if (isPlaceholder && !story.placeholder) {
          btn.remove();
        } else {
          btnAlreadyExists = true;
        }
      } else {
        btn.remove();
      }
    }
    if (btnAlreadyExists) continue;

    const downloadBtn = createDownloadButton(story, downloadStory);
    downloadBtn.setAttribute("data-shortcode", shortcode);
    if (story.placeholder) downloadBtn.dataset.placeholder = "true";

    const isSidebar =
      window.getComputedStyle(container).flexDirection === "column" ||
      container.classList.contains("x1247r65");

    if (isSidebar) {
      downloadBtn.classList.add("fpdl-download-btn--instagram-reel");
      const audio = container.querySelector('.xjwep3j, img[alt*="Audio"]');
      if (audio) {
        let target = audio;
        while (target && target.parentElement !== container)
          target = target.parentElement;
        container.insertBefore(downloadBtn, target || audio);
      } else {
        container.appendChild(downloadBtn);
      }
    } else {
      downloadBtn.classList.add("fpdl-download-btn--instagram-header");
      container.insertBefore(downloadBtn, innerWrapper);
    }
  }
}

/**
 * Inject download buttons into Facebook Stories viewer.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
/**
 * Inject download buttons into Facebook Stories viewer.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
function injectStoryButtons(stories, downloadStory) {
  if (!window.location.href.includes("facebook.com/stories/")) return;

  // Strategy: Find anchors in the story viewer controls.
  // We prioritize Mute/Menu but must avoid the global Account Menu.
  const anchors = document.querySelectorAll(
    'div[aria-label="Mute"], div[aria-label="Menu"]',
  );

  for (const anchor of anchors) {
    // Only target anchors that are part of the visible story viewer
    if (anchor.offsetHeight === 0 || anchor.closest("[hidden]")) continue;

    // Skip the global menu in the top-right corner
    if (anchor.closest('[aria-label="Account Controls and Settings"]'))
      continue;

    // The controls are usually grouped in a container.
    const controlBar =
      anchor.closest(".x78zum5.xtijo5x") || anchor.parentElement;
    if (!controlBar) continue;

    // One button per controlBar is sufficient.
    //
    // KEY INSIGHT: Facebook does NOT update the browser URL bar when the user navigates
    // between stories inside a bucket. This means we CANNOT use the URL to determine
    // which story is currently visible. Instead:
    //  - We inject ONE button per controlBar (never replace it).
    //  - When clicked, the button reads React fiber props FRESH at that moment to
    //    discover which story is currently on screen.
    // This guarantees the correct story is always downloaded regardless of URL.
    if (controlBar.querySelector(".fpdl-download-btn-story")) continue;

    /**
     * Check if a value looks like a Facebook story / bucket ID.
     * @param {any} val
     * @returns {boolean}
     */
    const isLikelyFbId = (val) => {
      if (!val || typeof val !== "string") return false;
      if (/^[a-zA-Z]+$/.test(val) && val.length < 20) return false;
      if (
        val.includes("Pane") ||
        val.includes("Button") ||
        val.includes("Container")
      )
        return false;
      return (
        /^\d{10,}$/.test(val) || val.startsWith("Uzpf") || val.includes(":")
      );
    };

    /**
     * Resolve the story CURRENTLY visible in the viewer.
     * Called at CLICK TIME so it always reflects the active story even when
     * Facebook navigates stories without updating the browser URL.
     *
     * Tries multiple strategies in order:
     *  1. React fiber on several DOM elements near the story viewer
     *  2. /stories/bucket/storyId links found in the DOM (hidden links)
     *  3. Progress bar position → index into known ordered stories list
     *  4. URL fallback (stale, but covers the first story and edge cases)
     *
     * @returns {{ id: string, bucketId?: string, __typename: string, placeholder: boolean } | null}
     */
    const resolveCurrentStory = () => {
      /**
       * Try to read { sid, bid } from the fiber ancestor chain of a DOM element.
       * @param {Element | null | undefined} el
       */
      const extractFiber = (el) => {
        if (!el) return null;
        return getValueFromReactFiber(el, (p) => {
          const bid =
            p?.bucketID ||
            p?.ownerID ||
            p?.bucketId ||
            p?.story?.owner?.id ||
            p?.owner?.id ||
            p?.bucket?.id ||
            p?.bucket_id;

          // Extended prop paths — different FB components use different names
          const sid =
            p?.storyCard?.id ||
            p?.story_card_id ||
            p?.storyCard?.story_card_id ||
            p?.focusedStoryCardId ||
            p?.activeStoryId ||
            p?.currentStoryId ||
            p?.storyId ||
            p?.story_id ||
            p?.story?.id ||
            p?.card?.id ||
            p?.focusedCardId ||
            p?.id;

          if (isLikelyFbId(sid) && String(sid) !== String(bid)) {
            return { sid: String(sid), bid: bid ? String(bid) : undefined };
          }
          if (isLikelyFbId(sid)) {
            return { sid: String(sid), bid: bid ? String(bid) : undefined };
          }
          return undefined;
        });
      };

      // ── Strategy 1: Fiber on multiple DOM candidates ─────────────────────
      // Walk up from controlBar and also search known story-content elements.
      const domCandidates = [
        // Controls (original approach)
        controlBar.querySelector('div[aria-label="Mute"]'),
        controlBar.querySelector('div[aria-label="Menu"]'),
        anchor,
        // Story content (image / video)
        document.querySelector("video"),
        document.querySelector('[role="img"][aria-label]'), // story image
        // Progress bars (story position indicator)
        document.querySelector('[role="progressbar"]'),
        // Walk up from controlBar — story context may be a few levels up
        controlBar.parentElement,
        controlBar.parentElement?.parentElement,
        controlBar.parentElement?.parentElement?.parentElement,
        controlBar.parentElement?.parentElement?.parentElement?.parentElement,
      ];

      for (const el of domCandidates) {
        const data = extractFiber(/** @type {Element} */ (el));
        if (data?.sid) {
          console.log(
            `[fpdl] resolveCurrentStory: found via fiber on ${/** @type {Element} */ (el)?.tagName ?? "el"}: ${data.sid}`,
          );
          let bucketId = data.bid;
          if (!bucketId) {
            const m = window.location.href.match(
              /facebook\.com\/stories\/([^/?#]+)/,
            );
            if (m) bucketId = m[1];
          }
          const sStoryId = String(data.sid);
          const known = _currentStories.find((s) => getStoryId(s) === sStoryId);
          if (known) return known;
          return {
            id: sStoryId,
            bucketId,
            __typename: "Story",
            placeholder: true,
          };
        }
      }

      // ── Strategy 2: /stories/ links in the DOM ───────────────────────────
      // Facebook sometimes embeds story links as hidden anchors with the full URL.
      {
        const links = document.querySelectorAll('a[href*="/stories/"]');
        for (const link of links) {
          if (
            /** @type {HTMLElement} */ (link).offsetHeight === 0 &&
            /** @type {HTMLElement} */ (link).offsetWidth === 0
          )
            continue; // skip truly hidden
          const href = link.getAttribute("href") || "";
          const m = href.match(/\/stories\/([^/?#]+)\/([^/?#]+)/);
          if (m && isLikelyFbId(m[2])) {
            const bucketId = m[1];
            const storyId = decodeURIComponent(m[2]);
            console.log(
              `[fpdl] resolveCurrentStory: found via DOM link: ${storyId}`,
            );
            const known = _currentStories.find(
              (s) => getStoryId(s) === storyId,
            );
            if (known) return known;
            return {
              id: storyId,
              bucketId,
              __typename: "Story",
              placeholder: true,
            };
          }
        }
      }

      // ── Strategy 3: Progress bar position → known story index ────────────
      // Facebook Stories render a row of progress bars — one per story in the
      // bucket. The bar currently being filled/animated is the active story.
      // If we know the ordered list of stories for this bucket, we can match
      // by index.
      {
        const urlM = window.location.href.match(
          /facebook\.com\/stories\/([^/?#]+)/,
        );
        const bucketId = urlM ? urlM[1] : null;

        if (bucketId && stories.length > 0) {
          const bucketStories = stories.filter((s) => {
            // Filter stories that belong to this bucket (if we have bucketId info)
            const sAny = /** @type {any} */ (s);
            return (
              sAny.bucketId === bucketId ||
              sAny.bucket_id === bucketId ||
              sAny.owner?.id === bucketId
            );
          });

          const progressBars = Array.from(
            document.querySelectorAll('[role="progressbar"]'),
          );

          if (progressBars.length > 0) {
            // Find the index of the active bar: the first one that is animating
            // (width > 0 but not fully complete, or has an inner animated element).
            let activeIdx = -1;
            for (let i = 0; i < progressBars.length; i++) {
              const bar = progressBars[i];
              const inner = bar.querySelector("[style]");
              const widthStr =
                inner?.style?.width || window.getComputedStyle(bar).width;
              const pct = parseFloat(widthStr);
              // Heuristic: the first bar that is > 0% and < 100% is the active one.
              // If all are 0 the first is active; if all done the last is active.
              if (pct > 0 && pct < 100) {
                activeIdx = i;
                break;
              }
            }
            if (activeIdx === -1) {
              // Check aria-valuenow
              for (let i = 0; i < progressBars.length; i++) {
                const now = parseFloat(
                  progressBars[i].getAttribute("aria-valuenow") || "0",
                );
                const max = parseFloat(
                  progressBars[i].getAttribute("aria-valuemax") || "100",
                );
                if (now > 0 && now < max) {
                  activeIdx = i;
                  break;
                }
              }
            }
            // Default to the last bar whose aria-valuenow > 0
            if (activeIdx === -1) {
              for (let i = progressBars.length - 1; i >= 0; i--) {
                const now = parseFloat(
                  progressBars[i].getAttribute("aria-valuenow") || "0",
                );
                if (now > 0) {
                  activeIdx = i;
                  break;
                }
              }
            }

            const targetList =
              bucketStories.length > 0 ? bucketStories : stories;
            if (activeIdx >= 0 && activeIdx < targetList.length) {
              const s = targetList[activeIdx];
              console.log(
                `[fpdl] resolveCurrentStory: found via progress bar [${activeIdx}]: ${getStoryId(s)}`,
              );
              return s;
            }
          }
        }
      }

      // ── Strategy 4: URL fallback ─────────────────────────────────────────
      // The URL may be stale (always shows first story), but it's better than nothing.
      {
        const urlM = window.location.href.match(
          /facebook\.com\/stories\/([^/?#]+)(?:\/([^/?#]+))?/,
        );
        if (urlM) {
          const bucketId = urlM[1];
          const storyId = urlM[2] ? decodeURIComponent(urlM[2]) : urlM[1];
          console.warn(
            `[fpdl] resolveCurrentStory: falling back to URL (may be stale): ${storyId}`,
          );
          const known = _currentStories.find((s) => getStoryId(s) === storyId);
          if (known) return known;
          return {
            id: storyId,
            bucketId,
            __typename: "Story",
            placeholder: true,
          };
        }
      }

      console.warn(
        "[fpdl] resolveCurrentStory: all strategies exhausted, cannot resolve story.",
      );
      return null;
    };

    // Create the download button.
    // Its click handler calls resolveCurrentStory() each time, so navigating
    // to a different story (without URL change) still downloads the right one.
    const btn = document.createElement("button");
    btn.className = "fpdl-download-btn fpdl-download-btn-story";
    btn.setAttribute("aria-label", "Download Facebook story");
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
        // Resolve which story is on screen RIGHT NOW, at click time.
        const story = resolveCurrentStory();
        if (story) {
          await downloadStory(story);
        } else {
          console.warn(
            "[fpdl] Cannot download: could not resolve the currently visible story.",
          );
        }
      } catch (err) {
        console.warn("[fpdl] Story download failed", err);
      } finally {
        downloading = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
      }
    });

    // Insert at the beginning of the control group.
    controlBar.insertBefore(btn, controlBar.firstChild);
  }
}

/**
 * Inject download buttons into Instagram Stories viewer header.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
function injectInstagramStoryButtons(stories, downloadStory) {
  if (
    !window.location.hostname.includes("instagram.com") ||
    !window.location.href.includes("/stories/")
  )
    return;

  // Target the "Menu" button in the story header
  const menuBtn = document
    .querySelector('section svg[aria-label="Menu"]')
    ?.closest('[role="button"]');
  if (!menuBtn) return;

  const headerTray = menuBtn.parentElement;
  if (!headerTray) return;

  // Extract IDs from URL: /stories/username/storyId/ or /stories/highlights/REEL_ID/
  const parts = window.location.pathname.split("/").filter(Boolean);
  const urlParams = new URLSearchParams(window.location.search);
  const mediaIdFromUrl = urlParams.get("media_id");

  const isHighlight = parts[1] === "highlights";
  const reelId = isHighlight ? parts[2] : null;
  const storyIdFromPath = isHighlight ? null : parts[2];
  const storyId = mediaIdFromUrl || storyIdFromPath || reelId;

  if (!storyId) return;

  const existingBtn = headerTray.querySelector(
    ".fpdl-download-btn-insta-story",
  );
  if (existingBtn) {
    if (existingBtn.getAttribute("data-story-id") === storyId) {
      return;
    }
    existingBtn.remove();
  }

  const story = stories.find((s) => getStoryPostId(s) === storyId) || {
    id: storyId,
    shortcode: storyId,
    reelId: reelId,
    __typename: "InstagramStory",
    placeholder: true,
  };

  const downloadBtn = createDownloadButton(story, downloadStory);
  downloadBtn.classList.add("fpdl-download-btn-insta-story");
  downloadBtn.setAttribute("data-story-id", storyId);

  // Apply classes from the Menu button to match styling exactly
  if (menuBtn.className) {
    downloadBtn.className += " " + menuBtn.className;
  }

  // Ensure it has the correct sizing and layout
  downloadBtn.style.display = "flex";
  downloadBtn.style.alignItems = "center";
  downloadBtn.style.justifyContent = "center";
  downloadBtn.style.width = "32px";
  downloadBtn.style.height = "32px";
  downloadBtn.style.marginRight = "8px";
  downloadBtn.style.backgroundColor = "transparent";
  downloadBtn.style.border = "none";
  downloadBtn.style.cursor = "pointer";
  downloadBtn.style.color = "white";

  // Insert before the Menu button in the header tray
  headerTray.insertBefore(downloadBtn, menuBtn);
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
      100,
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
