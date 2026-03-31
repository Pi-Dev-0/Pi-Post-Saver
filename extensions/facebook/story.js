import { graphqlListener, sendGraphqlRequest } from "../graphql.js";
import { isFacebookReel, fetchReelData, extractReelMedia } from "./reels.js";

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
  if (/\.(jpg|jpeg|png|webp|gif|mp4|webm|m4v|mp3|wav)(\?|$)/i.test(s))
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
    o.video_versions ||
    o.progressive_urls
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
          !/\.(jpg|jpeg|png|webp|gif|jfif|bmp)(\?|$)/i.test(urlWithoutParams)
        ) {
          console.log(`[fpdl] Picked video URL: ${url.substring(0, 100)}...`);
          return { url, ext: "mp4" };
        }
      }
    }

    const list =
      media?.progressive_urls ??
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
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    // Carousel
    if (s.edge_sidecar_to_children?.edges) {
      return s.edge_sidecar_to_children.edges.length;
    }
    return 1;
  }
  if (isUnifiedStory(story)) {
    return story.attachments?.length ?? 0;
  }
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
  if (isStoryVideo(story)) {
    return 1;
  }
  if (isStoryWatch(story)) {
    return 1;
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
  const isInsta = isInstagramStory(story);

  if (isInsta) {
    const s = /** @type {any} */ (story);

    // Handle Instagram placeholder (fetch on download)
    if (s.placeholder && (s.shortcode || s.id)) {
      try {
        const storyId = s.shortcode || s.id;
        console.log(`[fpdl] Resolving Instagram placeholder ${storyId}...`);

        // Step 1: Try to find it in global cache first
        const cached = globalStoriesCache.get(storyId);
        if (cached && !(/** @type {any} */ (cached).placeholder)) {
          yield* fetchAttachments(cached);
          return;
        }



        // Step 2: Resolve via API using username/id from URL (Only if on Instagram)
        if (window.location.hostname.includes("instagram.com")) {
          const parts = window.location.pathname.split("/").filter(Boolean);
          const isStoryPath = parts[0] === "stories";
          const isPostPath =
            parts[0] === "p" || parts[0] === "reel" || parts[0] === "reels";

          if (isStoryPath) {
            const isHighlight = parts[1] === "highlights";
            const reelId = isHighlight
              ? parts[2]
              : /** @type {any} */ (s).reelId || null;
            const mediaId = storyId !== reelId ? storyId : null;

            if (reelId) {
              try {
                console.log(
                  `[fpdl] Fetching highlight/reel API for ${reelId}...`,
                );
                const storyItems = await fetchInstagramHighlightData(reelId);
                if (storyItems.length > 0) {
                  const match = mediaId
                    ? storyItems.find(
                        (item) =>
                          String(item.id).includes(String(mediaId)) ||
                          String(item.pk).includes(String(mediaId)) ||
                          (item.code && String(item.code) === String(mediaId)),
                      )
                    : storyItems[0];

                  if (match) {
                    yield match;
                    return;
                  }
                  // If no specific match found but we have items, yield the first as fallback
                  yield storyItems[0];
                  return;
                }
              } catch (err) {
                console.warn("[fpdl] Reel API resolution failed", err);
              }
            } else if (parts[1] && parts[1] !== "stories") {
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
          } else if (isPostPath) {
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

        // Step 3: Try to extract from page DOM as a fallback
        const mediaSources = [];
        const containers = document.querySelectorAll(
          "article, section, div[role='dialog'], div[role='presentation']",
        );
        for (const container of containers) {
          const videos = container.querySelectorAll("video");
          for (const video of videos) {
            let src = video.src || video.querySelector("source")?.src;
            // Try Fiber for real URL if blob
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
                  const fiberUrl =
                    props?.videoData?.$1?.playable_url_quality_hd ||
                    props?.videoData?.$1?.browser_native_hd_url ||
                    props?.videoData?.$1?.hd_src ||
                    props?.videoData?.$1?.playable_url ||
                    props?.videoData?.$1?.sd_src ||
                    props?.children?.props?.children?.props
                      ?.implementations?.[0]?.data?.hdSrc ||
                    props?.videoData?.hdSrc ||
                    props?.videoData?.sdSrc ||
                    props?.item?.video_versions?.[0]?.url ||
                    props?.video_versions?.[0]?.url;

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
              mediaSources.push({
                __typename: "Video",
                id: storyId,
                video_url: src,
              });
            }
          }

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
        if (mediaSources.length > 0) {
          for (const m of mediaSources) yield m;
          return;
        }

        // Step 4: Fallback to direct page fetch (Only if on Instagram)
        if (
          window.location.hostname.includes("instagram.com") &&
          storyId.length < 15
        ) {
          const instagramUrl = `https://www.instagram.com/p/${storyId}/`;
          const res = await fetch(instagramUrl);
          if (res.ok) {
            const html = await res.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");
            const ogVideoMeta = doc.querySelector('meta[property="og:video"]');
            const ogImageMeta = doc.querySelector('meta[property="og:image"]');
            if (ogVideoMeta?.content) {
              yield {
                __typename: "Video",
                id: storyId,
                video_url: ogVideoMeta.content,
              };
              return;
            }
            if (ogImageMeta?.content) {
              yield {
                __typename: "Photo",
                id: storyId,
                display_url: ogImageMeta.content,
              };
              return;
            }
          }
        }
      } catch (err) {
        console.warn("[fpdl] Failed to fetch instagram placeholder", err);
      }
    }

    if (s.edge_sidecar_to_children?.edges) {
      for (const edge of s.edge_sidecar_to_children.edges) {
        yield edge.node;
      }
    } else if (s.carousel_media) {
      for (const item of s.carousel_media) {
        yield item;
      }
    } else {
      yield s;
    }
    return;
  }

  // Handle Facebook Story placeholders
  const isFB =
    !isInsta &&
    (window.location.hostname.includes("facebook.com") ||
      isUnifiedStory(story) ||
      story.__typename === "Story");
  if (isFB && /** @type {any} */ (story).placeholder) {
    try {
      console.log(`[fpdl] Fetching Facebook story data for ${story.id}...`);

      // Bucket ID is the first numeric segment in /stories/{bucketID}/{storyID}
      const urlMatch = window.location.href.match(
        /facebook\.com\/stories\/([^/?#]+)(?:\/([^/?#]+))?/
      );
      const bucketID = story.bucketId || (urlMatch ? urlMatch[1] : story.id);
      
      const isReel = isFacebookReel(story) || window.location.href.includes("/reel/");
      
      let results;
      const extracted = [];

      if (isReel) {
        results = await fetchReelData(bucketID);
        if (results) extractReelMedia(results, extracted);
      } else {
        results = await sendGraphqlRequest({
          apiName: "StoriesViewerBucketPrefetcherMultiBucketsQuery",
          variables: { bucketIDs: [bucketID] },
        });
        extractStories(results, extracted);
      }

      /**
       * Multi-strategy story matching.
       * Facebook story IDs can appear in multiple formats:
       *  - Exact string      : GraphQL id === placeholder id
       *  - URL segment       : 2nd path segment of the story URL
       *  - Base64 numeric    : placeholder is base64-encoded; inner numeric matches GraphQL id
       *  - Substring         : one id is contained in the other
       */

      // Helper: extract numeric portion from a base64-encoded Facebook story ID.
      // e.g. "UzpfSVNDOjE2MzM2NjY3NjEwOTYwMzQ=" -> "163366761096034"
      const extractNumericFromBase64 = (/** @type {string} */ id) => {
        try {
          const decoded = atob(id.replace(/-/g, "+").replace(/_/g, "/"));
          const m = decoded.match(/(\d{10,})/);
          return m ? m[1] : null;
        } catch {
          return null;
        }
      };

      const placeholderId = story.id;
      let matchStory;

      // Strategy 1: Exact ID match
      matchStory = extracted.find((s) => getStoryId(s) === placeholderId);

      // Strategy 2: Match against the story-specific URL segment (the part after /stories/{bucket}/)
      if (!matchStory && urlStoryId && urlStoryId !== placeholderId) {
        matchStory = extracted.find((s) => getStoryId(s) === urlStoryId);
      }

      // Strategy 3: Decode base64 placeholder ID and match numeric portion
      if (!matchStory) {
        const numericId = extractNumericFromBase64(placeholderId);
        if (numericId) {
          matchStory = extracted.find((s) => {
            const sid = getStoryId(s);
            return (
              sid === numericId ||
              sid.includes(numericId) ||
              numericId.includes(sid)
            );
          });
        }
      }

      // Strategy 4: Also try base64-decoding the URL story segment
      if (!matchStory && urlStoryId) {
        const numericId = extractNumericFromBase64(urlStoryId);
        if (numericId) {
          matchStory = extracted.find((s) => {
            const sid = getStoryId(s);
            return (
              sid === numericId ||
              sid.includes(numericId) ||
              numericId.includes(sid)
            );
          });
        }
      }

      // Strategy 5: Substring containment (one ID contains the other)
      if (!matchStory) {
        matchStory = extracted.find((s) => {
          const sid = getStoryId(s);
          return (
            sid &&
            placeholderId &&
            (placeholderId.includes(sid) || sid.includes(placeholderId))
          );
        });
      }

      if (matchStory) {
        console.log(
          `[fpdl] Found matching Facebook story ${story.id} in bucket ${bucketID}.`,
        );
        yield* fetchAttachments(matchStory);
        return;
      }

      // Last resort: if only one story in the bucket, must be the right one
      if (extracted.length === 1) {
        console.log(
          `[fpdl] Single story in bucket ${bucketID}, yielding it.`,
        );
        yield* fetchAttachments(extracted[0]);
        return;
      }

      if (extracted.length > 0) {
        console.warn(
          `[fpdl] Story ID match failed for "${story.id}" in bucket ${bucketID} (${extracted.length} stories). Yielding first as fallback.`,
        );
        console.log(`[fpdl] Available IDs: ${extracted.map(getStoryId).join(", ")}`);
        yield* fetchAttachments(extracted[0]);
        return;
      }
    } catch (err) {
      console.warn(
        "[fpdl] Failed to fetch Facebook story placeholder data",
        err,
      );
    }
    return;
  }

  // Handle placeholder stories (Reels where we rely on "fetch on download")
  if (/** @type {any} */ (story).placeholder) {
    try {
      const results = await sendGraphqlRequest({
        apiName: VIDEO_ROOT_QUERY,
        variables: { videoID: story.id },
      });

      const extracted = [];
      extractStories(results, extracted);

      const match = extracted.find((s) => s.id === story.id);

      if (match && match.__typename === "Video") {
        yield /** @type {MediaVideo} */ (match);
        return;
      }

      if (extracted.length > 0) {
        const firstVideo = extracted.find((s) => s.__typename === "Video");
        if (firstVideo) {
          yield /** @type {MediaVideo} */ (firstVideo);
          return;
        }
      }
    } catch (err) {
      console.warn("[fpdl] Failed to fetch placeholder story data", err);
    }
    return;
  }

  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      yield story;
      return;
    }
  }

  if (!story.attachments || story.attachments.length === 0) return;

  if (isStoryPost(story) || isUnifiedStory(story)) {
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

  if (isStoryWatch(story)) {
    const videoId = story.attachments[0].media.id;
    const videoUrl = videoUrlCache.get(videoId);
    if (videoUrl) {
      /** @type {MediaWatch} */
      const media = {
        __typename: "Video",
        id: videoId,
        url: videoUrl,
      };
      yield media;
    }
  }
}

/**
 * Fetch Instagram story data for a specific user ID.
 * @param {string} userId
 * @returns {Promise<any[]>}
 */
async function fetchInstagramStoryData(userId) {
  const url = `https://i.instagram.com/api/v1/feed/user/${userId}/story/`;
  const res = await fetch(url, {
    headers: {
      "x-ig-app-id": "936619743392459",
      "x-requested-with": "XMLHttpRequest",
    },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Instagram API failed: ${res.status}`);
  const data = await res.json();

  const results = [];
  if (data.reel && Array.isArray(data.reel.items)) {
    for (const item of data.reel.items) {
      const media = {
        __typename: item.video_versions ? "Video" : "Photo",
        id: item.id || item.pk,
        pk: item.pk,
        code: item.code,
        shortcode: item.code,
        video_url: item.video_versions?.[0]?.url,
        display_url:
          item.image_versions2?.candidates?.[0]?.url || item.display_url,
        taken_at_timestamp: item.taken_at,
        owner: {
          id: data.reel?.user?.pk || item.user?.pk,
          username: data.reel?.user?.username || item.user?.username,
          full_name: data.reel?.user?.full_name || item.user?.full_name,
        },
      };
      results.push(media);
    }
  }
  return results;
}

/**
 * Fetch Instagram highlight data for a specific highlight ID.
 * @param {string} highlightId
 * @returns {Promise<any[]>}
 */
async function fetchInstagramHighlightData(highlightId) {
  // Format could be 'highlight:ID' or just 'ID'
  const id = highlightId.includes(":")
    ? highlightId
    : `highlight:${highlightId}`;
  const url = `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${id}`;

  const res = await fetch(url, {
    headers: {
      "x-ig-app-id": "936619743392459",
      "x-requested-with": "XMLHttpRequest",
    },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Instagram Highlight API failed: ${res.status}`);
  const data = await res.json();

  const results = [];
  const reel = data.reels?.[id] || Object.values(data.reels || {})[0];

  if (reel && Array.isArray(reel.items)) {
    for (const item of reel.items) {
      const media = {
        __typename: item.video_versions ? "Video" : "Photo",
        id: item.id || item.pk,
        pk: item.pk,
        code: item.code,
        shortcode: item.code,
        video_url: item.video_versions?.[0]?.url,
        display_url:
          item.image_versions2?.candidates?.[0]?.url || item.display_url,
        taken_at_timestamp: item.taken_at,
        owner: {
          id: reel.user?.pk || item.user?.pk,
          username: reel.user?.username || item.user?.username,
          full_name: reel.user?.full_name || item.user?.full_name,
        },
      };
      results.push(media);
    }
  }
  return results;
}

/**
 * Fetch Instagram media info for a specific shortcode.
 * @param {string} shortcode
 * @returns {Promise<any | undefined>}
 */
async function fetchInstagramMediaInfo(shortcode) {
  // Convert shortcode to numeric ID for the API
  const mediaId = instagramShortcodeToId(shortcode);
  const url = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;

  const res = await fetch(url, {
    headers: {
      "x-ig-app-id": "936619743392459",
      "x-requested-with": "XMLHttpRequest",
    },
    credentials: "include",
  });
  if (!res.ok) {
    // If numeric ID failed, try with shortcode directly or old __a=1
    const altUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;
    const altRes = await fetch(altUrl);
    if (!altRes.ok) return undefined;
    const data = await altRes.json();
    const item = data.items?.[0] || data.graphql?.shortcode_media;
    if (!item) return undefined;
    return {
      __typename: item.video_versions || item.is_video ? "Video" : "Photo",
      id: item.id || item.pk,
      video_url: item.video_versions?.[0]?.url || item.video_url,
      display_url:
        item.image_versions2?.candidates?.[0]?.url || item.display_url,
      owner: item.owner || item.user,
    };
  }

  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return undefined;

  return {
    __typename: item.video_versions ? "Video" : "Photo",
    id: item.id || item.pk,
    video_url: item.video_versions?.[0]?.url,
    display_url: item.image_versions2?.candidates?.[0]?.url || item.display_url,
    taken_at_timestamp: item.taken_at,
    owner: {
      id: item.user.pk,
      username: item.user.username,
      full_name: item.user.full_name,
    },
  };
}

/**
 * Convert an Instagram shortcode to a numeric media ID.
 * @param {string} shortcode
 * @returns {string}
 */
function instagramShortcodeToId(shortcode) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = BigInt(0);
  for (let i = 0; i < shortcode.length; i++) {
    const char = shortcode[i];
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    id = id * BigInt(64) + BigInt(index);
  }
  return id.toString();
}

/**
 * Resolve an Instagram username to a User ID.
 * @param {string} username
 * @returns {Promise<string>}
 */
async function resolveInstagramUserId(username) {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
  const res = await fetch(url, {
    headers: {
      "x-ig-app-id": "936619743392459",
      "x-requested-with": "XMLHttpRequest",
    },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Instagram Profile API failed: ${res.status}`);
  const json = await res.json();
  const id = json.data?.user?.id;
  if (!id) throw new Error("Could not find user ID");
  return id;
}

/**
 * Sanitize a string for use in a filename.
 * @param {string} str
 * @returns {string}
 */
function sanitizeFilename(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/[<>:"/\\|?*]/g, "_")
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

/**
 * Get the creation time for a story.
 * @param {Story} story
 * @returns {Date | undefined}
 */
export function getCreateTime(story) {
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    if (typeof s.taken_at_timestamp === "number") {
      return new Date(s.taken_at_timestamp * 1000);
    }
    return undefined;
  }

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
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    if (s.reelId) {
      return `https://www.instagram.com/stories/highlights/${s.reelId}/`;
    }
    if (window.location.href.includes("/stories/")) {
      const parts = window.location.pathname.split("/").filter(Boolean);
      return `https://www.instagram.com/stories/${parts[1]}/${s.shortcode || s.id}/`;
    }
    return `https://www.instagram.com/reels/${s.shortcode || s.id}/`;
  }
  if (isUnifiedStory(story)) {
    const match = window.location.href.match(/facebook\.com\/stories\/([^/?]+)/);
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
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    return s.edge_media_to_caption?.edges?.[0]?.node?.text;
  }
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

  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    return s.shortcode || s.code || s.pk || s.id;
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

  if (isInstagramStory(story)) {
    return s.id || s.pk || s.shortcode || s.code;
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
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    if (s.owner) {
      return {
        id: s.owner.id,
        name: s.owner.full_name || s.owner.username,
        username: s.owner.username,
      };
    }
    return undefined;
  }
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
 * Check if an object is an Instagram media item.
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isInstagramStory(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  if (o.__typename === "InstagramStory") return true;

  if (o.placeholder === true) {
    return window.location.hostname.includes("instagram.com");
  }

  const typenames = new Set([
    "XDTGraphVideo",
    "XDTGraphImage",
    "XDTGraphSidecar",
    "GraphVideo",
    "GraphImage",
    "GraphSidecar",
    "XDTGraphMedia",
    "GraphMedia",
    "StoryVideo",
    "StoryImage",
  ]);

  if (typenames.has(String(o.__typename))) {
    return !!(o.shortcode || o.id || o.code);
  }

  if (
    (o.code ||
      o.shortcode ||
      o.pk ||
      (typeof o.id === "string" && o.id.includes("_"))) &&
    (o.image_versions2 ||
      o.video_versions ||
      o.display_url ||
      o.carousel_media ||
      o.media_type)
  ) {
    return true;
  }

  return false;
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

  if (
    typeof o.id === "string" &&
    Array.isArray(o.attachments) &&
    (o.__typename === "Story" || 
     o.__typename === "UnifiedStory" || 
     o.__typename === "XFBStoryCard" ||
     "story_type" in o)
  ) {
    return true;
  }

  return false;
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
    isInstagramStory(obj) ||
    isStoryPost(obj) ||
    isStoryVideo(obj) ||
    isStoryWatch(obj) ||
    isUnifiedStory(obj)
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

  if (window.location.hostname.includes("instagram.com")) {
    try {
      // @ts-ignore
      if (window._sharedData) extractStories(window._sharedData, stories);
      // @ts-ignore
      if (window.__additionalData)
        extractStories(window.__additionalData, stories);
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
    if (url.includes("facebook.com/stories/")) {
      const match = url.match(/facebook\.com\/stories\/(\d+)/);
      if (match) {
        const bucketID = match[1];
        try {
          const results = await sendGraphqlRequest({
            apiName: "StoriesViewerBucketPrefetcherMultiBucketsQuery",
            variables: { bucketIDs: [bucketID] },
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
