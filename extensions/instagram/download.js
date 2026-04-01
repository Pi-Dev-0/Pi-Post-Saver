import {
  fetchInstagramHighlightData,
  fetchInstagramStoryData,
  fetchInstagramMediaInfo,
  resolveInstagramUserId,
} from "./api.js";

/**
 * Resolve the URL of the currently visible video from the page DOM,
 * using React Fiber to decode blob: URLs.
 * @returns {{ __typename: string, id: string, video_url?: string, display_url?: string }[]}
 */
function scrapeInstagramMediaFromDOM(storyId) {
  const mediaSources = [];
  const containers = document.querySelectorAll(
    "article, section, div[role='dialog'], div[role='presentation']",
  );

  for (const container of containers) {
    const videos = container.querySelectorAll("video");
    const containerHasVideo = videos.length > 0;

    for (const video of videos) {
      let src = video.src || video.querySelector("source")?.src;

      // Try Fiber for real URL when src is a blob or missing
      if (!src || src.startsWith("blob:")) {
        // @ts-ignore
        const fiberKey = Object.keys(video).find((k) =>
          k.startsWith("__reactFiber$"),
        );
        if (fiberKey) {
          // @ts-ignore
          let fiber = video[fiberKey];
          while (fiber) {
            const props = fiber.memoizedProps;
            // Expanded paths: covers story viewer, reel viewer, highlight viewer
            const fiberUrl =
              props?.media?.video_versions?.[0]?.url ||
              props?.item?.media?.video_versions?.[0]?.url ||
              props?.media?.video_dash_manifest ||
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
              props?.src;

            if (
              fiberUrl &&
              typeof fiberUrl === "string" &&
              !fiberUrl.startsWith("blob:")
            ) {
              src = fiberUrl;
              break;
            }
            fiber = fiber.return;
          }
        }
      }

      if (
        src &&
        (src.includes("cdninstagram.com") || src.startsWith("http")) &&
        !src.startsWith("blob:")
      ) {
        mediaSources.push({ __typename: "Video", id: storyId, video_url: src });
      }
    }

    // Only scrape images if NO video is present in this container.
    // Prevents yielding a video's poster image as a Photo fallback.
    if (!containerHasVideo) {
      const imgs = container.querySelectorAll("img.x5yr21d, img[srcset]");
      for (const img of imgs) {
        let src = img.getAttribute("src") || img.currentSrc;
        if (/** @type {HTMLImageElement} */ (img).srcset) {
          const sources = /** @type {HTMLImageElement} */ (img).srcset
            .split(",")
            .map((s) => {
              const [url, size] = s.trim().split(" ");
              return { url, width: parseInt(size) || 0 };
            });
          if (sources.length > 0)
            src = sources.sort((a, b) => b.width - a.width)[0].url;
        }
        if (
          src &&
          src.includes("cdninstagram.com") &&
          !src.includes("profile") &&
          !src.startsWith("blob:")
        ) {
          mediaSources.push({
            __typename: "Photo",
            id: storyId,
            display_url: src,
          });
        }
      }
    }
  }

  return mediaSources;
}

/**
 * Resolve an Instagram placeholder story into downloadable media items.
 * Tries (in order):
 *   1. Global in-memory cache
 *   2. Instagram API (highlight, story, or post endpoint)
 *   3. DOM scraping with React Fiber video URL extraction
 *   4. og:video / og:image meta tags from the post page
 *
 * @param {any} story - The Instagram placeholder story object
 * @param {Map<string, any>} globalStoriesCache
 * @yields {any} Resolved media items
 */
export async function* resolveInstagramPlaceholder(story, globalStoriesCache) {
  const storyId = story.shortcode || story.id;
  console.log(`[fpdl] Resolving Instagram placeholder ${storyId}...`);

  // Step 1: In-memory cache
  const cached = globalStoriesCache.get(storyId);
  if (cached && !cached.placeholder) {
    yield* resolveInstagramPlaceholder(cached, globalStoriesCache);
    return;
  }

  // Step 2: Instagram API
  if (window.location.hostname.includes("instagram.com")) {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const isStoryPath = parts[0] === "stories";

    if (isStoryPath) {
      const isHighlight = parts[1] === "highlights";
      const reelId = isHighlight ? parts[2] : story.reelId || null;
      const mediaId = storyId !== reelId ? storyId : null;

      if (reelId) {
        // Highlights / story reels
        try {
          console.log(`[fpdl] Fetching highlight API for ${reelId}...`);
          const storyItems = await fetchInstagramHighlightData(reelId);
          if (storyItems.length > 0) {
            // Try to identify which item is currently visible
            const urlMediaId = new URLSearchParams(window.location.search).get(
              "media_id",
            );
            const activeVideo = document.querySelector(
              "section video, div[role='dialog'] video",
            );
            const activeDataId =
              activeVideo
                ?.closest("[data-media-id]")
                ?.getAttribute("data-media-id") ||
              activeVideo?.closest("[data-id]")?.getAttribute("data-id");

            const activeId = urlMediaId || activeDataId || mediaId;
            const match = activeId
              ? storyItems.find(
                  (item) =>
                    String(item.id).includes(String(activeId)) ||
                    String(item.pk).includes(String(activeId)) ||
                    (item.code && String(item.code) === String(activeId)),
                )
              : null;

            if (match) {
              yield match;
              return;
            }
            // Yield all items when we can't determine which is active
            for (const item of storyItems) yield item;
            return;
          }
        } catch (err) {
          console.warn("[fpdl] Highlight API resolution failed", err);
        }
      } else if (parts[1] && parts[1] !== "stories") {
        // Regular user stories
        try {
          const userId = await resolveInstagramUserId(parts[1]);
          const storyItems = await fetchInstagramStoryData(userId);
          const match = storyItems.find(
            (item) =>
              String(item.id).includes(String(storyId)) ||
              String(item.pk).includes(String(storyId)) ||
              (item.code && String(item.code) === String(storyId)),
          );
          if (match) {
            yield match;
            return;
          }
          if (storyItems.length > 0) {
            yield storyItems[0];
            return;
          }
        } catch (err) {
          console.warn("[fpdl] Story API resolution failed", err);
        }
      }
    } else {
      // Posts, Reels, homepage feed — use media info endpoint
      try {
        const mediaInfo = await fetchInstagramMediaInfo(storyId);
        if (mediaInfo) {
          yield mediaInfo;
          return;
        }
      } catch (err) {
        console.warn("[fpdl] Media API resolution failed", err);
      }
    }
  }

  // Step 3: DOM scraping with Fiber traversal
  const domSources = scrapeInstagramMediaFromDOM(storyId);
  if (domSources.length > 0) {
    for (const m of domSources) yield m;
    return;
  }

  // Step 4: og:video / og:image meta fallback (only for short shortcodes / post IDs)
  if (
    window.location.hostname.includes("instagram.com") &&
    storyId.length < 15
  ) {
    try {
      const instagramUrl = `https://www.instagram.com/p/${storyId}/`;
      const res = await fetch(instagramUrl);
      if (res.ok) {
        const html = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const ogVideo = doc.querySelector('meta[property="og:video"]');
        const ogImage = doc.querySelector('meta[property="og:image"]');
        if (ogVideo?.content) {
          yield {
            __typename: "Video",
            id: storyId,
            video_url: ogVideo.content,
          };
          return;
        }
        if (ogImage?.content) {
          yield {
            __typename: "Photo",
            id: storyId,
            display_url: ogImage.content,
          };
          return;
        }
      }
    } catch (err) {
      console.warn("[fpdl] og: meta fallback failed", err);
    }
  }
}
