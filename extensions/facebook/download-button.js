import { getStoryUrl, getStoryId, getStoryPostId } from "./story.js";
import { 
  createDownloadButton, 
  findStoryForButton, 
  getValueFromReactFiber, 
  isActiveReel,
  getCurrentStories
} from "../download-button.js";

/**
 * @typedef {import('../types').Story} Story
 */

/**
 * Inject download buttons into regular post feed posts.
 * Targets the "Actions for this post" overflow button.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
export function injectPostFeedButtons(stories, downloadStory) {
  const actionButtons = document.querySelectorAll(
    '[aria-label^="Actions for this post"]',
  );

  for (const actionBtn of actionButtons) {
    const overflowWrapper =
      actionBtn.closest(".x6s0dn4, .x78zum5") || actionBtn.parentElement;
    const buttonRow = overflowWrapper?.parentElement;
    if (!buttonRow) continue;
    if (buttonRow.querySelector(".fpdl-download-btn")) continue;

    // ── Guard: skip non-post widgets (e.g. "People you may know", "Reels") ──
    // These widgets embed an "Actions for this post" button in their section
    // header, but the surrounding DOM contains h3 headings or content-specific
    // links (friend suggestions, reel links) that never appear in a real post's
    // action row. The Reels widget h3 is one level above buttonRow, so we also
    // check buttonRow.parentElement.
    const widgetContainer = buttonRow.parentElement;
    if (
      buttonRow.querySelector("h3") ||
      widgetContainer?.querySelector("h3") ||
      buttonRow.querySelector('[href*="/friends/suggestions/"]') ||
      buttonRow.querySelector('[aria-label^="Add Friend"]') ||
      widgetContainer?.querySelector('[href*="/reel/"]') ||
      widgetContainer?.querySelector('[aria-label^="Reel by"]') ||
      actionBtn.closest('[aria-label="People you may know"]') ||
      actionBtn.closest('[aria-label="Reels"]') ||
      actionBtn.closest('[role="region"]')
    ) continue;

    let story = findStoryForButton(actionBtn, stories);
    
    if (!story) {
      // If we couldn't find the story in the cache, try a broader search for the ID
      // Facebook sometimes moves the props up the tree
      const getFiberId = (el) => 
        getValueFromReactFiber(el, (p) => 
          p?.story?.id || p?.storyPostID || p?.post_id || p?.videoID || p?.video_id
        ) || getValueFromReactFiber(el, (p) => p?.story?.permalink_url);
      
      let effectiveId = getFiberId(actionBtn) || 
                        getFiberId(actionBtn.parentElement) || 
                        getFiberId(overflowWrapper) || 
                        getFiberId(buttonRow);
      
      // Always inject the button. If we don't have an ID, use a placeholder so 
      // the fallback DOM extraction in app.js can at least try to download the media.
      story = {
        id: typeof effectiveId === 'string' && effectiveId.startsWith('http') ? 'unknown' : (effectiveId || "unknown"),
        url: typeof effectiveId === 'string' && effectiveId.startsWith('http') ? effectiveId : undefined,
        __typename: "Story",
        placeholder: true,
        _node: actionBtn,
      };
    }

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
export function injectVideoFeedButtons(stories, downloadStory) {
  const actionButtons = document.querySelectorAll('[aria-label="More"]');

  for (const actionBtn of actionButtons) {
    // Skip "More" buttons that are inside comment sections or reaction popups
    if (
      actionBtn.closest('[role="article"]') ||
      actionBtn.closest('[aria-label^="Comment by"]') ||
      actionBtn.closest('[role="dialog"]')
    ) continue;

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
export function injectWatchVideoButtons(stories, downloadStory) {
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
export function injectReelsButtons(stories, downloadStory) {
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
    const anchorBtn = shareBtn || commentBtn || likeBtn;

    if (!anchorBtn) continue;

    // ── Guard: skip buttons inside comment sections ───────────────────────
    // Facebook comment articles have role="article" and aria-label starting with "Comment by".
    // Reply threads also carry role="article". We must not inject into either.
    if (
      anchorBtn.closest('[role="article"]') ||
      anchorBtn.closest('[aria-label^="Comment by"]') ||
      anchorBtn.closest('[aria-label^="Reply by"]')
    ) continue;

    // ── Guard: skip buttons inside reaction/interaction popup boxes ───────
    // The emoji reaction tray and interaction popups appear in overlays/dialogs
    // or inside containers that hold reaction emoji buttons (Care, Love, etc.).
    if (
      anchorBtn.closest('[aria-label="React"]') ||
      anchorBtn.closest('[aria-label="Reactions"]') ||
      anchorBtn.closest('[aria-label^="See who reacted"]') ||
      anchorBtn.closest('.x6s0dn4.x3nfvp2') // reaction emoji tray wrapper
    ) continue;

    // Find the actual reel root so we don't inject multiple times per reel
    // We use .parentElement.closest() because Facebook action buttons sometimes 
    // share the same generic classes (like .x1useyqa) with the outer containers!
    const reelRoot = anchorBtn.parentElement?.closest('.x1useyqa, .xpdmqnj, .x1yztbdb, div[aria-label="Reels Viewer"]') || container;

    // Find the actual column holding the action buttons
    const actionWrapper = anchorBtn.closest('[role="button"]') || anchorBtn;
    const actionColumn = actionWrapper.parentElement;
    
    if (!actionColumn) continue;

    // We get extractedId early so we can compare it against existing buttons in the reelRoot
    let extractedId =
      getValueFromReactFiber(
        anchorBtn,
        (p) => 
          p?.feedback?.associated_group_video?.id ||
          p?.feedback?.video_view_count_renderer?.feedback?.associated_group_video?.id ||
          p?.videoID || p?.storyPostID || p?.upvoteInput?.storyID ||
          p?.feedback?.associated_video?.id ||
          p?.video?.id || p?.saved_media?.id || p?.post_id || p?.id,
        50,
      );

    if (!extractedId) {
      const videoNode = reelRoot.querySelector("video");
      if (videoNode) {
        extractedId = getValueFromReactFiber(
          videoNode,
          (p) => p?.videoID || p?.video_id || p?.videoData?.$1?.video_id || p?.video?.id,
          50,
        );
      }
    }

    let effectiveId = extractedId;
    if (!effectiveId && (isReelPage || isActiveReel(container))) {
      effectiveId = reelId;
    }

    if (!effectiveId) continue;

    // Prevent multiple buttons per reel (due to nested containers matching potentialContainers)
    // AND Support virtualized lists (by removing stale buttons when ID changes)
    const existingInRoot = reelRoot.querySelectorAll(".fpdl-download-btn-reel");
    let isFresh = false;
    for (const btn of existingInRoot) {
      if (btn.getAttribute("data-video-id") === effectiveId) {
        isFresh = true;
      } else {
        btn.remove();
      }
    }
    if (isFresh) continue;

    // (Removed duplicate existingBtn checks, handled above via existingInRoot)

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
    
    // Clone story to avoid polluting cache and set _node for DOM fallback
    story = { ...story, _node: anchorBtn };

    const downloadBtn = createDownloadButton(story, downloadStory);
    downloadBtn.classList.add("fpdl-download-btn--reel");
    downloadBtn.style.color = "white";

    const wrapper = document.createElement("div");
    wrapper.className = "fpdl-download-btn-reel-wrapper";
    wrapper.setAttribute("data-video-id", effectiveId);

    if (actionColumn.firstElementChild) {
      wrapper.className = `${actionColumn.firstElementChild.className} fpdl-download-btn-reel`;
    } else {
      wrapper.className = "fpdl-download-btn-reel";
    }

    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.justifyContent = "center";
    wrapper.style.cursor = "pointer";
    wrapper.style.marginTop = "12px";

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
    actionColumn.appendChild(wrapper);
  }
}

/**
 * Inject download buttons into Facebook Stories viewer.
 * @param {Story[]} stories
 * @param {(story: Story) => Promise<void>} downloadStory
 */
export function injectStoryButtons(stories, downloadStory) {
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
          const currentStories = getCurrentStories();
          const known = currentStories.find((s) => getStoryId(s) === sStoryId);
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
            const currentStories = getCurrentStories();
            const known = currentStories.find(
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
          const currentStories = getCurrentStories();
          const known = currentStories.find((s) => getStoryId(s) === storyId);
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
