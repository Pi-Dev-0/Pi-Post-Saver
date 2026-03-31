import { graphqlListener, sendGraphqlRequest } from "../graphql.js";
import { isFacebookReel } from "./reels.js";

/**
 * @typedef {import('./types').Story} Story
 * @typedef {import('./types').StoryPost} StoryPost
 * @typedef {import('./types').StoryVideo} StoryVideo
 * @typedef {import('./types').StoryWatch} StoryWatch
 * @typedef {import('./types').Media} Media
 * @typedef {import('./types').MediaId} MediaId
 * @typedef {import('./types').MediaVideo} MediaVideo
 * @typedef {import('./types').MediaWatch} MediaWatch
 * @typedef {import('./types').MediaPhoto} MediaPhoto
 * @typedef {import('./types').MediaPhotoUrl} MediaPhotoUrl
 * @typedef {import('./types').User} User
 * @typedef {import('./types').Group} Group
 * @typedef {import('./types').StoryFile} StoryFile
 */

const PHOTO_ROOT_QUERY = "CometPhotoRootContentQuery";
const VIDEO_ROOT_QUERY = "CometVideoRootMediaViewerQuery";

/** @type {Map<string, number>} */
const storyCreateTimeCache = new Map();

/** @type {Map<string, Group>} */
const storyGroupCache = new Map();

/** @type {Map<string, string>} */
const videoUrlCache = new Map();

/** @type {Map<string, Story>} */
const globalStoriesCache = new Map();

function isDirectMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  const s = url.toLowerCase();

  // Data and Blod URLs are always direct media for our purposes
  if (s.startsWith("data:") || s.startsWith("blob:")) return true;

  // Exclude common page-only markers
  if (
    s.includes("/posts/") ||
    s.includes("/stories/") ||
    s.includes("/videos/") ||
    s.includes("/reel/")
  ) {
    if (!s.includes("fbcdn.net") && !s.includes("cdninstagram.com"))
      return false;
  }

  // CDN links are almost always direct media
  if (
    s.includes("fbcdn.net") ||
    s.includes("cdninstagram.com") ||
    s.includes("fb.me") ||
    s.includes("fna.fbcdn.net")
  )
    return true;

  // Check for common media extensions
  if (/\.(jpg|jpeg|png|webp|gif|mp4|webm|m4v|mp3|wav)(\?|\$)/i.test(s))
    return true;

  return false;
}

/**
 * Check if an object is a MediaPhoto.
 * @param {unknown} obj
 * @returns {obj is MediaPhoto}
 */
function isMediaPhoto(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {any} */ (obj);
  return (
    o.__typename === "Photo" ||
    (!!(o.image?.uri && isDirectMediaUrl(o.image.uri)) && !isMediaVideo(obj))
  );
}

/**
 * Check if an object is a MediaVideo.
 * @param {unknown} obj
 * @returns {obj is MediaVideo}
 */
function isMediaVideo(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {any} */ (obj);
  if (o.__typename === "Video") return true;
  return !!(
    o.playable_url ||
    o.playable_url_quality_hd ||
    o.browser_native_hd_url ||
    o.video_url ||
    o.videoDeliveryResponseFragment ||
    o.video_grid_renderer ||
    o.video_versions
  );
}

/**
 * Check if an object is a MediaWatch (Video with url but no videoDeliveryResponseFragment).
 * @param {unknown} obj
 * @returns {obj is MediaWatch}
 */
function isMediaWatch(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.__typename !== "Video") return false;
  // MediaWatch has url but no videoDeliveryResponseFragment or video_grid_renderer
  return (
    typeof o.url === "string" &&
    o.url.includes("fbcdn.net") &&
    !("videoDeliveryResponseFragment" in o) &&
    !("video_grid_renderer" in o)
  );
}

/**
 * Get the download URL and extension for a media item.
 * @param {Media} media
 * @returns {{ url: string, ext: string } | undefined}
 */
function getDownloadUrl(media) {
  const m = /** @type {any} */ (media);

  // 1. Prioritize Video logic
  if (isMediaVideo(media)) {
    const videoCandidates = [
      m.playable_url_quality_hd,
      m.browser_native_hd_url,
      m.hd_src,
      m.video_url,
      m.playable_url,
      m.sd_src,
    ];

    for (const url of videoCandidates) {
      if (
        url &&
        typeof url === "string" &&
        isDirectMediaUrl(url) &&
        (url.includes(".mp4") ||
          url.includes("fbcdn.net/v/") ||
          url.includes("_n.mp4") ||
          url.includes("?_nc_cat=") ||
          (url.includes("/video-preview") === false &&
            url.includes("/video-thumb") === false &&
            url.includes("/v/t15") === false && // Common thumbnail path
            url.includes("/v/t45") === false)) // Common thumbnail path
      ) {
        // Double check it's not a common image extension
        const urlWithoutParams = url.split("?")[0].split("#")[0];
        if (
          !/\.(jpg|jpeg|png|webp|gif|jfif|bmp)(\?|\$)/i.test(urlWithoutParams)
        ) {
          console.log(`[fpdl] Picked video URL: ${url.substring(0, 100)}...`);
          return { url, ext: "mp4" };
        }
      }
    }

    const list =
      media?.videoDeliveryResponseFragment?.videoDeliveryResponseResult
        ?.progressive_urls ??
      media?.video_grid_renderer?.video?.videoDeliveryResponseFragment
        ?.videoDeliveryResponseResult?.progressive_urls;

    if (Array.isArray(list) && list.length > 0) {
      const hd = list.find(
        (x) => x?.metadata?.quality === "HD" && x?.progressive_url,
      );
      if (hd?.progressive_url) return { url: hd.progressive_url, ext: "mp4" };

      const first = list.find((x) => x?.progressive_url);
      if (first?.progressive_url)
        return { url: first.progressive_url, ext: "mp4" };
    }

    if (isMediaWatch(media)) {
      return { url: media.url, ext: "mp4" };
    }

    if (
      m.video_versions &&
      Array.isArray(m.video_versions) &&
      m.video_versions.length > 0
    ) {
      const best = m.video_versions.sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0];
      return { url: best.url, ext: "mp4" };
    }
  }

  // 2. Photo logic
  if (isMediaPhoto(media)) {
    /** @type {MediaPhotoUrl | undefined} */
    let best;
    const candidates = [
      media.full_screen_image,
      media.original_image,
      media.largest_image,
      media.xlarge_image,
      media.scaled_image,
      media.focus_image,
      media.high_res_image,
      media.full_image,
      media.webapp_image,
      media.viewer_image,
      media.photo_image,
      media.image,
      m.multi_share_media?.image,
    ];

    for (const img of candidates) {
      if (!img?.uri) continue;
      const size = (img.width || 0) * (img.height || 0);
      const bestSize = (best?.width || 0) * (best?.height || 0);

      if (!best || size > bestSize || (size === bestSize && size > 0)) {
        best = img;
      }
    }

    if (best) {
      console.log(
        `[fpdl] Picked photo resolution: ${best.width}x${best.height} from ${best.uri.substring(0, 50)}...`,
      );
      const url = best.uri;
      let ext = "jpg";
      if (url.includes(".webp") || url.includes("format=webp")) ext = "webp";
      else if (url.includes(".png") || url.includes("format=png")) ext = "png";
      return { url, ext };
    }

    // Instagram fallback
    if (m.display_url) {
      const url = m.display_url;
      let ext = "jpg";
      if (url.includes(".png") || url.includes("format=png")) ext = "png";
      return { url, ext };
    }

    if (
      m.image_versions2?.candidates &&
      Array.isArray(m.image_versions2.candidates)
    ) {
      const best = m.image_versions2.candidates.sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0];
      return { url: best.url, ext: "jpg" };
    }
  }

  // 3. Generic fallback - last resort
  if (m.url && isDirectMediaUrl(m.url)) {
    const isVideo =
      m.url.includes(".mp4") ||
      m.url.includes("fbcdn.net/v/t67") ||
      m.__typename === "Video";
    return {
      url: m.url,
      ext: isVideo ? "mp4" : "jpg",
    };
  }

  // Fallback for any media that has an image property (common in older FB structures)
  if (media.image?.uri && isDirectMediaUrl(media.image.uri)) {
    return { url: media.image.uri, ext: "jpg" };
  }

  return undefined;
}

/**
 * Get the number of attachments in a story.
 * @param {Story} story
 * @returns {number}
 */
export function getAttachmentCount(story) {
  if (isStoryPost(story)) {
    const attachment = story.attachments[0]?.styles.attachment;
    if (!attachment) return 0;
    if ("all_subattachments" in attachment)
      return attachment.all_subattachments.count;
    // Check for shorts video (fb_shorts_story with attachments)
    const shortsAttachments = /** @type {any} */ (attachment).style_infos?.[0]
      ?.fb_shorts_story?.attachments;
    if (Array.isArray(shortsAttachments) && shortsAttachments.length > 0)
      return shortsAttachments.length;
    if ("media" in attachment && attachment.media) return 1;
    return 0;
  }
  return 0;
}

/**
 * Get the total number of files to download for a story.
 * This includes attachments + index.md + attached_story attachments (if any).
 * @param {Story} story
 * @returns {number}
 */
export function getDownloadCount(story) {
  let count = getAttachmentCount(story);
  if (isStoryPost(story) && story.attached_story) {
    count += getAttachmentCount(story.attached_story);
  }
  return count;
}

/**
 * Check if an object is a valid MediaId.
 * @param {unknown} obj
 * @returns {obj is MediaId}
 */
function isMediaId(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.__typename !== "Video" && o.__typename !== "Photo") return false;
  if (typeof o.id !== "string" || !o.id) return false;
  return true;
}

/**
 * Fetch navigation info for a media node.
 * @param {MediaId} currentId
 * @param {string} mediasetToken
 * @returns {Promise<{ currMedia: Media | undefined, nextId: MediaId | undefined }>}
 */
async function fetchMediaNav(currentId, mediasetToken) {
  const apiName =
    currentId.__typename === "Video" ? VIDEO_ROOT_QUERY : PHOTO_ROOT_QUERY;
  const objs = await sendGraphqlRequest({
    apiName,
    variables: {
      nodeID: currentId.id,
      mediasetToken,
    },
  });

  /** @type {Media | undefined} */
  let currMedia;
  /** @type {MediaId | undefined} */
  let nextId;

  for (const obj of objs) {
    /** @type {any} */
    const data = obj.data;
    if (isMediaId(data?.nextMediaAfterNodeId)) {
      nextId = data.nextMediaAfterNodeId;
    }
    if (data?.currMedia) {
      currMedia = data.currMedia;
    }
    if (data?.mediaset?.currMedia?.edges?.[0]?.node) {
      currMedia = data.mediaset.currMedia.edges[0].node;
    }
  }

  return { currMedia, nextId };
}

/**
 * Fetch attachments for a story as an async generator.
 * @param {Story} story
 * @yields {Media}
 */
async function* fetchAttachments(story) {
  if (isStoryPost(story)) {
    const totalCount = getAttachmentCount(story);
    let downloadedCount = 0;
    /** @type {any} */
    let firstMedia = null;

    const attachment = story.attachments[0]?.styles?.attachment;
    if (attachment && "all_subattachments" in attachment) {
      firstMedia = attachment.all_subattachments.nodes[0]?.media;
    } else if (attachment && "media" in attachment && attachment.media) {
      firstMedia = attachment.media;
    } else if (story.attachments[0]?.media) {
      firstMedia = story.attachments[0].media;
    } else {
      const shortsAttachments = /** @type {any} */ (attachment)
        ?.style_infos?.[0]?.fb_shorts_story?.attachments;
      if (Array.isArray(shortsAttachments) && shortsAttachments.length > 0) {
        firstMedia = shortsAttachments[0]?.media;
      }
    }

    // If it's a regular post, we should try to "upgrade" to the viewer version to get max quality.
    if (firstMedia && isStoryPost(story)) {
      // For single photo posts, the pcb.POST_ID mediasetToken might not work.
      // We try with the photo/video ID directly first, then fallback to pcb.
      const mediasetToken = totalCount > 1 ? `pcb.${story.post_id}` : "";
      let currentId = firstMedia;

      while (currentId && downloadedCount < totalCount) {
        try {
          const nav = await fetchMediaNav(currentId, mediasetToken);
          if (!nav.currMedia) {
            // If it's a single photo and Nav failed with empty token, try with pcb token as last resort
            if (totalCount === 1 && mediasetToken === "") {
              const retryNav = await fetchMediaNav(
                currentId,
                `pcb.${story.post_id}`,
              );
              if (retryNav.currMedia) {
                yield retryNav.currMedia;
                downloadedCount++;
                break;
              }
            }
            break;
          }

          yield nav.currMedia;
          downloadedCount++;
          currentId = nav.nextId;
        } catch (err) {
          console.warn(
            "[fpdl] Nav fetch failed, falling back to story attachments",
            err,
          );
          break;
        }
      }
    }

    // Fallback: Yield original items if Nav didn't finish or wasn't applicable
    if (downloadedCount < totalCount) {
      if (attachment && "all_subattachments" in attachment) {
        for (const node of attachment.all_subattachments.nodes) {
          if (node?.media && downloadedCount < totalCount) {
            // Skip if we already yielded via Nav?
            // For simplicity, we only fall back if we've downloaded 0 so far.
            if (downloadedCount === 0) yield node.media;
          }
        }
      } else if (firstMedia && downloadedCount === 0) {
        yield firstMedia;
      } else if (story.attachments && downloadedCount === 0) {
        for (const att of story.attachments) {
          if (att.media) yield att.media;
        }
      }
    }
  }

  return;
}

/**
 * Extract stories embedded in the initial HTML page load.
 * These are delivered via <script type="application/json"> tags or window variables.
 * @returns {Story[]}
 */
function extractEmbeddedStories() {
  const stories = [];

  const scripts = document.querySelectorAll('script[type="application/json"]');
  for (const script of scripts) {
    const content = script.textContent;
    if (!content) continue;

    try {
      const data = JSON.parse(content);
      extractStories(data, stories);
      extractStoryCreateTime(data);
      extractStoryGroupMap(data);
      extractVideoUrls(data);
    } catch {}
  }

  if (window.location.hostname.includes("facebook.com")) {
    try {
      // @ts-ignore
      if (window._sharedData) extractStories(window._sharedData, stories);
      // @ts-ignore
      if (window.__additionalData) extractStories(window.__additionalData, stories);
      // @ts-ignore
      if (window.__player_data) extractStories(window.__player_data, stories);
    } catch {}
  }

  for (const s of stories) {
    const postId = getStoryPostId(s);
    if (postId && !s.placeholder) {
      globalStoriesCache.set(postId, s);
    }
  }

  return stories;
}

const TARGET_API_NAMES = new Set([
  "CometGroupDiscussionRootSuccessQuery",
  "CometModernHomeFeedQuery",
  "CometNewsFeedPaginationQuery",
  "CometVideoHomeFeedRootQuery",
  "CometVideoHomeFeedSectionPaginationQuery",
  "GroupsCometCrossGroupFeedContainerQuery",
  "GroupsCometCrossGroupFeedPaginationQuery",
  "GroupsCometFeedRegularStoriesPaginationQuery",
  "ProfileCometContextualProfileGroupPostsFeedPaginationQuery",
  "ProfileCometContextualProfileRootQuery",
  "ProfileCometTimelineFeedQuery",
  "ProfileCometTimelineFeedRefetchQuery",
  "SearchCometResultsInitialResultsQuery",
  "SearchCometResultsPaginatedResultsQuery",
  "CometVideoRootMediaViewerQuery",
  "CometPhotoRootContentQuery",
  "StoriesViewerBucketPrefetcherMultiBucketsQuery",
]);

/**
 * @param {(story: Story) => void} cb
 * @returns {() => void}
 */
export function storyListener(cb) {
  const emittedStoryIds = new Set();

  let elapsed = 0;
  const pollInterval = 1000;
  const maxDuration = 30000;

  const intervalId = setInterval(() => {
    elapsed += pollInterval;

    const embeddedStories = extractEmbeddedStories();
    for (const story of embeddedStories) {
      const storyId = getStoryId(story);
      if (emittedStoryIds.has(storyId)) continue;
      emittedStoryIds.add(storyId);
      try {
        cb(story);
      } catch {}
    }

    if (elapsed >= maxDuration) {
      clearInterval(intervalId);
    }
  }, pollInterval);

  const interceptNavigation = () => {
    if (/** @type {any} */ (window)._fpdl_intercepted) return;
    /** @type {any} */ (window)._fpdl_intercepted = true;

    const _push = history.pushState;
    const _replace = history.replaceState;

    history.pushState = function () {
      const res = _push.apply(this, arguments);
      window.dispatchEvent(new CustomEvent("fpdl_urlchange"));
      return res;
    };

    history.replaceState = function () {
      const res = _replace.apply(this, arguments);
      window.dispatchEvent(new CustomEvent("fpdl_urlchange"));
      return res;
    };

    window.addEventListener("popstate", () => {
      window.dispatchEvent(new CustomEvent("fpdl_urlchange"));
    });
  };
  interceptNavigation();

  const handleUrlChange = async () => {
    const url = window.location.href;
    if (url.includes("facebook.com/posts/")) {
      const match = url.match(/facebook\.com\/posts\/(\d+)/);
      if (match) {
        const postId = match[1];
        try {
          const results = await sendGraphqlRequest({
            apiName: "CometModernHomeFeedQuery",
            variables: { postID: postId },
          });
          const stories = extractStories(results);
          for (const story of stories) {
            const storyId = getStoryId(story);
            if (emittedStoryIds.has(storyId)) continue;
            emittedStoryIds.add(storyId);
            cb(story);
          }
        } catch (err) {}
      }
    }
  };

  window.addEventListener("fpdl_urlchange", handleUrlChange);

  const urlPollId = setInterval(handleUrlChange, 2000);

  const unlistenGraphql = graphqlListener((ev) => {
    const isInstagram = ev.url.includes("instagram.com");

    const apiName =
      ev.requestHeaders["x-fb-friendly-name"] ||
      ev.requestPayload["fb_api_req_friendly_name"];

    let isTarget = false;
    if (isInstagram) {
      isTarget = true;
    } else if (apiName) {
      isTarget =
        TARGET_API_NAMES.has(apiName) ||
        apiName.includes("Video") ||
        apiName.includes("Reel") ||
        apiName.includes("Clip");
    }

    if (!isTarget) return;

    const stories = extractStories(ev.responseBody);
    extractStoryCreateTime(ev.responseBody);
    extractStoryGroupMap(ev.responseBody);
    extractVideoUrls(ev.responseBody);

    for (const story of stories) {
      const storyId = getStoryId(story);
      const postId = getStoryPostId(story);
      if (postId && !story.placeholder) {
        globalStoriesCache.set(postId, story);
      }

      if (emittedStoryIds.has(storyId)) continue;
      emittedStoryIds.add(storyId);
      try {
        cb(story);
      } catch {}
    }
  });

  return () => {
    clearInterval(intervalId);
    clearInterval(urlPollId);
    unlistenGraphql();
  };
}

/**
 * Check if an object is a valid StoryPost.
 * @param {unknown} obj
 * @returns {obj is StoryPost}
 */
export function isStoryPost(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  if (typeof o.id !== "string" || !o.id) return false;
  if (typeof o.post_id !== "string" || !o.post_id) return false;
  if (typeof o.wwwURL !== "string" || !o.wwwURL) return false;

  if (!Array.isArray(o.attachments)) return false;

  return true;
}

/**
 * Check if an object is a valid StoryVideo (Feed video or Reel/Video node).
 * @param {unknown} obj
 * @returns {obj is StoryVideo}
 */
function isStoryVideo(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  if (Array.isArray(o.attachments) && o.attachments.length > 0) {
    const attachment = /** @type {Record<string, unknown>} */ (
      o.attachments[0]
    );
    if (
      typeof attachment?.url === "string" &&
      attachment.media &&
      typeof attachment.media === "object"
    ) {
      const media = /** @type {Record<string, unknown>} */ (attachment.media);
      return (
        media.__typename === "Video" && typeof media.publish_time === "number"
      );
    }
  }

  if (o.__typename === "Video" && typeof o.id === "string") {
    if (/** @type {any} */ (o).placeholder) return true;
    if (typeof o.playable_url === "string") return true;
    if (o.video_grid_renderer || o.videoDeliveryResponseFragment) return true;
  }

  return false;
}

/**
 * Check if an object is a valid StoryWatch.
 * @param {unknown} obj
 * @returns {obj is StoryWatch}
 */
function isStoryWatch(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  if (!Array.isArray(o.attachments)) return false;
  if (o.attachments.length === 0) return false;

  const attachment = /** @type {Record<string, unknown>} */ (o.attachments[0]);
  if (!attachment.media || typeof attachment.media !== "object") return false;

  const media = /** @type {Record<string, unknown>} */ (attachment.media);
  if (media.__typename !== "Video") return false;

  if (!media.creation_story || typeof media.creation_story !== "object")
    return false;
  const creationStory = /** @type {Record<string, unknown>} */ (
    media.creation_story
  );
  if (
    !creationStory.comet_sections ||
    typeof creationStory.comet_sections !== "object"
  )
    return false;

  return true;
}

/**
 * Check if an object is a valid StoryReel.
 * @param {unknown} obj
 * @returns {obj is StoryWatch}
 */
export function isStoryReel(obj) {
  return isFacebookReel(obj);
}

/**
 * Check if an object is a valid Unified Story (Facebook Stories).
 * @param {unknown} obj
 * @returns {obj is Story}
 */
function isUnifiedStory(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  // Recognition for Unified Story placeholders
  if (
    o.placeholder === true &&
    (o.__typename === "Story" ||
      o.__typename === "UnifiedStory" ||
      !o.__typename)
  ) {
    return true;
  }

  return (
    (o.__typename === "Story" || o.__typename === "UnifiedStory") &&
    typeof o.id === "string" &&
    Array.isArray(o.attachments)
  );
}

/**
 * Check if an object is a valid Story (StoryPost, StoryVideo, or StoryWatch).
 * @param {unknown} obj
 * @returns {obj is Story}
 */
function isStory(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (/** @type {any} */ (obj).placeholder === true) return true;
  return (
    isUnifiedStory(obj) ||
    isStoryPost(obj) ||
    isStoryVideo(obj) ||
    isStoryWatch(obj)
  );
}

/**
 * Recursively extract stories from deeply nested objects.
 * Stories are identified by having id, post_id, and attachments array.
 * @param {unknown} obj
 * @param {Story[]} [results] - Array to collect stories
 * @returns {Story[]}
 */
export function extractStories(obj, results = []) {
  if (!obj || typeof obj !== "object") return results;

  const o = /** @type {Record<string, unknown>} */ (obj);

  if (o.unified_stories && typeof o.unified_stories === "object") {
    const unified = /** @type {any} */ (o.unified_stories);
    if (Array.isArray(unified.edges)) {
      for (const edge of unified.edges) {
        if (edge?.node) {
          extractStories(edge.node, results);
        }
      }
    }
  }

  const objIsStory = isStory(obj);
  if (objIsStory) {
    const id = getStoryId(obj);
    if (id) {
      const exists = results.some((s) => getStoryId(s) === id);
      if (!exists) {
        results.push(obj);
      }

      const postId = getStoryPostId(obj);
      if (postId && !(/** @type {any} */ (obj).placeholder)) {
        globalStoriesCache.set(postId, obj);
      }
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStories(item, results);
    }
  } else {
    const keys = Object.keys(o);
    for (const key of keys) {
      if (objIsStory && key === "attached_story") continue;
      extractStories(o[key], results);
    }
  }

  return results;
}

/**
 * Recursively extract metadata (creation_time, url) from deeply nested objects
 * and populate storyCreateTimeCache directly.
 * @param {unknown} obj
 */
export function extractStoryCreateTime(obj) {
  if (!obj || typeof obj !== "object") return;

  const o = /** @type {Record<string, unknown>} */ (obj);

  if (
    typeof o.creation_time === "number" &&
    typeof o.id === "string" &&
    typeof o.url === "string"
  ) {
    storyCreateTimeCache.set(o.id, o.creation_time);
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStoryCreateTime(item);
    }
  } else {
    for (const key of Object.keys(o)) {
      extractStoryCreateTime(o[key]);
    }
  }
}

/**
 * Recursively extract group info from deeply nested objects
 * and populate storyGroupCache directly.
 * @param {unknown} obj
 */
export function extractStoryGroupMap(obj) {
  if (!obj || typeof obj !== "object") return;

  const o = /** @type {Record<string, unknown>} */ (obj);

  if (typeof o.id === "string" && o.to && typeof o.to === "object") {
    const to = /** @type {Record<string, unknown>} */ (o.to);
    if (
      to.__typename === "Group" &&
      typeof to.id === "string" &&
      typeof to.name === "string"
    ) {
      if (!storyGroupCache.has(o.id)) {
        storyGroupCache.set(o.id, /** @type {Group} */ (to));
      }
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStoryGroupMap(item);
    }
  } else {
    for (const key of Object.keys(o)) {
      extractStoryGroupMap(o[key]);
    }
  }
}

/**
 * Extract video URLs from all_video_dash_prefetch_representations in extensions field
 * and populate videoUrlCache directly.
 * @param {unknown} obj
 */
export function extractVideoUrls(obj) {
  if (!obj || typeof obj !== "object") return;

  const o = /** @type {Record<string, unknown>} */ (obj);

  if (Array.isArray(o.all_video_dash_prefetch_representations)) {
    for (const prefetch of o.all_video_dash_prefetch_representations) {
      if (!prefetch || typeof prefetch !== "object") continue;
      const p = /** @type {Record<string, unknown>} */ (prefetch);
      const videoId = p.video_id;
      if (typeof videoId !== "string") continue;
      if (videoUrlCache.has(videoId)) continue;

      const representations = p.representations;
      if (!Array.isArray(representations)) continue;

      /** @type {{ base_url: string, bandwidth: number } | null} */
      let best = null;
      for (const rep of representations) {
        if (!rep || typeof rep !== "object") continue;
        const r = /** @type {Record<string, unknown>} */ (rep);
        const baseUrl = r.base_url;
        const bandwidth = r.bandwidth;
        const mimeType = r.mime_type;

        if (typeof mimeType === "string" && mimeType.startsWith("audio/"))
          continue;

        if (typeof baseUrl === "string" && typeof bandwidth === "number") {
          if (!best || bandwidth > best.bandwidth) {
            best = { base_url: baseUrl, bandwidth };
          }
        }
      }

      if (best) {
        videoUrlCache.set(videoId, best.base_url);
      }
    }
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractVideoUrls(item);
    }
  } else {
    for (const key of Object.keys(o)) {
      extractVideoUrls(o[key]);
    }
  }
}

/**
 * Get the creation time for a story.
 * @param {Story} story
 * @returns {Date | undefined}
 */
export function getCreateTime(story) {
  if (isUnifiedStory(story)) {
    if (typeof story.publish_time === "number") {
      return new Date(story.publish_time * 1000);
    }
    return undefined;
  }

  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      if (typeof story.publish_time === "number") {
        return new Date(story.publish_time * 1000);
      }
      return undefined;
    }
    const publishTime = story.attachments[0].media.publish_time;
    return new Date(publishTime * 1000);
  }

  if (isStoryPost(story) || isStoryWatch(story)) {
    const createTime = storyCreateTimeCache.get(getStoryId(story));
    if (createTime === undefined) return undefined;
    return new Date(createTime * 1000);
  }

  return undefined;
}

/**
 * Get the group for a story.
 * @param {Story} story
 * @returns {Group | undefined}
 */
export function getGroup(story) {
  return storyGroupCache.get(getStoryId(story));
}

/**
 * Get the URL for a story.
 * @param {Story} story
 * @returns {string}
 */
export function getStoryUrl(story) {
  if (isUnifiedStory(story)) {
    const match = window.location.href.match(/facebook\.com\/stories\/(\d+)/);
    const bucketID = match ? match[1] : "";
    return `https://www.facebook.com/stories/${bucketID}/${story.id}/`;
  }
  if (isStoryPost(story)) {
    return story.wwwURL;
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return `https://www.facebook.com/watch/?v=${story.id}`;
    }
    return `https://www.facebook.com/watch/?v=${story.attachments[0].media.id}`;
  }
  if (isStoryWatch(story)) {
    return `https://www.facebook.com/watch/?v=${story.attachments[0].media.id}`;
  }
  return "";
}

/**
 * Get the message text for a story.
 * @param {Story} story
 * @returns {string | undefined}
 */
export function getStoryMessage(story) {
  if (isUnifiedStory(story)) {
    return story.message?.text;
  }
  if (isStoryPost(story)) {
    return story.message?.text;
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.message?.text || story.name || story.title?.text;
    }
    return story.message?.text;
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.creation_story.comet_sections.message
      ?.story?.message?.text;
  }
  return undefined;
}

/**
 * Get the post_id for a story.
 * @param {Story} story
 * @returns {string}
 */
export function getStoryPostId(story) {
  if (!story || typeof story !== "object") return "";
  const s = /** @type {any} */ (story);

  if (s.placeholder === true && s.id) {
    return String(s.id);
  }

  if (isUnifiedStory(story)) {
    return story.id;
  }
  if (isStoryPost(story)) {
    return story.post_id;
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.id;
    }
    return story.post_id;
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.id;
  }
  throw new Error("Unknown story type: cannot get post_id");
}

/**
 * Get the id for a story.
 * @param {Story} story
 * @returns {string}
 */
export function getStoryId(story) {
  if (!story || typeof story !== "object") return "";
  const s = /** @type {any} */ (story);

  if (s.placeholder === true && s.id) {
    return String(s.id);
  }

  if (isUnifiedStory(story)) {
    return story.id;
  }
  if (isStoryPost(story)) {
    return story.id;
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.id;
    }
    return story.id;
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.creation_story.id;
  }
  throw new Error("Unknown story type: cannot get id");
}

/**
 * Get the primary actor for a story.
 * @param {Story} story
 * @returns {User | undefined}
 */
export function getStoryActor(story) {
  if (isUnifiedStory(story)) {
    return story.owner;
  }
  if (isStoryPost(story)) {
    return story.actors?.[0];
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.owner;
    }
    return story.actors?.[0];
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.owner;
  }
  return undefined;
}

/**
 * Get the media title for a story (video name/title).
 * @param {Story} story
 * @returns {string | undefined}
 */
export function getStoryMediaTitle(story) {
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.name || story.title?.text;
    }
    return story.attachments[0].media.name;
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.title?.text;
  }
  return undefined;
}

/**
 * Sanitize a string for use in a filename.
 * @param {string} str
 * @returns {string}
 */
function sanitizeFilename(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/[<>":\\|?*]/g, "_")
    .trim();
}

/**
 * Build the folder name for a story download.
 * Format: {date:YYYY-MM-DD}_{groupName}_{actorName}_{post_id}
 * @param {Story} story
 * @returns {string}
 */
function buildFolderName(story) {
  const parts = [];

  const createTime = getCreateTime(story);
  if (createTime) {
    const year = createTime.getFullYear();
    const month = String(createTime.getMonth() + 1).padStart(2, "0");
    const day = String(createTime.getDate()).padStart(2, "0");
    parts.push(`${year}-${month}-${day}`);
  }

  const group = getGroup(story);
  const sanitizedGroup = group ? sanitizeFilename(group.name) : "";
  if (sanitizedGroup) {
    parts.push(sanitizedGroup);
  }

  const actor = getStoryActor(story);
  const sanitizedActor = actor ? sanitizeFilename(actor.name) : "";
  if (sanitizedActor) {
    parts.push(sanitizedActor);
  }

  const postId = getStoryPostId(story);
  if (postId) {
    parts.push(sanitizeFilename(postId));
  }

  return parts.filter(Boolean).join("_");
}

/**
 * Render a story to markdown content.
 * @param {Story} story
 * @param {Array<{ media: Media, filename: string }>} attachments
 * @param {string} [quoted_story] - Pre-rendered quoted story content
 * @returns {string}
 */
function renderStory(story, attachments, quoted_story) {
  const lines = [];

  lines.push(`**URL:** ${getStoryUrl(story)}`);
  lines.push("");

  const group = getGroup(story);
  if (group) {
    lines.push(`**Group:** ${group.name}`);
    lines.push("");
  }

  const actor = getStoryActor(story);
  if (actor) {
    lines.push(`**Author:** ${actor.name}`);
    lines.push("");
  }

  const createTime = getCreateTime(story);
  if (createTime) {
    lines.push(`**Date:** ${createTime.toISOString()}`);
    lines.push("");
  }

  const mediaTitle = getStoryMediaTitle(story);
  if (mediaTitle) {
    lines.push("---");
    lines.push("");
    lines.push(`**${mediaTitle}**`);
    lines.push("");
  }

  const message = getStoryMessage(story);
  if (message) {
    lines.push("---");
    lines.push("");
    lines.push(message);
    lines.push("");
  }

  if (attachments.length > 0) {
    lines.push("---");
    lines.push("");
    for (const { media, filename } of attachments) {
      const basename = filename.split("/").pop() || filename;
      if (media.__typename === "Video") {
        lines.push(`- [${basename}](./${basename})`);
      } else {
        lines.push(`![${basename}](./${basename})`);
      }
    }
    lines.push("");
  }

  if (quoted_story) {
    lines.push("---");
    lines.push("");
    const quotedLines = quoted_story.split("\n").map((line) => `> ${line}`);
    lines.push(...quotedLines);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Fetch story files for download.
 * @param {Story} story
 * @yields {StoryFile}
 */
export async function* fetchStoryFiles(story) {
  const folder = buildFolderName(story);
  const storyId = getStoryId(story);

  let mediaIndex = 0;

  for await (const media of fetchAttachments(story)) {
    const download = getDownloadUrl(media);
    if (!download) continue;

    mediaIndex++;
    const indexPrefix = String(mediaIndex).padStart(4, "0");
    const filename = `${folder}/${indexPrefix}_${media.id}.${download.ext}`;
    yield { storyId, url: download.url, filename };
  }

  if (isStoryPost(story) && story.attached_story) {
    for await (const media of fetchAttachments(story.attached_story)) {
      const download = getDownloadUrl(media);
      if (!download) continue;

      mediaIndex++;
      const indexPrefix = String(mediaIndex).padStart(4, "0");
      const filename = `${folder}/${indexPrefix}_${media.id}.${download.ext}`;
      yield { storyId, url: download.url, filename };
    }
  }
}